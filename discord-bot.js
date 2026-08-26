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
let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) { WebSocket = null; }

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]); // bad token / bad intents / etc.

const COMMANDS = [
  { name: 'start',   description: "Start this channel's server",   type: 1 },
  { name: 'stop',    description: "Stop this channel's server",    type: 1 },
  { name: 'restart', description: "Restart this channel's server", type: 1 },
  { name: 'backup',  description: "Back up this channel's server", type: 1 },
  { name: 'status',  description: "Show this channel's server status", type: 1 },
];

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

  async _onInteraction(d) {
    if (d.type !== 2) return; // APPLICATION_COMMAND only
    const name = d.data && d.data.name;
    const user = (d.member && d.member.user) || d.user || {};
    const userId = user.id;
    const userName = (d.member && d.member.nick) || user.global_name || user.username || 'someone';
    const channelId = d.channel_id;

    const respond = (content, ephemeral) =>
      this._rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content, flags: ephemeral ? 64 : 0 } }).catch(() => {});
    const editOriginal = (content) =>
      this._rest('PATCH', `/webhooks/${this.appId}/${d.token}/messages/@original`, { content }).catch(() => {});

    if (!this.deps.isAllowed(userId)) return respond('⛔ You are not on the allowlist for server commands.', true);

    const target = this.deps.resolveServer(channelId);
    if (target === 'ambiguous') return respond('⚠️ More than one server is linked to this channel. Give each server its own channel (set per-server webhooks in Omnex).', true);
    if (!target) return respond("⚠️ This channel isn't linked to a server yet. In Omnex, open that server → Network panel → set this channel's Discord webhook.", true);

    // Actions take time (start/stop/backup) — defer, then edit the reply with the outcome.
    await this._rest('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 5 }).catch(() => {});
    try {
      const res = await this.deps.runAction(target.id, name, userName);
      await editOriginal((res && res.message) || (res && res.ok ? '✅ Done.' : '❌ Failed.'));
    } catch (e) {
      await editOriginal('❌ ' + (e.message || 'Command failed.'));
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
}

module.exports = { DiscordBot };
