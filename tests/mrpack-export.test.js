// .mrpack export. The zip container is written by hand (no zip dependency), so
// the important thing is that it is a REAL archive another tool can open — not
// just bytes that look right. These tests extract it with PowerShell and parse
// the index back out.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');
const mod = {};
new Function('exports', 'zlib', 'Buffer', 'fs', 'path',
  SRC.slice(SRC.indexOf('const CRC_TABLE = ('), SRC.indexOf('\n// Modrinth names the loader dependency')) +
  '\n' + grab(SRC, 'function detectLoaderVersion(') +
  '\nexports.crc32 = crc32; exports.zipBuffer = zipBuffer; exports.detectLoaderVersion = detectLoaderVersion;'
)(mod, zlib, Buffer, fs, path);
const { crc32, zipBuffer, detectLoaderVersion } = mod;

// ── crc32 against known values ──────────────────────────────────────────────
check('crc32 of empty', crc32(Buffer.from('')), 0);
check('crc32 of "123456789"', crc32(Buffer.from('123456789')), 0xCBF43926);
check('crc32 of "a"', crc32(Buffer.from('a')), 0xE8B7BE43);

// ── the archive is real ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrpack-'));
const INDEX = JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'Test', files: [], dependencies: { minecraft: '1.21.1' } }, null, 2);
const JAR = Buffer.from('not really a jar, but binary enough \u0000\u0001\u0002');
const zip = zipBuffer([
  { name: 'modrinth.index.json', data: Buffer.from(INDEX, 'utf8') },
  { name: 'overrides/mods/local-mod.jar', data: JAR },
]);

check('starts with the local file header magic', zip.readUInt32LE(0), 0x04034b50);
check('ends with the end-of-central-directory magic',
  zip.readUInt32LE(zip.length - 22), 0x06054b50);
check('records both entries', zip.readUInt16LE(zip.length - 22 + 10), 2);
// Entry names must use forward slashes or the Modrinth app and Prism mis-read them.
check('entry paths use forward slashes', zip.includes(Buffer.from('overrides/mods/local-mod.jar')), true);
check('no backslash paths', zip.includes(Buffer.from('overrides\\mods')), false);

// Extract it with a tool that did not write it.
const zipPath = path.join(tmp, 'pack.zip');          // .zip so Expand-Archive accepts it
const outDir = path.join(tmp, 'out');
fs.writeFileSync(zipPath, zip);
let extracted = false;
try {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`], { stdio: 'pipe' });
  extracted = true;
} catch (e) { /* reported below */ }
check('PowerShell can extract it', extracted, true);
if (extracted) {
  check('the index survives extraction', fs.existsSync(path.join(outDir, 'modrinth.index.json')), true);
  check('the override survives at its nested path', fs.existsSync(path.join(outDir, 'overrides', 'mods', 'local-mod.jar')), true);
  check('the index round-trips byte for byte', fs.readFileSync(path.join(outDir, 'modrinth.index.json'), 'utf8'), INDEX);
  check('the binary override round-trips', fs.readFileSync(path.join(outDir, 'overrides', 'mods', 'local-mod.jar')).equals(JAR), true);
  check('the extracted index parses as JSON', JSON.parse(fs.readFileSync(path.join(outDir, 'modrinth.index.json'), 'utf8')).formatVersion, 1);
}
check('an empty archive is still well-formed', (() => {
  const z = zipBuffer([]);
  return z.readUInt32LE(0) === 0x06054b50 && z.length === 22;
})(), true);

// ── loader version detection ────────────────────────────────────────────────
const mkServer = (mcType, ...libPath) => {
  const d = path.join(tmp, 'srv-' + mcType + '-' + Math.random().toString(36).slice(2, 6));
  if (libPath.length) fs.mkdirSync(path.join(d, ...libPath), { recursive: true });
  else fs.mkdirSync(d, { recursive: true });
  return { installDir: d, mcType };
};
check('neoforge version read from libraries',
  detectLoaderVersion(mkServer('neoforge', 'libraries', 'net', 'neoforged', 'neoforge', '21.1.252')), '21.1.252');
// Forge stores <mc>-<loader>; only the loader part belongs in the pack.
check('forge version strips the mc prefix',
  detectLoaderVersion(mkServer('forge', 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0')), '47.3.0');
check('fabric loader version read',
  detectLoaderVersion(mkServer('fabric', 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.16.9')), '0.16.9');
check('quilt loader version read',
  detectLoaderVersion(mkServer('quilt', 'libraries', 'org', 'quiltmc', 'quilt-loader', '0.26.0')), '0.26.0');
check('vanilla has no loader version', detectLoaderVersion(mkServer('vanilla')), null);
check('a missing libraries tree is survivable', detectLoaderVersion(mkServer('neoforge')), null);

// ── the handler's shape, checked against the source ─────────────────────────
// grab() would match the destructured { serverId } parameter rather than the
// body, so slice this handler by its closing line instead.
const hStart = SRC.indexOf("ipcMain.handle('export-modpack'");
const CLOSE = String.fromCharCode(10) + "});" + String.fromCharCode(10);
const handler = SRC.slice(hStart, SRC.indexOf(CLOSE, hStart));
check('refuses a non-Minecraft server', handler.includes("server.game !== 'Minecraft'"), true);
check('refuses a loaderless server', handler.includes('A .mrpack needs a mod loader'), true);
check('fetches hashes from Modrinth by version id', handler.includes('api.modrinth.com/v2/version/'), true);
check('records both sha1 and sha512', handler.includes('sha1: f.hashes.sha1') && handler.includes('sha512: f.hashes.sha512'), true);
check('unmatched jars become overrides', handler.includes('overrides/mods/'), true);
check('index declares formatVersion 1', handler.includes('formatVersion: 1'), true);
check('minecraft version is always a dependency', handler.includes("minecraft: server.mcVersion"), true);
check('loader key is mapped, not guessed', SRC.includes("MRPACK_LOADER_KEY = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' }"), true);
check('a cancelled save dialog is not an error', handler.includes('canceled: true'), true);

fs.rmSync(tmp, { recursive: true, force: true });
report(state);
