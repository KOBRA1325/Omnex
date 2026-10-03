// Arma 3's server.cfg is its own C-like format (key = value;), so it has a
// hand-written parser and writer. The risk is clobbering a user's file: the
// writer must leave class blocks, array keys and comments exactly as found.
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');
const mod = {};
new Function('exports',
  ['function armaCfgDepth(', 'function parseArmaCfg(', 'function patchArmaCfg(']
    .map(sig => grab(SRC, sig)).join('\n') +
  '\nexports.parse = parseArmaCfg; exports.patch = patchArmaCfg;')(mod);
const { parse, patch } = mod;

const DEF = { strings: ['hostname', 'password', 'passwordAdmin', 'serverCommandPassword', 'logFile', 'timeStampFormat'] };

// A realistic file: quoted strings, an array key, comments, and a nested class
// block whose inner keys must not leak into the top level.
const CFG = [
  '// My server',
  'hostname = "Test Server";',
  'password = "";',
  'passwordAdmin = "secret";',
  'maxPlayers = 40;',
  'persistent = 1;',
  'verifySignatures = 2;',
  'motd[] = {"Line one","Line two"};',
  'motdInterval = 30;',
  'timeStampFormat = "short";',
  '',
  'class Missions {',
  '    class MyMission {',
  '        template = "MyMission.Altis";',
  '        difficulty = "Regular";',
  '        maxPlayers = 99;',
  '    };',
  '};',
].join('\n');

// ── parsing ─────────────────────────────────────────────────────────────────
const p = parse(CFG);
check('strips quotes from strings', p.hostname, 'Test Server');
check('keeps an empty string', p.password, '');
check('reads numbers as written', p.maxPlayers, '40');
check('reads flags', p.persistent, '1');
check('array keys are skipped, not mangled', 'motd' in p, false);
check('nested template is not hoisted', 'template' in p, false);
check('nested difficulty is not hoisted', 'difficulty' in p, false);
// The nested block also has maxPlayers; the top-level one must win.
check('nested key does not shadow the top level', p.maxPlayers, '40');
check('comments are not parsed as keys', Object.keys(p).some(k => k.startsWith('//')), false);
check('class line is not a key', 'class' in p, false);

// ── writing ─────────────────────────────────────────────────────────────────
const out = patch(CFG, { hostname: 'New Name', maxPlayers: '64', persistent: '0', BattlEye: '1' }, DEF);
const p2 = parse(out);
check('rewrites a string value', p2.hostname, 'New Name');
check('rewrites a number', p2.maxPlayers, '64');
check('rewrites a flag', p2.persistent, '0');
check('appends a key the file lacked', p2.BattlEye, '1');
check('leaves untouched keys alone', p2.verifySignatures, '2');
check('quotes string values', /^hostname = "New Name";$/m.test(out), true);
check('leaves numbers unquoted', /^maxPlayers = 64;$/m.test(out), true);
check('does not duplicate a rewritten key', (out.match(/^hostname = /gm) || []).length, 1);

// The parts of a user's file we must never touch.
check('nested class block survives verbatim', out.includes(CFG.slice(CFG.indexOf('class Missions {'))), true);
check('array key survives verbatim', /^motd\[\] = \{"Line one","Line two"\};$/m.test(out), true);
check('comment survives', out.includes('// My server'), true);

// A quote in a user-supplied value must not break out of the string.
const evil = patch(CFG, { hostname: 'He said "hi"' }, DEF);
check('quotes in a value are neutralised', parse(evil).hostname, "He said 'hi'");
check('still one hostname line after that', (evil.match(/^hostname = /gm) || []).length, 1);

// Appending to a minimal file.
const appended = patch('hostname = "x";', { logFile: 'a.log' }, DEF);
check('appends to a minimal file', parse(appended).logFile, 'a.log');
check('appended string is quoted', /^logFile = "a\.log";$/m.test(appended), true);
check('appended value round-trips', parse(patch(appended, { logFile: 'b.log' }, DEF)).logFile, 'b.log');

// ── the generated seed config ───────────────────────────────────────────────
// Pull the literal Omnex writes on install straight out of syncServerConfig.
const branch = SRC.slice(SRC.indexOf("else if (server.game === 'Arma 3') {"));
const arrStart = branch.indexOf('fs.writeFileSync(cfgPath, [');
const arrEnd = branch.indexOf("].join('\\n'));", arrStart);
const seed = new Function('host', 'pw', 'apw', 'maxc',
  'return (' + branch.slice(branch.indexOf('[', arrStart), arrEnd + 1) + ").join('\\n');")('My Server', '', '', '32');
const sp = parse(seed);

check('seed: hostname', sp.hostname, 'My Server');
check('seed: maxPlayers', sp.maxPlayers, '32');
check('seed: empty password', sp.password, '');
check('seed: signature checking on', sp.verifySignatures, '2');
check('seed: BattlEye on', sp.BattlEye, '1');
check('seed: persistent', sp.persistent, '1');
check('seed: logFile', sp.logFile, 'server_console.log');
check('seed: timestamps', sp.timeStampFormat, 'short');
check('seed: vote threshold', sp.voteThreshold, '0.33');
check('seed: voice quality', sp.vonCodecQuality, '10');
check('seed: motd[] is not a prop', 'motd' in sp, false);
check('seed: Missions is not a prop', 'Missions' in sp, false);

// Every editable key must exist in the seed, or the Config editor shows blanks
// that silently append on first save.
const schema = SRC.slice(SRC.indexOf("GAME_CONFIG_DEFS['Arma 3'] = {"));
const keys = [...schema.slice(0, schema.indexOf('\n};')).matchAll(/key: '([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1]);
check('schema declares keys', keys.length > 10, true);
check('every schema key is present in the seed', keys.filter(k => !(k in sp)), []);
check('every schema key survives a write', (() => {
  const written = parse(patch(seed, Object.fromEntries(keys.map(k => [k, sp[k]])), DEF));
  return keys.filter(k => !(k in written));
})(), []);

// ── launch args ─────────────────────────────────────────────────────────────
const defStart = SRC.indexOf("  'Arma 3':          {");
const defSrc = SRC.slice(defStart, SRC.indexOf("\n  'FiveM'", defStart));
const def = new Function('return {' + defSrc.replace(/,\s*$/, '') + '}')()['Arma 3'];

check('app id', def.serverAppId, '233780');
check('needs a Steam login', def.type, 'steam_auth');
check('64-bit exe preferred', def.startExe, 'arma3server_x64.exe');
check('32-bit fallback for imports', def.altExe, 'arma3server.exe');
check('default port', def.startArgs('C:/x', {})[0], '-port=2302');
check('port is honoured', def.startArgs('C:/x', { port: '2402' })[0], '-port=2402');
check('config and profile passed', (() => {
  const a = def.startArgs('C:/x', {});
  return a.includes('-config=server.cfg') && a.includes('-profiles=profiles');
})(), true);
check('no -mod when no mods installed', def.startArgs('C:/x', {}).some(a => a.startsWith('-mod=')), false);
check('-mod built from installed folders',
  def.startArgs('C:/x', { armaMods: ['@A', '@B'] }).pop(), '-mod=mods\\@A;mods\\@B');
check('port still applies alongside mods',
  def.startArgs('C:/x', { port: '2402', armaMods: ['@A'] })[0], '-port=2402');

report(state);
