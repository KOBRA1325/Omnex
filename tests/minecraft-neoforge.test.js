// Exercise the real NeoForge helpers from main.js and the explaining empty state
// from app.js, including the user's exact case: Forge 1.21.1 searching Pixelmon.
const { source, grab: grabFrom, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();
const fs = require('fs');
const SRC = source('main.js');
const grab = grabFrom;
const APP = source('renderer/app.js');


// Mojang supplies the version NAMES; NeoForge builds only say which exist.
// Includes 26.x to cover the 2026 scheme change that dropped the leading "1.".
const FAKE_MANIFEST = { versions: [
  { id: '26.3',    type: 'release' },
  { id: '26.2',    type: 'release' },
  { id: '1.21.11', type: 'release' },
  { id: '1.21.1',  type: 'release' },
  { id: '1.21',    type: 'release' },
  { id: '1.20.1',  type: 'release' },
  { id: 'snap-1',  type: 'snapshot' },
] };

const m = {};
new Function('exports', 'fetchJSON',
  grab(SRC, 'function neoforgePrefixFor(') + '\n' + grab(SRC, 'async function neoforgeMcVersions(') +
  '\nexports.prefix=neoforgePrefixFor;exports.mcVersions=neoforgeMcVersions;'
)(m, async () => FAKE_MANIFEST);


// ── version mapping (every case verified against the live NeoForge list) ────
check('1.21.1 -> 21.1.',   m.prefix('1.21.1'),  '21.1.');
check('1.21.11 -> 21.11.', m.prefix('1.21.11'), '21.11.');
check('1.21 -> 21.0.',     m.prefix('1.21'),    '21.0.');
check('1.20.2 -> 20.2.',   m.prefix('1.20.2'),  '20.2.');
// The 2026 scheme change: Minecraft dropped the leading "1.".
check('26.3 -> 26.3. (new scheme)', m.prefix('26.3'), '26.3.');
check('26.1.2 -> 26.1.',            m.prefix('26.1.2'), '26.1.');
check('rejects junk',  m.prefix('latest'), null);
check('rejects empty', m.prefix(''), null);

(async () => {
  const builds = ['20.2.93', '21.1.252', '21.11.4', '26.2.0.88', '26.3.0.43-beta'];
  const list = await m.mcVersions(builds);

  // THE BUG THIS FIXES: deriving names from build numbers invented "1.26.3" for
  // the release Minecraft actually calls "26.3", offering installs that 404.
  check('never invents 1.26.3', list.includes('1.26.3'), false);
  check('uses Mojang\'s name 26.2', list.includes('26.2'), true);
  check('keeps old-scheme versions', list.includes('1.21.1'), true);
  check('keeps 1.21.11', list.includes('1.21.11'), true);
  // 26.3 only has a beta build, so it must not be offered as installable.
  check('excludes beta-only 26.3', list.includes('26.3'), false);
  // NeoForge genuinely has no 1.20.1 build.
  check('excludes 1.20.1 (no NeoForge)', list.includes('1.20.1'), false);
  check('excludes snapshots', list.some(v => v.startsWith('snap')), false);
  check('newest first', list[0], '26.2');
  check('every entry is a real Mojang release',
    list.every(v => FAKE_MANIFEST.versions.some(x => x.id === v && x.type === 'release')), true);
  check('no builds -> empty list', await m.mcVersions([]), []);
  check('only betas -> empty list', await m.mcVersions(['26.3.0.1-beta']), []);

  // ── wiring ────────────────────────────────────────────────────────────────
  check('install dispatch handles neoforge', SRC.includes("} else if (type === 'neoforge') {"), true);
  check('bluemap knows neoforge', SRC.includes("neoforge: 'neoforge'"), true);
  check('modpack guard allows neoforge', SRC.includes("'forge', 'neoforge', 'quilt'"), true);
  check('async call sites awaited', SRC.includes('(await neoforgeMcVersions(all))'), true);
  check('version list wired in renderer', APP.includes("selectedMcType==='neoforge'"), true);

  // ── the explaining empty state ────────────────────────────────────────────
  const emptyFn = grab(APP, 'async function renderModSearchEmpty(');
  function runEmpty(replies, { loader = 'forge', mcVersion = '1.21.1', q = 'Pixelmon', browseType = 'modpack' } = {}) {
    const grid = { innerHTML: '' };
    const escapeHtml = t => String(t);
    const window = { nexus: { searchModrinth: async (opts) => {
      if (opts.loader && opts.gameVersion) return replies.otherLoader || { hits: [] };
      if (opts.gameVersion) return replies.noLoader  || { hits: [] };
      if (opts.loader)      return replies.noVersion || { hits: [] };
      return { hits: [] };
    } } };
    const fn = new Function('window', 'escapeHtml', 'modBrowseType', 'modActiveCat', 'return ' + emptyFn)
      (window, escapeHtml, browseType, '');
    return fn(grid, q, loader, { mcVersion }).then(() => grid.innerHTML);
  }
  const hit = (t) => ({ hits: [{ title: t }] });

  const real = await runEmpty({
    noLoader: hit('The Pixelmon Modpack'), noVersion: hit('The Pixelmon Modpack'), otherLoader: hit('The Pixelmon Modpack'),
  });
  check('names both filters', real.includes('forge') && real.includes('1.21.1'), true);
  check('names neoforge as the one that has it', real.includes('neoforge'), true);
  check('does not blame the search text', /Try another search/.test(real), false);

  const verOnly = await runEmpty({ noVersion: hit('Some Mod') });
  check('version-only: names the version', verOnly.includes('1.21.1'), true);
  check('version-only: says other versions exist', verOnly.includes('other versions'), true);

  const loaderOnly = await runEmpty({ noLoader: hit('Some Mod') });
  check('loader-only: names the loader', loaderOnly.includes('forge'), true);
  check('loader-only: mentions NeoForge publishing', loaderOnly.includes('NeoForge'), true);

  const nothing = await runEmpty({});
  check('no results at all: plain message', /Try another search/.test(nothing), true);
  check('no results at all: quotes the query', nothing.includes('Pixelmon'), true);

report(state);
})();
