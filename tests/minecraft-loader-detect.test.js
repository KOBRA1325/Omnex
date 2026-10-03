// The NeoForge-mislabelled-as-another-loader bug: detectMcLoader could never
// return 'neoforge', and four whitelists omitted it, so a correctly installed
// NeoForge server had its mcType overwritten and then searched for mods on the
// wrong loader.
const { source, grab: grabFrom, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();
const fs = require('fs');
const path = require('path');
const os = require('os');
const SRC = source('main.js');
const grab = grabFrom;
const APP = source('renderer/app.js');

const m = {};
new Function('exports', 'fs', 'path', grab(SRC, 'function detectMcLoader(') + '\nexports.detect=detectMcLoader;')(m, fs, path);


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcloader-'));
const mk = (name, build) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); build(d); return d; };
const touch = (d, ...p) => { fs.mkdirSync(path.join(d, ...p.slice(0, -1)), { recursive: true }); fs.writeFileSync(path.join(d, ...p), 'x'); };

// A NeoForge --installServer layout: libraries/net/neoforged plus a run.bat.
const neo = mk('neo', d => { touch(d, 'libraries', 'net', 'neoforged', 'neoforge', 'x.jar'); touch(d, 'run.bat'); touch(d, 'user_jvm_args.txt'); });
// Forge leaves the same run.bat but under net/minecraftforge.
const forge = mk('forge', d => { touch(d, 'libraries', 'net', 'minecraftforge', 'forge', 'x.jar'); touch(d, 'run.bat'); });
const fabric = mk('fabric', d => { touch(d, 'fabric-server-launch.jar'); touch(d, 'libraries', 'net', 'fabricmc', 'x.jar'); });
const quilt  = mk('quilt',  d => { touch(d, 'quilt-server-launch.jar'); });
const paper  = mk('paper',  d => { touch(d, 'paper-1.21.1.jar'); });
const vanilla = mk('vanilla', d => { touch(d, 'server.jar'); });

check('detects neoforge', m.detect(neo), 'neoforge');
check('still detects forge', m.detect(forge), 'forge');
check('still detects fabric', m.detect(fabric), 'fabric');
check('still detects quilt', m.detect(quilt), 'quilt');
check('still detects paper', m.detect(paper), 'paper');
check('vanilla stays null', m.detect(vanilla), null);
check('missing dir is survivable', m.detect(path.join(tmp, 'nope')), null);

// The regression: a run.bat alone used to make NeoForge look like Forge.
const neoBatOnly = mk('neobat', d => { touch(d, 'neoforge-21.1.252-server.jar'); touch(d, 'run.bat'); });
check('a neoforge jar beats the run.bat forge check', m.detect(neoBatOnly), 'neoforge');

// ── whitelists ──────────────────────────────────────────────────────────────
check('no whitelist omits neoforge', APP.split("['paper','fabric','forge','quilt']").length - 1, 0);
check('whitelists now include neoforge', APP.split("['paper','fabric','forge','neoforge','quilt']").length - 1, 4);
check('vanilla toast mentions NeoForge', APP.includes('Fabric, Paper, Forge, NeoForge, or Quilt'), true);
check('modpack toast mentions NeoForge', APP.includes('Fabric/Forge/NeoForge/Quilt/Paper'), true);
check('main modpack guard includes neoforge', SRC.includes("'forge', 'neoforge', 'quilt'"), true);

fs.rmSync(tmp, { recursive: true, force: true });
report(state);
