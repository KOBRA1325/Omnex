// Per-server memory allocation.
//
// Two things make this more than "store a number". First, the heap used to be
// hardcoded to -Xmx2G for every Minecraft server. Second, Forge and NeoForge
// never see that command line at all — they launch through run.bat, which reads
// its JVM arguments from user_jvm_args.txt, so the value has to be written into
// that file or the slider does nothing for exactly the servers that need it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcram-'));

const mod = {};
new Function('exports', 'fs', 'path', 'require',
  'const MC_RAM_MIN_MB = 512, MC_RAM_DEFAULT_MB = 2048, MC_RAM_STEP_MB = 512;\n' +
  grab(SRC, 'function mcRamLimits(') + '\n' +
  grab(SRC, 'function readJvmArgsRam(') + '\n' +
  grab(SRC, 'function writeJvmArgsRam(') + '\n' +
  grab(SRC, 'function serverRamInfo(') + '\n' +
  "const usesJvmArgsFile = server => server.mcType === 'forge' || server.mcType === 'neoforge';\n" +
  "const userJvmArgsPath = server => path.join(server.installDir, 'user_jvm_args.txt');\n" +
  'exports.mcRamLimits = mcRamLimits; exports.readJvmArgsRam = readJvmArgsRam;' +
  'exports.writeJvmArgsRam = writeJvmArgsRam; exports.serverRamInfo = serverRamInfo;'
)(mod, fs, path, require);
const { mcRamLimits, readJvmArgsRam, writeJvmArgsRam, serverRamInfo } = mod;

// ── the slider's bounds ─────────────────────────────────────────────────────
const lim = mcRamLimits();
const totalMb = Math.floor(os.totalmem() / (1024 * 1024));
check('total is this machine’s RAM', lim.totalMb, totalMb);
check('the floor is 512MB', lim.minMb, 512);
check('the step is 512MB', lim.stepMb, 512);
// The JVM reserves the whole heap up front, so the max must leave headroom.
check('the max leaves the OS room', lim.maxMb < lim.totalMb, true);
check('it reserves at least 2GB', lim.totalMb - lim.maxMb >= 2048, true);
check('the max lands on a step boundary', lim.maxMb % 512, 0);
check('the max is above the floor', lim.maxMb >= lim.minMb, true);

// ── reading Forge/NeoForge's file of record ─────────────────────────────────
const mkServer = (mcType, jvmArgs) => {
  const d = path.join(tmp, 'srv-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  if (jvmArgs !== undefined) fs.writeFileSync(path.join(d, 'user_jvm_args.txt'), jvmArgs);
  return { installDir: d, mcType, game: 'Minecraft' };
};

check('reads -Xmx in gigabytes', readJvmArgsRam(mkServer('neoforge', '-Xmx6G\n')), 6144);
check('reads -Xmx in megabytes', readJvmArgsRam(mkServer('neoforge', '-Xmx3072M\n')), 3072);
check('reads a lowercase suffix', readJvmArgsRam(mkServer('neoforge', '-Xmx4g\n')), 4096);
// NeoForge ships this file with the example commented out. Honouring the
// comment would report a heap the server is not actually using.
check('a commented-out example is not a value',
  readJvmArgsRam(mkServer('neoforge', '# -Xmx4G\n# comment\n')), null);
check('the first real value wins over a later one',
  readJvmArgsRam(mkServer('neoforge', '# -Xmx1G\n-Xmx8G\n-Xmx2G\n')), 8192);
check('other arguments are ignored',
  readJvmArgsRam(mkServer('neoforge', '-XX:+UseG1GC\n-Dsomething=1\n')), null);
check('a missing file is not an error', readJvmArgsRam(mkServer('neoforge')), null);

// ── writing it back ─────────────────────────────────────────────────────────
// Everything that is not a heap argument has to survive, including the comments
// NeoForge puts there to explain the file to whoever opens it.
const keepMe = '# Xmx and Xms set the maximum and minimum RAM usage.\n-XX:+UseG1GC\n-Xmx2G\n-Xms256M\n-Dfile.encoding=UTF-8\n';
const srvW = mkServer('neoforge', keepMe);
writeJvmArgsRam(srvW, 6144);
const after = fs.readFileSync(path.join(srvW.installDir, 'user_jvm_args.txt'), 'utf8');
check('the new heap is written', /-Xmx6144M/.test(after), true);
check('Xms is scaled down to fit', /-Xms512M/.test(after), true);
check('the old -Xmx is gone', /-Xmx2G/.test(after), false);
check('the old -Xms is gone', /-Xms256M/.test(after), false);
check('other JVM flags survive', after.includes('-XX:+UseG1GC'), true);
check('other -D flags survive', after.includes('-Dfile.encoding=UTF-8'), true);
check('the file’s comments survive', after.includes('# Xmx and Xms set'), true);
check('exactly one -Xmx remains', (after.match(/-Xmx/g) || []).length, 1);
// Writing twice must not stack up duplicate arguments.
writeJvmArgsRam(srvW, 4096);
const twice = fs.readFileSync(path.join(srvW.installDir, 'user_jvm_args.txt'), 'utf8');
check('a second write replaces rather than appends', (twice.match(/-Xmx/g) || []).length, 1);
check('the second value took', /-Xmx4096M/.test(twice), true);
// Below 512MB the Xms must not exceed the Xmx, or the JVM refuses to start.
const srvSmall = mkServer('forge', '');
writeJvmArgsRam(srvSmall, 512);
const small = fs.readFileSync(path.join(srvSmall.installDir, 'user_jvm_args.txt'), 'utf8');
check('Xms never exceeds Xmx', /-Xmx512M/.test(small) && /-Xms512M/.test(small), true);
// A server that has no file yet still gets one.
const srvNew = mkServer('neoforge');
writeJvmArgsRam(srvNew, 8192);
check('a missing file is created', readJvmArgsRam(srvNew), 8192);

// ── what a server will actually launch with ─────────────────────────────────
check('an explicit allocation wins', serverRamInfo({ ...mkServer('fabric'), ramMb: 6144 }).mb, 6144);
check('and is reported as chosen', serverRamInfo({ ...mkServer('fabric'), ramMb: 6144 }).source, 'set');
// Unchanged behaviour for every server that has never set one: 2GB, as before.
check('a vanilla server defaults to 2GB', serverRamInfo(mkServer('vanilla')).mb, 2048);
check('a fabric server defaults to 2GB', serverRamInfo(mkServer('fabric')).mb, 2048);
check('that default is labelled as such', serverRamInfo(mkServer('fabric')).source, 'default');
// Forge/NeoForge report what their own file says, not our default.
check('neoforge reports its file’s value', serverRamInfo(mkServer('neoforge', '-Xmx10G\n')).mb, 10240);
check('and says where that came from', serverRamInfo(mkServer('neoforge', '-Xmx10G\n')).source, 'jvmargs');
// With no -Xmx anywhere, run.bat lets the JVM take about a quarter of the
// machine. Reporting 2GB there would be a straight lie.
const jd = serverRamInfo(mkServer('neoforge', '# nothing set\n'));
check('an unset neoforge server reports the JVM default', jd.source, 'jvmdefault');
check('which is about a quarter of this machine',
  Math.abs(jd.mb - totalMb / 4) <= 512, true);

// ── it reaches the launch ───────────────────────────────────────────────────
const start = SRC.slice(SRC.indexOf('Modern Forge / NeoForge (1.17+): no runnable jar'));
const launch = start.slice(0, 1800);
check('the hardcoded -Xmx2G is gone', SRC.includes("'-Xmx2G'"), false);
check('the jar launch uses the allocation', launch.includes('serverRamInfo(server).mb'), true);
check('Xms is clamped to the heap at launch', launch.includes('Math.min(512, heapMb)'), true);
// run.bat ignores our args entirely, so the file is refreshed on every start.
check('run.bat servers sync the file on start', launch.includes('writeJvmArgsRam(server, server.ramMb)'), true);
check('and only when a value was actually set', launch.includes('Number.isFinite(server.ramMb)'), true);

// ── the IPC pair ────────────────────────────────────────────────────────────
const getH = SRC.slice(SRC.indexOf("ipcMain.handle('get-server-ram'"));
const get = getH.slice(0, getH.indexOf('\n});\n'));
check('get-server-ram refuses a non-Minecraft server', get.includes("server.game !== 'Minecraft'"), true);
check('get-server-ram ships the slider bounds', get.includes('...mcRamLimits()'), true);
const setH = SRC.slice(SRC.indexOf("ipcMain.handle('set-server-ram'"));
const set = setH.slice(0, setH.indexOf('\n});\n'));
check('set-server-ram clamps to the limits', set.includes('want < minMb || want > maxMb'), true);
check('set-server-ram snaps to the step', set.includes('Math.round(Number(mb) / MC_RAM_STEP_MB) * MC_RAM_STEP_MB'), true);
check('set-server-ram persists', set.includes('saveData()'), true);
check('set-server-ram updates the jvm args file', set.includes('writeJvmArgsRam(server, want)'), true);
check('set-server-ram says when a restart is needed', set.includes('restartNeeded'), true);

// ── the renderer wiring ─────────────────────────────────────────────────────
const APP = source('renderer/app.js');
check('the section is rendered outside the basic panel', APP.includes("if (scope !== 'basic') loadMcRamSection();"), true);
check('the slider saves on release, not on drag', APP.includes('onchange="saveMcRam(this.value)"'), true);
check('the readout updates during the drag', APP.includes('oninput="onMcRamInput(this.value)"'), true);
const PRE = source('preload.js');
check('getServerRam is exposed', PRE.includes("getServerRam:"), true);
check('setServerRam is exposed', PRE.includes("setServerRam:"), true);
check('the slider is styled', source('renderer/style.css').includes('.ram-slider'), true);

fs.rmSync(tmp, { recursive: true, force: true });
report(state);
