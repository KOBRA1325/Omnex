// ── Discord bot (two-way control) ─────────────────────────────────────────────
// A minimal Discord gateway client so allow-listed users can run slash commands
// (/start /stop /restart /backup /status) against a server from its Discord channel.
// It connects over the gateway (no public endpoint needed), receives interactions,
// and answers them. All server-side effects go through callbacks supplied by main.js
// — this module knows nothing about Omnex internals, only how to talk to Discord.
//
// Security: the bot token is a secret held only in memory here + settings.json, and
// is sent only to discord.com. Commands are gated by an allowlist (deny by default)
// enforced in main.js via the `isAllowed` callback.

const https = require('https');
const fs = require('fs');
let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) { WebSocket = null; }

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]); // bad token / bad intents / etc.

// Option types: 1=SUB_COMMAND 3=STRING 6=USER 7=CHANNEL
const COMMANDS = [
  { name: 'status',  description: "Show this channel's server status", type: 1 },
  { name: 'start',   description: "Start this channel's server",   type: 1 },
  { name: 'stop',    description: "Stop this channel's server",    type: 1 },
  { name: 'restart', description: "Restart this channel's server", type: 1 },
  { name: 'backup',  description: "Back up this channel's server", type: 1 },
  { name: 'map',     description: "View this channel's server map (image for Terraria, link for Minecraft)", type: 1 },
  { name: 'commands', description: 'List every Omnex bot command', type: 1 },
  { name: 'serverid', description: '(admin) Show a server\'s ID', type: 1, options: [
      { name: 'server', description: 'Server name', type: 3, required: true, autocomplete: true } ] },
  { name: 'link', description: '(admin) Link this channel to a server — needs the admin password', type: 1, options: [
      { name: 'adminpassword', description: 'Omnex admin password', type: 3, required: true },
      { name: 'server',        description: 'Pick a server by name', type: 3, required: false, autocomplete: true },
      { name: 'serverid',      description: 'Or a server ID', type: 3, required: false },
      { name: 'channel',       description: 'Channel to link (default: here)', type: 7, required: false } ] },
  { name: 'account', description: '(admin) Manage who can run commands', type: 1, options: [
      { name: 'add', description: 'Grant command access', type: 1, options: [
          { name: 'user',  description: 'Pick a user', type: 6, required: false },
          { name: 'id',    description: 'Or a user ID', type: 3, required: false },
          { name: 'scope', description: 'Where (default: this server)', type: 3, required: false, choices: [
              { name: 'This server', value: 'server' }, { name: 'Admin (all servers)', value: 'admin' } ] } ] },
      { name: 'remove', description: 'Revoke command access', type: 1, options: [
          { name: 'user',  description: 'Pick a user', type: 6, required: false },
          { name: 'id',    description: 'Or a user ID', type: 3, required: false },
          { name: 'scope', description: 'Where (default: this server)', type: 3, required: false, choices: [
              { name: 'This server', value: 'server' }, { name: 'Admin (all servers)', value: 'admin' } ] } ] } ] },
  { name: 'admin', description: '(admin) Manage global admins (control every server)', type: 1, options: [
      { name: 'add', description: 'Grant admin — access to all servers', type: 1, options: [
          { name: 'user', description: 'Pick a user', type: 6, required: false },
          { name: 'id',   description: 'Or a user ID', type: 3, required: false } ] },
      { name: 'remove', description: 'Revoke admin', type: 1, options: [
          { name: 'user', description: 'Pick a user', type: 6, required: false },
          { name: 'id',   description: 'Or a user ID', type: 3, required: false } ] } ] },
  { name: 'create', description: '(admin) Create & install a new server', type: 1, options: [
      { name: 'game',     description: 'Game', type: 3, required: true, autocomplete: true },
      { name: 'name',     description: 'Server name', type: 3, required: true },
      { name: 'password', description: 'Server password (optional)', type: 3, required: false },
      { name: 'createkey', description: 'Omnex create password (if one is set)', type: 3, required: false } ] },
  { name: 'deleteserver', description: '(admin) Delete a server — needs the admin password', type: 1, options: [
      { name: 'server',        description: 'Server to delete', type: 3, required: true, autocomplete: true },
      { name: 'adminpassword', description: 'Omnex admin password', type: 3, required: true } ] },
];
// Read-only commands anyone in the server may run — no allowlist needed.
const PUBLIC_COMMANDS = new Set(['status', 'map', 'commands']);
// Admin-only commands (global admin list required).
const ADMIN_COMMANDS = new Set(['serverid', 'link', 'account', 'admin', 'create', 'deleteserver']);

class DiscordBot {
  // deps: { log(msg, level), onStatus(status, info),
  //         isAllowed(userId)->bool, resolveServer(channelId)->{id,name}|null|'ambiguous',
  //         runAction(serverId, action, userName)->Promise<{ok, message}> }
  constructor(deps) { this.deps = deps; this._reset(); }

  _reset() {
    this.token = null; this.appId = null; this.ws = null;
    this.seq = null; this.heartbeatTimer = null; this.acked = true;
    this.sessionId = null; this.resumeUrl = null; this.wantStop = false;
    this.guilds = new Set(); this.registered = new Set();
    this.reconnectDelay = 1000; this.status = 'offline';
  }

  isRunning() { return !!this.ws && this.status !== 'offline'; }

  start(token) {
    if (!WebSocket) { this.deps.log('WebSocket module (ws) not available', 'error'); this._setStatus('error', 'ws missing'); return; }
    if (!token || !token.trim()) { this._setStatus('offline'); return; }
    this.token = token.trim();
    this.wantStop = false;
    this.sessionId = null; this.resumeUrl = null; this.registered.clear();
    this._connect(GATEWAY);
  }

  stop() { this.wantStop = true; this._cleanup(); this._setStatus('offline'); }

  _setStatus(s, info) { this.status = s; try { this.deps.onStatus(s, info || null); } catch (e) {} }

  _cleanup() {
    clearInterval(this.heartbeatTimer); this.heartbeatTimer = null;
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) {} this.ws = null; }
  }

  _connect(url) {
    this._cleanup();
    this._setStatus('connecting');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.deps.log('Gateway connect failed: ' + e.message, 'error'); return this._scheduleReconnect(); }
    this.ws = ws;
    ws.on('message', d => this._onMessage(d));
    ws.on('close', code => this._onClose(code));
    ws.on('error', e => this.deps.log('Gateway error: ' + e.message, 'dim'));
  }

  _onClose(code) {
    this._cleanup();
    if (this.wantStop) return this._setStatus('offline');
    if (FATAL_CLOSE.has(code)) {
      this._setStatus('error', 'close ' + code);
      this.deps.log(`Gateway closed with fatal code ${code} — check the bot token${code === 4014 ? ' / privileged intents' : ''}.`, 'error');
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.wantStop) return;
    const delay = Math.min(this.reconnectDelay, 30000);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this._setStatus('reconnecting');
    setTimeout(() => {
      if (this.wantStop) return;
      const url = (this.resumeUrl && this.sessionId) ? this.resumeUrl + '/?v=10&encoding=json' : GATEWAY;
      this._connect(url);
    }, delay);
  }

  _send(op, d) { try { this.ws.send(JSON.stringify({ op, d })); } catch (e) {} }

  _onMessage(raw) {
    let p; try { p = JSON.parse(raw.toString()); } catch (e) { return; }
    if (p.s != null) this.seq = p.s;
    switch (p.op) {
      case 10: // HELLO
        this._startHeartbeat(p.d.heartbeat_interval);
        if (this.sessionId && this.resumeUrl) this._resume(); else this._identify();
        break;
      case 11: this.acked = true; break;               // heartbeat ACK
      case 1:  this._sendHeartbeat(); break;            // heartbeat requested
      case 7:  this._cleanup(); this._scheduleReconnect(); break;  // reconnect
      case 9:  this.sessionId = null; this.resumeUrl = null;       // invalid session
               setTimeout(() => this._identify(), 1500 + Math.random() * 3000); break;
      case 0:  this._onDispatch(p.t, p.d); break;       // event dispatch
    }
  }

  _startHeartbeat(interval) {
    clearInterval(this.heartbeatTimer); this.acked = true;
    setTimeout(() => this._sendHeartbeat(), interval * Math.random()); // jittered first beat
    this.heartbeatTimer = setInterval(() => {
      if (!this.acked) { this.deps.log('Heartbeat not ACKed — reconnecting', 'dim'); this._cleanup(); return this._scheduleReconnect(); }
      this._sendHeartbeat();
    }, interval);
  }
  _sendHeartbeat() { this.acked = false; this._send(1, this.seq); }

  _identify() {
    // intents = GUILDS (1<<0): enough to learn our guilds (to register commands).
    // Interactions are delivered regardless of intents; no privileged intents needed.
    this._send(2, { token: this.token, intents: 1, properties: { os: 'windows', browser: 'omnex', device: 'omnex' } });
  }
  _resume() { this._send(6, { token: this.token, session_id: this.sessionId, seq: this.seq }); }

  _onDispatch(t, d) {
    if (t === 'READY') {
      this.reconnectDelay = 1000;
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url;
      this.appId = (d.application && d.application.id) || (d.user && d.user.id) || this.appId;
      this._setStatus('online', { user: d.user && d.user.username });
      this.deps.log('Bot online as ' + (d.user ? d.user.username : '?'), 'success');
      (d.guilds || []).forEach(g => this.guilds.add(g.id));
    } else if (t === 'RESUMED') {
      this._setStatus('online'); this.reconnectDelay = 1000;
    } else if (t === 'GUILD_CREATE') {
      if (d && d.id) { this.guilds.add(d.id); this._registerCommands(d.id); }
    } else if (t === 'INTERACTION_CREATE') {
      this._onInteraction(d);
    }
  }

  async _registerCommands(guildId) {
    if (!this.appId || this.registered.has(guildId)) return;
    this.registered.add(guildId);
    try {
      await this._rest('PUT', `/applications/${this.appId}/guilds/${guildId}/commands`, COMMANDS);
      this.deps.log(`Registered ${COMMANDS.length} commands in a server.`, 'success');
    } catch (e) { this.registered.delete(guildId); this.deps.log('Slash-command register failed: ' + e.message, 'error'); }
  }

  // Read a top-level option value by name.
  _opt(d, name) { const o = (d.data.options || []).find(x => x.name === name); return o ? o.value : undefined; }
  // Find the option the user is currently typing (for autocomplete), incl. subcommands.
  _findFocused(options) {
    for (const o of options || []) {
      if (o.focused) return o;
      if (o.options) { const f = this._findFocused(o.options); if (f) return f; }
    }
    return null;
  }
  _helpText() {
    return [
      '**Omnex bot commands**',
      '',
      '__Anyone__',
      '• `/status` — is the server up? uptime + players',
      '• `/map` — the server\'s live map link (Minecraft)',
      '• `/commands` — this list',
      '',
      '__Allow-listed for the server__',
      '• `/start` · `/stop` · `/restart` · `/backup`',
      '',
      '__Admins only__',
      '• `/link server:<name> adminpassword:<pw>` — link this channel to a server',
      '• `/admin add|remove user:@who` — grant/revoke **global admin** (all servers)',
      '• `/account add|remove user:@who [scope]` — grant/revoke access (this server or admin)',
      '• `/serverid server:<name>` — show a server\'s ID',
      '• `/create game:<game> name:<name> [password]` — make a new server',
      '• `/deleteserver server:<name> adminpassword:<pw>` — delete a server',
    ].join('\n');
  }

  async _onAutocomplete(d) {
    const focused = this._findFocused(d.data.options);
    let choices = [];
    try {
      if (focused && focused.name === 'server') {
        const q = String(focused.value || '').toLowerCase();
        choices = (await this.deps.listServers())
          .filter(s => s.name.toLowerCase().includes(q))
          .slice(0, 25).map(s => ({ name: `${s.name} (${s.game})`.slice(0, 100), value: s.id }));
      } else if (focused && focused.name === 'game') {
        const q = String(focused.value || '').toLowerCase();
        choices = (await this.deps.listCreatableGames())
          .filter(g => g.toLowerCase().includes(q)).slice(0, 25).map(g => ({ name: g, value: g }));
      }
    } catch (e) {}
    return this._rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 8, data: { choices } }).catch(() => {});
  }

  async _onInteraction(d) {
    if (d.type === 4) return this._onAutocomplete(d);
    if (d.type !== 2) return; // APPLICATION_COMMAND only

    const name = d.data && d.data.name;
    const user = (d.member && d.member.user) || d.user || {};
    const userId = user.id;
    const userName = (d.member && d.member.nick) || user.global_name || user.username || 'someone';
    const channelId = d.channel_id;
    const D = this.deps;

    const reply = (content, ephemeral = true) =>
      this._rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content, flags: ephemeral ? 64 : 0 } }).catch(() => {});
    const defer = (ephemeral = true) =>
      this._rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 5, data: { flags: ephemeral ? 64 : 0 } }).catch(() => {});
    const edit = (content) =>
      this._rest('PATCH', `/webhooks/${this.appId}/${d.token}/messages/@original`, { content }).catch(() => {});

    try {
      // ── Help (public) ──
      if (name === 'commands') return reply(this._helpText(), true);

      // ── Admin-only commands ──
      if (ADMIN_COMMANDS.has(name)) {
        if (!D.isAdmin(userId)) return reply('⛔ Only Omnex **admins** can use this command.', true);
        if (name === 'serverid') {
          const ref = this._opt(d, 'server');
          const r = await D.resolveServerRef(ref);
          return reply(r ? `🆔 **${r.name}** — \`${r.id}\`` : '⚠️ Server not found.', true);
        }
        if (name === 'link') {
          const ref = this._opt(d, 'server') || this._opt(d, 'serverid');
          const ch = this._opt(d, 'channel') || channelId;
          const pw = this._opt(d, 'adminpassword') || '';
          if (!ref) return reply('⚠️ Pick a server (or give a server ID).', true);
          await defer(true);
          return edit((await D.linkChannel(ch, ref, pw)).message);
        }
        if (name === 'account') {
          const sub = (d.data.options && d.data.options[0]) || {};
          const subOpts = {}; (sub.options || []).forEach(o => subOpts[o.name] = o.value);
          const targetId = subOpts.user || subOpts.id;
          const scope = subOpts.scope || 'server';
          if (!targetId) return reply('⚠️ Provide a user (picker) or a user ID.', true);
          let ctxId = null;
          if (scope === 'server') {
            const t = D.resolveServer(channelId);
            if (!t || t === 'ambiguous') return reply("⚠️ Run this in the target server's channel, or use scope **Admin**.", true);
            ctxId = t.id;
          }
          return reply((await D.accountChange(sub.name, String(targetId), scope, ctxId)).message, true);
        }
        if (name === 'admin') {
          const sub = (d.data.options && d.data.options[0]) || {};
          const subOpts = {}; (sub.options || []).forEach(o => subOpts[o.name] = o.value);
          const targetId = subOpts.user || subOpts.id;
          if (!targetId) return reply('⚠️ Provide a user (picker) or a user ID.', true);
          return reply((await D.accountChange(sub.name, String(targetId), 'admin', null)).message, true);
        }
        if (name === 'create') {
          const game = this._opt(d, 'game'), sname = this._opt(d, 'name');
          const password = this._opt(d, 'password') || '', createKey = this._opt(d, 'createkey') || '';
          await defer(true);
          return edit((await D.createServer(game, sname, password, userName, createKey)).message);
        }
        if (name === 'deleteserver') {
          const ref = this._opt(d, 'server'), pw = this._opt(d, 'adminpassword') || '';
          await defer(true);
          return edit((await D.deleteServer(ref, pw, userName)).message);
        }
        return; // handled
      }

      // ── Everything below needs the channel to resolve to a server ──
      const target = D.resolveServer(channelId);
      if (target === 'ambiguous') return reply('⚠️ More than one server is linked to this channel. Link each to its own channel with `/link`.', true);
      if (!target) return reply("⚠️ This channel isn't linked to a server. An admin can link it with `/link server:<name>`.", true);

      // ── Public read-only (status) ──
      if (name === 'status') {
        await defer(false);
        const res = await D.runAction(target.id, 'status', userName);
        return edit(res.message);
      }

      // ── Public read-only (map) ──
      if (name === 'map') {
        await defer(false);
        // Terraria: render the world and upload the image so anyone can view it here.
        const img = D.getMapImage ? await D.getMapImage(target.id) : null;
        if (img && img.ok) {
          try { await this._editOriginalWithImage(d, img.path, `🗺 **${img.name}** — Terraria world map`); return; }
          catch (e) { return edit('❌ Could not upload the map image.'); }
        }
        if (img && img.message) return edit(img.message);
        // Minecraft (and everything else): fall back to the link/text.
        const res = await D.getMapLink(target.id);
        return edit(res.message);
      }

      // ── Per-server allow-listed (start/stop/restart/backup) ──
      if (!D.isAllowed(userId, target.id)) return reply("⛔ You don't have access to commands for this server. (Anyone can use `/status`.)", true);
      await defer(false);
      const res = await D.runAction(target.id, name, userName);
      return edit((res && res.message) || (res && res.ok ? '✅ Done.' : '❌ Failed.'));
    } catch (e) {
      return reply('❌ ' + (e.message || 'Command failed.'), true);
    }
  }

  _rest(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body != null ? JSON.stringify(body) : null;
      let u; try { u = new URL(API + path); } catch (e) { return reject(new Error('bad path')); }
      const headers = {
        'Authorization': 'Bot ' + this.token,
        'User-Agent': 'Omnex (https://github.com/KOBRA1325/omnex, 1.0)',
        'Content-Type': 'application/json',
      };
      if (data) headers['Content-Length'] = Buffer.byteLength(data);
      const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); } }
          else reject(new Error('HTTP ' + res.statusCode + (buf ? ' ' + buf.slice(0, 140) : '')));
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // Edit the deferred interaction response to include an image attachment (multipart).
  _editOriginalWithImage(d, filePath, content) {
    const fileBuf = fs.readFileSync(filePath);
    const filename = 'world-map.png';
    const boundary = '----Omnex' + Date.now().toString(16);
    const payload = JSON.stringify({ content, attachments: [{ id: 0, filename }] });
    const head = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="payload_json"\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      payload + '\r\n' +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files[0]"; filename="${filename}"\r\n` +
      'Content-Type: image/png\r\n\r\n', 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, fileBuf, tail]);
    return this._restRaw('PATCH', `/webhooks/${this.appId}/${d.token}/messages/@original`, body, `multipart/form-data; boundary=${boundary}`);
  }

  // Like _rest but sends a raw Buffer body with a custom Content-Type (for file uploads).
  _restRaw(method, path, bodyBuf, contentType) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(API + path); } catch (e) { return reject(new Error('bad path')); }
      const headers = {
        'Authorization': 'Bot ' + this.token,
        'User-Agent': 'Omnex (https://github.com/KOBRA1325/omnex, 1.0)',
        'Content-Type': contentType,
        'Content-Length': bodyBuf.length,
      };
      const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
        let buf = ''; res.on('data', c => buf += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); } }
          else reject(new Error('HTTP ' + res.statusCode + (buf ? ' ' + buf.slice(0, 140) : '')));
        });
      });
      req.on('error', reject);
      req.write(bodyBuf);
      req.end();
    });
  }
}

module.exports = { DiscordBot };
