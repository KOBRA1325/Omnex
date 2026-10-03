// With verifySignatures on, a mod whose .bikey never reached keys/ rejects every
// player running it, and the only symptom is a refusal at the join screen long
// after the install log has scrolled away. The audit exists to make that visible
// beforehand, and the fix differs per state, so the states must be distinct.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');
const listStart = SRC.indexOf('const ANTISTASI_ULTIMATE_MODS = [');
const PACK_SRC = SRC.slice(listStart, SRC.indexOf('\n];\n', listStart) + 4);

const mod = {};
new Function('exports', 'fs', 'path',
  PACK_SRC + '\n' +
  ['function armaCfgDepth(', 'function parseArmaCfg(', 'function installArmaModKeys(',
   'function armaModKeyNames(', 'function readArmaVerifySignatures(', 'function auditArmaKeys(']
    .map(sig => grab(SRC, sig)).join('\n') +
  '\nexports.audit = auditArmaKeys; exports.installKeys = installArmaModKeys;' +
  'exports.keyNames = armaModKeyNames; exports.PACK = ANTISTASI_ULTIMATE_MODS;'
)(mod, fs, path);
const { audit, installKeys, keyNames, PACK } = mod;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arma3-audit-'));
const inst = path.join(tmp, 'server');
const mods = path.join(inst, 'mods');
const keys = path.join(inst, 'keys');
fs.mkdirSync(keys, { recursive: true });

const mkMod = (folder, keyNamesList) => {
  fs.mkdirSync(path.join(mods, folder, 'keys'), { recursive: true });
  for (const k of keyNamesList) fs.writeFileSync(path.join(mods, folder, 'keys', k), 'x');
  if (!keyNamesList.length) fs.mkdirSync(path.join(mods, folder, 'addons'), { recursive: true });
};

mkMod('@AI_avoids_prone', ['ai_avoids_prone.bikey']);                 // signed, key copied
fs.writeFileSync(path.join(keys, 'ai_avoids_prone.bikey'), 'x');
mkMod('@RHSAFRF', ['rhsafrf.0.5.6.bikey']);                           // signed, key NOT copied
mkMod('@Some_Config_Mod', []);                                        // ships no key at all
fs.writeFileSync(path.join(keys, 'a3.bikey'), 'x');                   // base game key, owns no mod
fs.writeFileSync(path.join(inst, 'server.cfg'), 'hostname = "X";\nverifySignatures = 2;\nclass Missions {};\n');

const server = {
  installDir: inst,
  arma3Mods: [
    { id: '2011658088', name: 'AI avoids prone', folderName: '@AI_avoids_prone', side: 'server' },
    { id: '843425103',  name: 'RHSAFRF',         folderName: '@RHSAFRF',         side: 'server' },
    { id: 'x1',         name: 'Some Config Mod', folderName: '@Some_Config_Mod', side: 'client' },
    { id: 'x2',         name: 'Never Landed',    folderName: '@Never_Landed',    side: 'server' },
  ],
};

const a = audit(server);
const by = Object.fromEntries(a.rows.map(r => [r.name, r]));

// ── the four states, because each has a different remedy ────────────────────
check('signed and copied is ok', by['AI avoids prone'].status, 'ok');
check('signed but not copied is missing', by['RHSAFRF'].status, 'missing');
check('the missing key is named', by['RHSAFRF'].missing, ['rhsafrf.0.5.6.bikey']);
check('no key at all is unsigned', by['Some Config Mod'].status, 'unsigned');
check('recorded but folder gone is notinstalled', by['Never Landed'].status, 'notinstalled');
check('side is carried through', by['Some Config Mod'].side, 'client');
check('counts the key files present', a.keysPresent, 2);
check('reads verifySignatures from server.cfg', a.verifySignatures, '2');

// A pack mod whose download failed has neither a folder nor a record, so neither
// of the obvious loops sees it — which is how a missing RHSUSAF stayed invisible.
check('a pack mod that never downloaded is flagged', by['RHSUSAF'] && by['RHSUSAF'].status, 'notinstalled');
check('it is marked as coming from the pack', by['RHSUSAF'].fromPack, true);
check('every pack mod is accounted for', PACK.every(p => a.rows.some(r => r.name === p.name)), true);
check('an installed pack mod is not listed twice', a.rows.filter(r => r.name === 'AI avoids prone').length, 1);
check('no duplicate rows', new Set(a.rows.map(r => r.folder)).size, a.rows.length);

// Ordering: problems first, so the UI can show only what is broken.
check('unsigned sorts first', a.rows[0].status, 'unsigned');
check('ok sorts last', a.rows[a.rows.length - 1].status, 'ok');
check('problems exclude the healthy row', a.problems, a.rows.length - 1);

// ── re-sync fixes exactly one of those states ───────────────────────────────
for (const f of fs.readdirSync(mods)) installKeys(path.join(mods, f), keys);
const a2 = audit(server);
const by2 = Object.fromEntries(a2.rows.map(r => [r.name, r]));
check('re-sync fixes a missing key', by2['RHSAFRF'].status, 'ok');
check('re-sync cannot fix an unsigned mod', by2['Some Config Mod'].status, 'unsigned');
check('re-sync cannot conjure a mod that never downloaded', by2['RHSUSAF'].status, 'notinstalled');
check('the base-game key is left alone', fs.existsSync(path.join(keys, 'a3.bikey')), true);

// ── edges ───────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(mods, '@Weird', 'Keys', 'deep'), { recursive: true });
fs.writeFileSync(path.join(mods, '@Weird', 'Keys', 'deep', 'Weird.BIKEY'), 'x');
check('finds nested, capitalised keys', keyNames(path.join(mods, '@Weird')), ['Weird.BIKEY']);

const bare = audit({ installDir: path.join(tmp, 'nope') });
check('a bare install still lists the whole pack', bare.rows.length, PACK.length);
check('and reports them all as problems', bare.problems, PACK.length);
check('verifySignatures is null when there is no cfg', bare.verifySignatures, null);

fs.rmSync(tmp, { recursive: true, force: true });
report(state);
