// The Workshop dialog has to be honest about what the server will actually load.
// Keys-only mods are installed purely so the server trusts their signature —
// players can run them without the server loading them, and without dropping
// verifySignatures, which is the blunt alternative.
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const APP = source('renderer/app.js');

// updateLaunchLine and workshopSideOf read module-level state, so inject it.
function launchLine(pack, selected) {
  const line = { textContent: '' };
  const document = { getElementById: id => (id === 'workshopLaunchLine' ? line : null) };
  new Function('document', 'workshopSelectedMods', '_workshopPack',
    grab(APP, 'function workshopSideOf(') + grab(APP, 'function updateLaunchLine(') + '; updateLaunchLine();'
  )(document, selected, pack);
  return line.textContent;
}

const PACK = [
  { id: '1', name: 'Antistasi Ultimate - Mod', side: 'server' },
  { id: '2', name: 'CBA_A3', side: 'server' },
  { id: '3', name: 'Immerse', side: 'client' },
];

// ── the launch line reflects the real -mod= ─────────────────────────────────
const all = launchLine(PACK, PACK.map(m => ({ id: m.id, name: m.name })));
check('server-side mods are listed', all.startsWith('-mod=mods\\@Antistasi_Ultimate___Mod;mods\\@CBA_A3'), true);
check('client-side mods are excluded', /Immerse/.test(all.split('\n')[0]), false);
check('client-side mods are still accounted for', /1 client-side mod \(keys only/.test(all), true);
check('nothing selected', launchLine(PACK, []), 'No mods selected');
check('only client mods selected',
  launchLine(PACK, [{ id: '3', name: 'Immerse' }]).startsWith('No server-side mods selected'), true);

// ── a custom mod can declare its own side ───────────────────────────────────
// This is the feature: a pasted Workshop id that the pack knows nothing about.
const custom = [{ id: '99', name: 'Custom Mod' }];
check('an unknown custom mod loads server-side',
  launchLine(PACK, custom).startsWith('-mod=mods\\@Custom_Mod'), true);

const keysOnly = [{ id: '99', name: 'Custom Mod', side: 'client' }];
check('a keys-only custom mod is not loaded',
  launchLine(PACK, keysOnly).startsWith('No server-side mods selected'), true);
check('and it is counted as keys-only',
  /1 client-side mod \(keys only/.test(launchLine(PACK, keysOnly)), true);

// A mod's own side must beat the pack table, or marking a pack mod keys-only
// would silently do nothing.
const overridden = [{ id: '2', name: 'CBA_A3', side: 'client' }];
check('an explicit side overrides the pack', launchLine(PACK, overridden).startsWith('No server-side mods selected'), true);

// Mixed selection: one of each.
const mixed = launchLine(PACK, [{ id: '2', name: 'CBA_A3' }, { id: '99', name: 'Shader', side: 'client' }]);
check('mixed: server mod listed', mixed.startsWith('-mod=mods\\@CBA_A3'), true);
check('mixed: keys-only mod not listed', /Shader/.test(mixed.split('\n')[0]), false);
check('mixed: keys-only mod counted', /1 client-side mod/.test(mixed), true);

// ── the toggle ──────────────────────────────────────────────────────────────
function makeToggle() {
  const val = { textContent: 'OFF' };
  const classes = new Set();
  const btn = {
    querySelector: () => val,
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: c => classes.has(c) },
  };
  const ctx = { _customModKeysOnly: false };
  const fn = new Function('state', grab(APP, 'function toggleCustomModKeysOnly(')
    .replace(/_customModKeysOnly/g, 'state.on') + '; return toggleCustomModKeysOnly;')(ctx);
  return { btn, val, classes, ctx, fn };
}
const t = makeToggle();
check('toggle starts off', t.ctx.on, undefined);
t.fn(t.btn);
check('one click turns it on', t.ctx.on, true);
check('and the label follows', t.val.textContent, 'ON');
check('and the button is styled on', t.classes.has('on'), true);
t.fn(t.btn);
check('a second click turns it off', t.ctx.on, false);
check('label follows back', t.val.textContent, 'OFF');
check('styling cleared', t.classes.has('on'), false);

// ── wiring, checked against the source ──────────────────────────────────────
const addCustom = grab(APP, 'function addCustomMod(');
check('a custom mod records the chosen side', addCustom.includes("_customModKeysOnly ? 'client' : 'server'"), true);
check('the row is tagged keys only', addCustom.includes('keys only'), true);
check('the toast says which mode', addCustom.includes('(keys only)'), true);
check('re-ticking a row keeps its side', APP.includes('required,side:workshopSideOf(id)'), true);
check('imported presets honour the toggle', APP.includes("side: _customModKeysOnly ? 'client' : 'server'"), true);
check('the toggle exists in the markup', source('renderer/index.html').includes('id="customModKeysOnly"'), true);

// ── the installed panel distinguishes them ──────────────────────────────────
async function installedPanel(reply) {
  const el = { innerHTML: '' }, cnt = { textContent: '' };
  const document = { getElementById: id => (id === 'installedWorkshopMods' ? el : (id === 'installedModCount' ? cnt : null)) };
  const window = { nexus: { getArma3Mods: async () => reply } };
  const fn = new Function('document', 'window', 'escapeHtml', 'return ' + grab(APP, 'async function renderInstalledWorkshopMods('))
    (document, window, String);
  await fn({ id: 's1' });
  return el.innerHTML;
}

(async () => {
  const html = await installedPanel({ ok: true, mods: [
    { id: '2', name: 'CBA_A3', side: 'server', keys: 1 },
    { id: '99', name: 'Shader Pack', side: 'client', keys: 1 },
    { id: '98', name: 'Unsigned Thing', side: 'client', keys: 0 },
  ]});
  check('installed mods are listed', html.includes('CBA_A3'), true);
  check('keys-only mods are tagged client-side', html.includes('client-side'), true);
  check('a server-side mod is not tagged', (html.match(/client-side/g) || []).length, 2);
  check('a mod with no key is flagged', html.includes('no signature key'), true);
  check('only the unsigned one is flagged', (html.match(/no signature key/g) || []).length, 1);

  report(state);
})();
