// Exercise the real Reforger code from main.js: nested-JSON get/set, type
// coercion, the generated config, launch args and scenario-id parsing.
const { source, grab: grabFrom, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();
const fs = require('fs');
const path = require('path');
const SRC = source('main.js');
// This suite passes bare function names, as its original helper did.
const grab = (name) => grabFrom(SRC, 'function ' + name + '(');

const m = {};
new Function('exports',
  ['getJsonPath', 'setJsonPath', 'coerceConfigValue', 'reforgerScenarioLabel'].map(grab).join('\n') +
  '\nexports.get=getJsonPath;exports.set=setJsonPath;exports.coerce=coerceConfigValue;exports.label=reforgerScenarioLabel;'
)(m);


// ── nested get/set ──────────────────────────────────────────────────────────
const doc = { bindPort: 2001, game: { name: 'X', gameProperties: { battlEye: true, serverMaxViewDistance: 1600 }, mods: [{ id: 'keepme' }] } };
check('reads a nested value', m.get(doc, 'game.gameProperties.battlEye'), true);
check('reads a top-level value', m.get(doc, 'bindPort'), 2001);
check('missing path is undefined', m.get(doc, 'game.nope.deep'), undefined);
check('missing root is undefined', m.get(doc, 'nothing'), undefined);

m.set(doc, 'game.name', 'New Name');
m.set(doc, 'game.gameProperties.serverMaxViewDistance', 2500);
m.set(doc, 'rcon.password', 'secret');            // creates the branch
check('sets a nested value', doc.game.name, 'New Name');
check('sets a deep value', doc.game.gameProperties.serverMaxViewDistance, 2500);
check('creates missing branches', doc.rcon.password, 'secret');
check('untouched siblings survive', doc.game.gameProperties.battlEye, true);
check('arrays we do not own survive', doc.game.mods, [{ id: 'keepme' }]);
// An existing non-object in the path must not be silently kept and crashed on.
const doc2 = { game: 'oops' };
m.set(doc2, 'game.name', 'ok');
check('replaces a non-object on the path', doc2.game.name, 'ok');

// ── coercion: Reforger's parser is strict about types ───────────────────────
check('number coerces from string', m.coerce('64', 'number'), 64);
check('bad number falls back to 0', m.coerce('abc', 'number'), 0);
check('bool true from string', m.coerce('true', 'bool'), true);
check('bool false from string', m.coerce('false', 'bool'), false);
check('bool from real boolean', m.coerce(true, 'bool'), true);
check('text stays a string', m.coerce(123, 'text'), '123');
check('number is a real number, not a string', typeof m.coerce('2001', 'number'), 'number');
check('bool is a real boolean, not a string', typeof m.coerce('true', 'bool'), 'boolean');

// ── the generated config ────────────────────────────────────────────────────
const branch = SRC.slice(SRC.indexOf("else if (server.game === 'Arma Reforger') {"));
const litStart = branch.indexOf('cfg = {');
const litEnd = branch.indexOf('\n        };', litStart);
const seed = new Function('gameName', 'gamePort', 'server', 'return ' + branch.slice(litStart + 6, litEnd + 10))
  ('My Reforger Server', 2001, {});
check('seed: server name', seed.game.name, 'My Reforger Server');
check('seed: bindPort', seed.bindPort, 2001);
check('seed: publicPort matches', seed.publicPort, 2001);
check('seed: a2s query port', seed.a2s.port, 17777);
check('seed: maxPlayers', seed.game.maxPlayers, 64);
check('seed: has a scenarioId', /^\{[0-9A-F]{16}\}Missions\/.+\.conf$/i.test(seed.game.scenarioId), true);
check('seed: visible in browser', seed.game.visible, true);
check('seed: battlEye on', seed.game.gameProperties.battlEye, true);
// Reforger refuses to boot on an rcon block with an empty password, so there must not be one.
check('seed: no rcon block', 'rcon' in seed, false);
check('seed: is valid JSON', typeof JSON.parse(JSON.stringify(seed)), 'object');

// Every schema key must resolve against the generated config, or the editor shows
// blanks that write nulls on first save.
const schemaSrc = SRC.slice(SRC.indexOf("GAME_CONFIG_DEFS['Arma Reforger'] = {"));
const keys = [...schemaSrc.slice(0, schemaSrc.indexOf('\n};')).matchAll(/key: '([^']+)'/g)].map(x => x[1]);
check('schema has keys', keys.length > 10, true);
check('every schema key exists in the seed', keys.filter(k => m.get(seed, k) === undefined), []);

// ── launch args ─────────────────────────────────────────────────────────────
const defStart = SRC.indexOf("  'Arma Reforger':   {");
const defSrc = SRC.slice(defStart, SRC.indexOf("\n  'FiveM'", defStart));
const def = new Function('path', 'return {' + defSrc.replace(/,\s*$/, '') + '}')(path)['Arma Reforger'];
check('appId', def.serverAppId, '1874900');
check('anonymous steam, not steam_auth', def.type, 'steam');
check('startExe', def.startExe, 'ArmaReforgerServer.exe');
const args = def.startArgs('C:/srv', { port: '2001' });
check('passes -config', args[args.indexOf('-config') + 1], path.join('C:/srv', 'configs', 'server.json'));
check('passes -profile', args[args.indexOf('-profile') + 1], path.join('C:/srv', 'profile'));
check('caps fps', args[args.indexOf('-maxFPS') + 1], '60');
check('passes -port', args[args.indexOf('-port') + 1], '2001');
check('respects a custom fps cap', def.startArgs('C:/srv', { reforgerMaxFPS: 120 })[args.indexOf('-maxFPS') + 1], '120');

// ── scenario id parsing ─────────────────────────────────────────────────────
const reSrc = SRC.match(/const REFORGER_SCENARIO_RE = (\/.+\/[gi]*);/)[1];
const RE = new Function('return ' + reSrc)();
const sample = [
  'SCRIPT       : {ECC61978EDCC2B5A}Missions/23_Campaign.conf',
  'SCRIPT       : {59AD59368755F41A}Missions/21_GM_Eden.conf',
  'ENGINE  : unrelated line with no scenario',
  'SCRIPT       : {C41618FD18E9D714}Missions/23_Campaign_Arland.conf',
].join('\n');
const found = sample.match(RE) || [];
check('finds every scenario id', found.length, 3);
check('captures the full id', found[0], '{ECC61978EDCC2B5A}Missions/23_Campaign.conf');
check('ignores unrelated log lines', found.some(x => x.includes('unrelated')), false);
check('labels the campaign readably', m.label('{ECC61978EDCC2B5A}Missions/23_Campaign.conf'), 'Campaign');
check('labels a GM scenario', m.label('{59AD59368755F41A}Missions/21_GM_Eden.conf'), 'GM Eden');
check('labels a mod scenario without a prefix', m.label('{AAAAAAAAAAAAAAAA}Missions/MyCoolMission.conf'), 'My Cool Mission');

// The write guard must accept mod scenarios but reject junk.
const guard = new RegExp(SRC.match(/if \(!\/(\^\\\{\[0-9A-Fa-f\]\{16\}\\\}[^\n]+?)\/\.test\(id\)\)/)[1]);
check('guard accepts a stock id', guard.test('{ECC61978EDCC2B5A}Missions/23_Campaign.conf'), true);
check('guard accepts a mod id', guard.test('{0123456789ABCDEF}Missions/Custom.conf'), true);
check('guard rejects a bare name', guard.test('23_Campaign.conf'), false);
check('guard rejects a short guid', guard.test('{ABC}Missions/x.conf'), false);
check('guard rejects a backslash path', guard.test('{ECC61978EDCC2B5A}Missions\\x.conf'), false);

report(state);
