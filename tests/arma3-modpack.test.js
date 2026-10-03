// The Antistasi Ultimate pack. Two things here have bitten before and are what
// this suite guards: the original hand-written mod list had four ids pointing at
// entirely different mods, and signature keys were never installed at all, which
// silently rejects every player at the join screen.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');
const listStart = SRC.indexOf('const ANTISTASI_ULTIMATE_MODS = [');
const PACK_SRC = SRC.slice(listStart, SRC.indexOf('\n];\n', listStart) + 4);
const sideMapSrc = SRC.slice(SRC.indexOf('const ARMA_MOD_SIDES'), SRC.indexOf('\n', SRC.indexOf('const ARMA_MOD_SIDES')) + 1);

const mod = {};
new Function('exports', 'fs', 'path',
  PACK_SRC + '\n' + sideMapSrc + '\n' +
  ['function armaModSide(', 'function installArmaModKeys('].map(sig => grab(SRC, sig)).join('\n') +
  '\nexports.PACK = ANTISTASI_ULTIMATE_MODS; exports.side = armaModSide; exports.installKeys = installArmaModKeys;'
)(mod, fs, path);
const { PACK, side, installKeys } = mod;

// ── the mod list ────────────────────────────────────────────────────────────
check('every id is numeric', PACK.every(m => /^\d+$/.test(m.id)), true);
check('no duplicate ids', new Set(PACK.map(m => m.id)).size, PACK.length);
check('every mod has a name', PACK.every(m => m.name && m.name.trim()), true);
check('every mod declares a side', PACK.every(m => m.side === 'server' || m.side === 'client'), true);

// Ids verified against Steam's GetPublishedFileDetails when the pack was built.
// These four were wrong in the original list and are the regression to catch.
const byId = Object.fromEntries(PACK.map(m => [m.id, m.name]));
check('843425103 is RHSAFRF, not 3den Enhanced', byId['843425103'], 'RHSAFRF');
check('the non-existent id is gone', '2018593667' in byId, false);
check('CUP Terrains id is not mislabelled as RHS', byId['583496184'], undefined);
check('CUP Vehicles id is not mislabelled as RHS', byId['541888371'], undefined);
check('Antistasi Ultimate is present', byId['3020755032'], 'Antistasi Ultimate - Mod');
check('CBA_A3 is present', byId['450814997'], 'CBA_A3');

// Antistasi's workshop page declares exactly one hard requirement.
const required = PACK.filter(m => m.required).map(m => m.name).sort();
check('required set', required, ['Antistasi Ultimate - Mod', 'CBA_A3']);

// ── the server/client split ─────────────────────────────────────────────────
// Content the mission spawns from must load server-side; cosmetics must not.
const server = PACK.filter(m => m.side === 'server').map(m => m.name).sort();
check('server-side set', server,
  ['AI avoids prone', 'Antistasi Ultimate - Mod', 'CBA_A3', 'RHSAFRF', 'RHSSAF', 'RHSUSAF', 'ace']);
check('every RHS pack loads server-side',
  PACK.filter(m => /^RHS/.test(m.name)).every(m => m.side === 'server'), true);
check('a visual mod stays client-side', side({ id: '2257686620' }), 'client');   // Blastcore
check('an audio mod stays client-side', side({ id: '825179978' }), 'client');    // Enhanced Soundscape
check('CBA is server-side', side({ id: '450814997' }), 'server');
check('AI behaviour is server-side', side({ id: '2011658088' }), 'server');
check('an unknown mod defaults to server-side', side({ id: '999999999' }), 'server');
check('an explicit side wins over the table', side({ id: '450814997', side: 'client' }), 'client');

// ── signature keys ──────────────────────────────────────────────────────────
// Keys are collected from client-side mods too: the server never loads them, but
// without their key it refuses the players who do.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arma3-keys-'));
const modDir = path.join(tmp, '@Test');
fs.mkdirSync(path.join(modDir, 'keys'), { recursive: true });
fs.mkdirSync(path.join(modDir, 'addons'), { recursive: true });
fs.writeFileSync(path.join(modDir, 'keys', 'test1.bikey'), 'k1');
fs.writeFileSync(path.join(modDir, 'addons', 'ignore.pbo'), 'not a key');
// Some mods nest keys, or capitalise the folder and extension.
fs.mkdirSync(path.join(modDir, 'Keys', 'sub'), { recursive: true });
fs.writeFileSync(path.join(modDir, 'Keys', 'sub', 'Test2.BIKEY'), 'k2');

const keysDir = path.join(tmp, 'server', 'keys');
check('finds nested and capitalised keys', installKeys(modDir, keysDir), 2);
check('keys land in keys/', fs.readdirSync(keysDir).sort(), ['Test2.BIKEY', 'test1.bikey']);
check('non-key files are not copied', fs.readdirSync(keysDir).includes('ignore.pbo'), false);
check('a mod with no keys reports zero', installKeys(path.join(tmp, 'nope'), keysDir), 0);
check('re-running is idempotent', (() => {
  installKeys(modDir, keysDir);
  return fs.readdirSync(keysDir).length;
})(), 2);

// ── launch args built from the split ────────────────────────────────────────
const defStart = SRC.indexOf("  'Arma 3':          {");
const def = new Function('return {' +
  SRC.slice(defStart, SRC.indexOf("\n  'FiveM'", defStart)).replace(/,\s*$/, '') + '}')()['Arma 3'];

check('no -mod without mods', def.startArgs('C:/x', {}).some(a => a.startsWith('-mod=')), false);
check('-mod uses the mods\\ prefix',
  def.startArgs('C:/x', { armaMods: ['@CBA_A3'] }).pop(), '-mod=mods\\@CBA_A3');
check('-mod joins with semicolons',
  def.startArgs('C:/x', { armaMods: ['@A', '@B', '@C'] }).pop(), '-mod=mods\\@A;mods\\@B;mods\\@C');
// The installer used to bake server.args, which froze the port at install time.
check('port changes still apply once mods are installed',
  def.startArgs('C:/x', { port: '2500', armaMods: ['@A'] })[0], '-port=2500');
check('install no longer bakes server.args', SRC.includes('server.args = `-config=server.cfg'), false);
check('install records the folder list instead', SRC.includes('server.armaMods = modFolders;'), true);
check('a mod folder is replaced, not skipped, on update',
  SRC.includes('if (fs.existsSync(modDest)) fs.rmSync(modDest, { recursive: true, force: true });'), true);

fs.rmSync(tmp, { recursive: true, force: true });
report(state);
