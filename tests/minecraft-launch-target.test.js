// Forge/NeoForge have no runnable jar; their installers leave a run script.
// runInstall used to hardcode server.jar, so those servers started by trying to
// run a jar that does not exist. This covers the install-time choice, the
// start-time repair for already-broken records, and the vanilla path.
const { source, grab: grabFrom, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();
// This suite reads one file, so grab() takes just the signature.
const fs = require('fs');
const path = require('path');
const os = require('os');
const SRC = source('main.js');
const grab = (sig) => grabFrom(SRC, sig);


const findJar = new Function('fs', 'path', grab('function findMinecraftJar(') + '; return findMinecraftJar;')(fs, path);

// ── fixtures ────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-'));
const mk = (name, files) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); } return d; };

// NeoForge: a run script AND the vanilla jar sitting beside it — picking the jar
// would silently launch unmodded Minecraft.
const neo     = mk('neo',     ['run.bat', 'user_jvm_args.txt', 'libraries/net/neoforged/x.jar', 'minecraft_server.1.21.1.jar']);
const forge   = mk('forge',   ['run.bat', 'libraries/net/minecraftforge/x.jar', 'minecraft_server.1.20.1.jar']);
const fabric  = mk('fabric',  ['fabric-server-launch.jar', 'server.jar']);
const vanilla = mk('vanilla', ['server.jar']);

// The install-time choice, mirroring runInstall.
function chooseExec(dir, mcType) {
  const runScript = ['run.bat', 'run.sh'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  return ((mcType === 'forge' || mcType === 'neoforge') && runScript)
    || findJar(dir) || path.join(dir, 'server.jar');
}
const base = p => path.basename(p);

check('neoforge picks the run script', base(chooseExec(neo, 'neoforge')), 'run.bat');
check('neoforge does NOT pick the vanilla jar', /minecraft_server/.test(chooseExec(neo, 'neoforge')), false);
check('forge picks the run script', base(chooseExec(forge, 'forge')), 'run.bat');
check('fabric picks its launch jar', base(chooseExec(fabric, 'fabric')), 'fabric-server-launch.jar');
check('vanilla picks server.jar', base(chooseExec(vanilla, 'vanilla')), 'server.jar');
check('useShell true only for scripts', /\.(bat|cmd|sh)$/i.test(chooseExec(neo, 'neoforge')), true);
check('useShell false for jars', /\.(bat|cmd|sh)$/i.test(chooseExec(vanilla, 'vanilla')), false);

// This is the bug: findMinecraftJar alone would pick the vanilla jar for NeoForge.
check('findMinecraftJar alone is NOT safe for neoforge', /minecraft_server|server\.jar/.test(findJar(neo)), true);

// ── start-time repair of an already-broken record ───────────────────────────
function repair(server) {
  let mcExec = server.execPath || path.join(server.installDir, 'server.jar');
  if (!fs.existsSync(mcExec)) {
    const runScript = ['run.bat', 'run.sh'].map(f => path.join(server.installDir, f)).find(f => fs.existsSync(f));
    const resolved = ((server.mcType === 'forge' || server.mcType === 'neoforge') && runScript)
      || findJar(server.installDir) || runScript;
    if (resolved) { mcExec = resolved; server.execPath = resolved; server.useShell = /\.(bat|cmd|sh)$/i.test(resolved); }
  }
  return mcExec;
}
// Exactly the user's state: execPath points at a server.jar that was never created.
const broken = { mcType: 'neoforge', installDir: neo, execPath: path.join(neo, 'server.jar'), useShell: false };
check('repairs a missing server.jar', base(repair(broken)), 'run.bat');
check('record updated', base(broken.execPath), 'run.bat');
check('useShell flipped on', broken.useShell, true);

const healthy = { mcType: 'vanilla', installDir: vanilla, execPath: path.join(vanilla, 'server.jar'), useShell: false };
check('leaves a working record alone', base(repair(healthy)), 'server.jar');
check('useShell untouched when fine', healthy.useShell, false);

// ── wiring ──────────────────────────────────────────────────────────────────
check('runInstall no longer hardcodes server.jar',
  SRC.includes("server.execPath = path.join(server.installDir, 'server.jar');\n  }"), false);
check('start path has the repair', SRC.includes('Launch target repaired'), true);

fs.rmSync(tmp, { recursive: true, force: true });
report(state);
