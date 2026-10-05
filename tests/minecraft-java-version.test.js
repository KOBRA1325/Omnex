// Which Java a Minecraft server runs on.
//
// This used to be hardcoded to 25 for every version. Vanilla tolerates a newer
// JRE, so it looked fine — until a modded server pinned its Java major and died:
//   Mod 'Cobblemon' 1.8.1+1.21.1 requires version 21 of 'java', but only the
//   wrong version is present: 25!
// Fabric's `depends java @ [21]` means 21.x, not "21 or later". So the mapping
// below is checked against what Minecraft itself declares in its version
// metadata (javaVersion.majorVersion), and the version picked has to match
// exactly in BOTH directions — too new is as broken as too old.
const { EventEmitter } = require('events');
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');

// ── a scriptable stand-in for child_process.spawn ───────────────────────────
let scripted = { out: '', code: 0 };   // or the strings 'throw' / 'error'
const calls = [];
function fakeSpawn(exe, args, opts) {
  calls.push({ exe, args, opts });
  if (scripted === 'throw') throw new Error('spawn refused');
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  setImmediate(() => {
    if (scripted === 'error') return p.emit('error', new Error('ENOENT'));
    // Real java writes its -version banner to stderr, not stdout.
    if (scripted.out) p.stderr.emit('data', Buffer.from(scripted.out));
    p.emit('close', scripted.code === undefined ? 0 : scripted.code);
  });
  return p;
}

const mod = {};
new Function('exports', 'spawn', 'console',
  grab(SRC, 'function getRequiredJavaVersion(') + '\n' +
  grab(SRC, 'function javaMajorOf(') + '\n' +
  grab(SRC, 'async function getSystemJava(') + '\n' +
  'exports.getRequiredJavaVersion = getRequiredJavaVersion;' +
  'exports.javaMajorOf = javaMajorOf; exports.getSystemJava = getSystemJava;'
)(mod, fakeSpawn, { log() {} });
const { getRequiredJavaVersion, javaMajorOf, getSystemJava } = mod;

// ── the table, against Mojang's own javaVersion.majorVersion ────────────────
// Read from version_manifest_v2.json on 2026-10-04. 1.17 is the one deliberate
// deviation: the game asks for 16, Omnex provisions 17 (Adoptium has no current
// 16 build, and 17 is where the mod ecosystem went).
const FROM_MOJANG = [
  ['1.7.10', 8], ['1.12.2', 8], ['1.16.5', 8],
  ['1.17', 17], ['1.17.1', 17],
  ['1.18.2', 17], ['1.19.4', 17], ['1.20.1', 17], ['1.20.4', 17],
  ['1.20.6', 21], ['1.21', 21], ['1.21.1', 21], ['1.21.4', 21], ['1.21.8', 21], ['1.21.11', 21],
  ['26.3', 25], ['26.4', 25],
];
for (const [mc, java] of FROM_MOJANG) {
  check('Minecraft ' + mc + ' needs Java ' + java, getRequiredJavaVersion(mc), java);
}
// The exact boundary where the game moved from 17 to 21.
check('1.20.4 is still Java 17', getRequiredJavaVersion('1.20.4'), 17);
check('1.20.5 is the switch to Java 21', getRequiredJavaVersion('1.20.5'), 21);

// The regression itself: the Cobblemon server that crashed on startup.
check('Cobblemon on 1.21.1 gets Java 21, not 25', getRequiredJavaVersion('1.21.1'), 21);

// ── version strings that are not clean releases ─────────────────────────────
check('a snapshot of the 2026 line', getRequiredJavaVersion('26.4-snapshot-2'), 25);
check('a pre-release keeps its base version', getRequiredJavaVersion('1.21.1-pre1'), 21);
check('"latest" falls back to 21', getRequiredJavaVersion('latest'), 21);
check('an empty version falls back to 21', getRequiredJavaVersion(''), 21);
check('undefined falls back to 21', getRequiredJavaVersion(undefined), 21);
check('null falls back to 21', getRequiredJavaVersion(null), 21);
check('surrounding whitespace is tolerated', getRequiredJavaVersion('  1.20.1 '), 17);
check('a bare major still returns a number', typeof getRequiredJavaVersion('1'), 'number');
// Future-proofing: a year-style version past 26 must never drop back to 21.
check('a later year-style version does not regress', getRequiredJavaVersion('27.1') >= 25, true);

// ── reading a JRE's major out of the binary ─────────────────────────────────
(async () => {
  scripted = { out: 'openjdk version "21.0.5" 2024-10-15 LTS\nOpenJDK Runtime Environment Temurin-21.0.5+11\n', code: 0 };
  check('parses a modern version banner', await javaMajorOf('java'), 21);

  scripted = { out: 'openjdk version "25.0.4.1" 2026-01-20 LTS\n', code: 0 };
  check('parses a four-part version', await javaMajorOf('java'), 25);

  // Java 8 and earlier report "1.8.0_432" — the major is the SECOND number.
  scripted = { out: 'openjdk version "1.8.0_432"\nOpenJDK Runtime Environment (Temurin)(build 1.8.0_432-b06)\n', code: 0 };
  check('parses the legacy 1.8 form as 8', await javaMajorOf('java'), 8);

  scripted = { out: 'java version "17.0.13" 2024-10-15 LTS\n', code: 0 };
  check('parses an Oracle-style banner', await javaMajorOf('java'), 17);

  // Anything that is not Java has to come back null, never a wrong number.
  scripted = { out: 'v24.14.1\n', code: 0 };
  check('unrecognised output is null', await javaMajorOf('somethingelse'), null);
  scripted = { out: 'openjdk version "21.0.5"\n', code: 1 };
  check('a non-zero exit is null', await javaMajorOf('java'), null);
  scripted = 'error';
  check('a spawn error is null', await javaMajorOf('C:/nope/java.exe'), null);
  scripted = 'throw';
  check('a throwing spawn is null', await javaMajorOf('C:/nope/java.exe'), null);

  // A bare "java" has to go through a shell to resolve on PATH; an explicit
  // path must not, or Windows quoting mangles it.
  calls.length = 0;
  scripted = { out: 'openjdk version "21.0.5"\n', code: 0 };
  await javaMajorOf('java');
  check('a bare "java" resolves via the shell', calls[0].opts.shell, true);
  calls.length = 0;
  await javaMajorOf('C:/srv/_java/jdk-21/bin/java.exe');
  check('an explicit path does not use the shell', calls[0].opts.shell, false);
  check('only -version is ever passed', calls[0].args, ['-version']);

  // ── the system Java is accepted only on an exact match ────────────────────
  scripted = { out: 'openjdk version "21.0.5"\n', code: 0 };
  check('system Java 21 is used for a Java 21 server', await getSystemJava(21), 'java');
  check('system Java 21 is rejected for a Java 25 server', await getSystemJava(25), null);
  check('system Java 21 is rejected for a Java 17 server', await getSystemJava(17), null);
  scripted = { out: 'openjdk version "25.0.4.1"\n', code: 0 };
  check('a newer system Java is not substituted', await getSystemJava(21), null);
  scripted = 'error';
  check('no system Java at all is null', await getSystemJava(21), null);

  // ── ensureJava replaces a mismatched bundled JRE ──────────────────────────
  const ensure = grab(SRC, 'async function ensureJava(');
  check('the bundled JRE is identified by asking it', ensure.includes('await javaMajorOf(server.javaExe)'), true);
  check('it is kept only on an exact match', ensure.includes('if (have === requiredVersion)'), true);
  // The old test was "older than required", which left a too-NEW JRE in place —
  // exactly the Cobblemon failure. It must be gone, not merely supplemented.
  check('the old "older than required" test is gone', /older than required/.test(ensure), false);
  check('the stale jdk- path regex is gone', ensure.includes('staleRe'), false);
  // Safety: only a JRE Omnex itself unpacked under <server>/_java may be deleted.
  check('only Omnex\u2019s own _java folder is removed',
    ensure.includes('stale.startsWith(oldJavaDir + path.sep)'), true);
  check('the removal stays inside the server folder',
    ensure.includes("path.join(server.installDir, '_java')"), true);

  // ── the Forge/NeoForge run script gets the same Java ──────────────────────
  // run.bat invokes plain `java`, so the chosen JRE has to be first on PATH.
  // Anchored on the log line, which is unique — the 'Modern Forge / NeoForge'
  // comment also appears in findMinecraftJar.
  const j = SRC.indexOf('Forge/NeoForge launch script detected');
  const startBlock = SRC.slice(j - 900, j + 100);
  check('a real Java path is prepended to PATH', startBlock.includes('javaDir + path.delimiter'), true);
  // path.dirname('java') is '.', which used to be prepended to PATH for nothing.
  check('a bare "java" is not turned into a "." PATH entry',
    startBlock.includes('javaExe.includes(path.sep) ? path.dirname(javaExe) : null'), true);

  // ── check-java reports what is actually there ─────────────────────────────
  const h = SRC.slice(SRC.indexOf("ipcMain.handle('check-java'"));
  const handler = h.slice(0, h.indexOf('\n});\n'));
  check('check-java reads the real major off the bundled JRE',
    handler.includes('await javaMajorOf(server.javaExe)'), true);
  check('check-java also reports the required major', handler.includes('required,'), true);
  // The renderer used to pass a bare id into a destructured { serverId }, so the
  // handler always saw undefined and reported the wrong thing.
  check('check-java tolerates a bare id', handler.includes("typeof opts === 'string'"), true);
  check('the renderer passes an object', source('renderer/app.js').includes('checkJava({ serverId: id })'), true);

  report(state);
})().catch(e => { console.log('  FAIL  ' + e.stack); process.exit(1); });
