// Every Discord post used to go out as "Omnex" with a blank avatar, so several
// servers sharing a channel were indistinguishable without reading the title.
// Each server now posts under its own name and the game's art.
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');

// serverDiscordIdentity reads appData, so give it one.
function identityFor(servers, serverId) {
  const appData = { servers };
  return new Function('appData', grab(SRC, 'function serverDiscordIdentity(') +
    '; return serverDiscordIdentity;')(appData)(serverId);
}

const STEAM_ICON = 'https://cdn.cloudflare.steamstatic.com/steam/apps/107410/capsule_sm_120.jpg';
const SERVERS = [
  { id: 'a', name: 'Antistasi Ultimate Server', game: 'Arma 3', icon: STEAM_ICON },
  // Minecraft's icon is a bundled relative path, not a URL Discord can fetch.
  { id: 'm', name: 'Pixelmon', game: 'Minecraft', icon: '../assets/minecraft.jpg' },
  { id: 'f', name: 'Central Elite RP', game: 'FiveM', icon: '' },
  { id: 'c', name: 'Custom', game: 'Rust', icon: STEAM_ICON, customIcon: 'https://example.com/mine.png' },
  { id: 'e', name: 'Emoji Icon', game: 'Rust', icon: STEAM_ICON, customIcon: '🎮' },
  { id: 'n', name: '   ', game: 'Rust', icon: '' },
];
const id = (sid) => identityFor(SERVERS, sid);

// ── username ────────────────────────────────────────────────────────────────
check('posts under the server name', id('a').username, 'Antistasi Ultimate Server');
check('a server with no usable icon still gets a name', id('f').username, 'Central Elite RP');
check('a blank name yields no username', (id('n') || {}).username, undefined);
check('an unknown server has no identity', id('nope'), null);
check('no serverId means no identity', id(undefined), null);

// Discord rejects usernames containing "discord", and caps them at 80 chars.
const tricky = identityFor([{ id: 'x', name: 'My Discord Server' }], 'x');
check('the literal "discord" is avoided', /discord/i.test(tricky.username), false);
check('and the rest of the name survives', /My .* Server/.test(tricky.username), true);
const long = identityFor([{ id: 'x', name: 'N'.repeat(200) }], 'x');
check('username is capped at 80', long.username.length, 80);

// ── avatar ──────────────────────────────────────────────────────────────────
check('uses the game art as avatar', id('a').avatar_url, STEAM_ICON);
check('a relative icon path is not used', 'avatar_url' in id('m'), false);
check('an empty icon is not used', 'avatar_url' in id('f'), false);
check('a custom image URL wins over the game art', id('c').avatar_url, 'https://example.com/mine.png');
check('an emoji custom icon falls back to the game art', id('e').avatar_url, STEAM_ICON);

// ── the payload actually carries it ─────────────────────────────────────────
// Drive the real postDiscordEmbeds body up to the point it builds the JSON.
function payloadFor(identity) {
  const body = grab(SRC, 'function postDiscordEmbeds(');
  const m = body.match(/try \{\n([\s\S]*?)\n    \}/);
  const built = new Function('embeds', 'identity', m[1].replace('payload =', 'return'))([{ title: 't' }], identity);
  return JSON.parse(built);
}
check('default identity is still Omnex', payloadFor(null).username, 'Omnex');
check('no avatar when there is no identity', 'avatar_url' in payloadFor(null), false);
check('server name reaches the payload', payloadFor(id('a')).username, 'Antistasi Ultimate Server');
check('avatar reaches the payload', payloadFor(id('a')).avatar_url, STEAM_ICON);
check('a nameless identity leaves Omnex in place', payloadFor({ avatar_url: STEAM_ICON }).username, 'Omnex');
check('embeds are still sent', payloadFor(id('a')).embeds.length, 1);

// ── batching keeps identities apart ─────────────────────────────────────────
// Discord applies username/avatar per MESSAGE, so two servers sharing a webhook
// must not be merged — one would post under the other's name.
const flush = grab(SRC, 'function flushDiscordQueue(');
check('batches by server, not just webhook', flush.includes("item.url + '\\u0000' + (item.serverId || '')"), true);
check('each batch resolves its own identity', flush.includes('serverDiscordIdentity(serverId)'), true);
check('the queue records which server queued it', SRC.includes('_discordQueue.push({ url, embed, serverId });'), true);

// Simulate the grouping to prove two servers on one webhook stay separate.
const grouped = (() => {
  const queue = [
    { url: 'W1', serverId: 'a', embed: 1 },
    { url: 'W1', serverId: 'm', embed: 2 },
    { url: 'W1', serverId: 'a', embed: 3 },
    { url: 'W2', serverId: 'a', embed: 4 },
  ];
  const byTarget = new Map();
  for (const item of queue) {
    const key = item.url + '\u0000' + (item.serverId || '');
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(item);
  }
  return [...byTarget.values()].map(v => v.map(i => i.embed));
})();
check('same webhook, two servers -> two messages', grouped.length, 3);
check('one server\'s embeds stay together', grouped[0], [1, 3]);
check('the other server is not merged in', grouped[1], [2]);

// ── event colours were deliberately left alone ──────────────────────────────
const colors = SRC.match(/const NOTIFY_COLORS = \{[^}]+\}/)[0];
check('crash is still red', /crash: 0xED4245/.test(colors), true);
check('start is still green', /start: 0x57F287/.test(colors), true);
check('identity did not take over colour', SRC.includes('color: NOTIFY_COLORS[event]'), true);

// ── notify and the test button route the server through ─────────────────────
check('notify passes the server to Discord', SRC.includes('color: NOTIFY_COLORS[event], fields, serverId,'), true);
check('the single-embed helper accepts a serverId', SRC.includes('function postDiscordWebhook(webhookUrl, { title, description, color, fields, serverId })'), true);
check('the test message previews the server identity', SRC.includes("title: s ? `✅ ${s.name} connected`"), true);

report(state);
