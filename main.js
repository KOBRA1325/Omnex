const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
let steamAuth;
try { steamAuth = require('./steam-auth'); } catch(e) { console.warn('Steam auth library not available'); }
const path   = require('path');
const { spawn } = require('child_process');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const net    = require('net');

// ── Paths ────────────────────────────────────────────────────────────────────
const USER_DATA    = app.getPath('userData');
const SERVERS_DIR  = path.join(USER_DATA, 'servers');
const STEAMCMD_DIR = path.join(USER_DATA, 'steamcmd');
const STEAMCMD_EXE = path.join(STEAMCMD_DIR, 'steamcmd.exe');
const DATA_FILE    = path.join(USER_DATA, 'servers.json');
const APP_VERSION  = app.getVersion(); // from package.json

fs.mkdirSync(SERVERS_DIR,  { recursive: true });
fs.mkdirSync(STEAMCMD_DIR, { recursive: true });


// ── Java management ───────────────────────────────────────────────────────────
// Java version requirements per Minecraft version range
function getRequiredJavaVersion(mcVersion) {
  // Always use Java 21 for Minecraft — it's the current LTS and
  // required for all versions 1.17+. Older versions also run fine on 21.
  // Never download Java 8 or 17 as modern MC won't start on them.
  return 21;
}

async function getJavaDownloadUrl(javaVersion, serverId) {
  // Use Adoptium API to get the actual direct download URL first
  try {
    log(serverId, 'dim', `Resolving Java ${javaVersion} download URL...`);
    const apiUrl = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;
    const data = await fetchJSON(apiUrl);
    if (data && data[0] && data[0].binary && data[0].binary.package && data[0].binary.package.link) {
      const url = data[0].binary.package.link;
      log(serverId, 'dim', `Resolved: ${url}`);
      return url;
    }
  } catch(e) {
    log(serverId, 'warn', `API lookup failed (${e.message}), using fallback URLs`);
  }

  // Fallback: known stable direct GitHub release URLs
  const fallbacks = {
    21: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jre_x64_windows_hotspot_21.0.5_11.zip',
    17: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jre_x64_windows_hotspot_17.0.13_11.zip',
    11: 'https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.25%2B9/OpenJDK11U-jre_x64_windows_hotspot_11.0.25_9.zip',
    8:  'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u432-b06/OpenJDK8U-jre_x64_windows_hotspot_8u432b06.zip',
  };
  return fallbacks[javaVersion] || fallbacks[21];
}

// Check if system Java meets the required version
async function getSystemJava(requiredVersion) {
  return new Promise(resolve => {
    const p = spawn('java', ['-version'], { shell: true });
    let output = '';
    p.stderr.on('data', d => output += d.toString());
    p.stdout.on('data', d => output += d.toString());
    p.on('close', code => {
      if (code !== 0) return resolve(null);
      // Match both "21.0.x" and "1.8.x" style version strings
      const match = output.match(/version "(\d+)(?:\.(\d+))?/);
      if (!match) return resolve(null);
      const major = parseInt(match[1]);
      const actual = major === 1 ? parseInt(match[2] || '0') : major;
      console.log(`[Omnex] System Java version: ${actual} (required: ${requiredVersion})`);
      // Must be EXACTLY the required version or higher - for MC we need 21
      resolve(actual >= requiredVersion ? 'java' : null);
    });
    p.on('error', () => resolve(null));
  });
}

// Get or install Java for a specific server
async function ensureJava(serverId, mcVersion) {
  const requiredVersion = getRequiredJavaVersion(mcVersion);
  const server = appData.servers.find(s => s.id === serverId);

  // 1. Check server-local Java — verify path contains jdk-21 or run version check
  if (server?.javaExe && fs.existsSync(server.javaExe)) {
    // Quick check: if path contains a version number less than 21, reject it
    const pathHasOldVer = /jdk-(8|9|10|11|12|13|14|15|16|17|18|19|20)[.\-+]/.test(server.javaExe);
    if (pathHasOldVer) {
      log(serverId, 'warn', `Cached Java path indicates wrong version (${server.javaExe}), clearing...`);
      server.javaExe = null;
      const oldJavaDir = path.join(server.installDir, '_java');
      if (fs.existsSync(oldJavaDir)) {
        try { fs.rmSync(oldJavaDir, { recursive: true, force: true }); } catch(e) {}
      }
      saveData();
    } else {
      log(serverId, 'dim', `Using bundled Java 21 for this server.`);
      return server.javaExe;
    }
  }

  // 2. Check system Java
  const systemJava = await getSystemJava(requiredVersion);
  if (systemJava) {
    log(serverId, 'success', `✔ System Java ${requiredVersion}+ found.`);
    return systemJava;
  }

  // 3. Download Java into the server's own folder
  const javaDir = path.join(server.installDir, '_java');
  fs.mkdirSync(javaDir, { recursive: true });

  log(serverId, 'warn',  `Java ${requiredVersion} required for Minecraft ${mcVersion || 'latest'}.`);
  log(serverId, 'info',  `Downloading Java ${requiredVersion} JRE... (~120MB, stored with this server)`);
  log(serverId, 'dim',   'It will be removed automatically if you delete this server.');

  // Use the zip endpoint with explicit OS/arch params
  const url = await getJavaDownloadUrl(requiredVersion, serverId);
  const javaZip = path.join(javaDir, 'java.zip');

  log(serverId, 'dim', `Fetching from: ${url}`);
  await downloadFile(url, javaZip, pct => {
    const filled = Math.floor(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    emit('console-progress', { serverId, text: `☕ Java ${requiredVersion}  [${bar}] ${pct}%` });
  });

  // Verify the zip actually downloaded
  const zipSize = fs.statSync(javaZip).size;
  log(serverId, 'dim', `Downloaded ${Math.round(zipSize / 1024 / 1024)}MB`);
  if (zipSize < 1024 * 1024) {
    // Too small — probably got an error page instead of a zip
    const content = fs.readFileSync(javaZip, 'utf8').slice(0, 200);
    log(serverId, 'error', `Download seems invalid: ${content}`);
    throw new Error(`Java download failed - file too small (${zipSize} bytes). Check internet connection.`);
  }

  log(serverId, 'info', 'Extracting Java...');
  await extractZip(javaZip, javaDir);

  // Delete the zip immediately to save space
  try { fs.unlinkSync(javaZip); } catch(e) {}

  // Recursively find java.exe anywhere under javaDir
  let javaExe = null;
  const scan = (dir, depth = 0) => {
    if (depth > 8 || javaExe) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    for (const entry of entries) {
      if (javaExe) break;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'java.exe') {
        javaExe = full;
      } else if (entry.isDirectory()) {
        scan(full, depth + 1);
      }
    }
  };
  scan(javaDir);

  // Last resort: check common Adoptium paths manually
  if (!javaExe) {
    try {
      const topDirs = fs.readdirSync(javaDir, { withFileTypes: true }).filter(e => e.isDirectory());
      log(serverId, 'dim', `Top-level extracted dirs: ${topDirs.map(d => d.name).join(', ')}`);
      for (const dir of topDirs) {
        const candidate = path.join(javaDir, dir.name, 'bin', 'java.exe');
        if (fs.existsSync(candidate)) { javaExe = candidate; break; }
        // Some builds nest one level deeper
        const subDirs = fs.readdirSync(path.join(javaDir, dir.name), { withFileTypes: true }).filter(e => e.isDirectory());
        for (const sub of subDirs) {
          const deep = path.join(javaDir, dir.name, sub.name, 'bin', 'java.exe');
          if (fs.existsSync(deep)) { javaExe = deep; break; }
        }
        if (javaExe) break;
      }
    } catch(e) { log(serverId, 'warn', `Scan error: ${e.message}`); }
  }

  if (!javaExe) {
    throw new Error(`Java ${requiredVersion} extracted but java.exe not found. The Adoptium download may have changed format.`);
  }

  // Save java path on the server record
  if (server) { server.javaExe = javaExe; saveData(); }

  log(serverId, 'success', `✔ Java ${requiredVersion} ready: ${javaExe}`);
  return javaExe;
}


// ── Taskbar badge ─────────────────────────────────────────────────────────────
function updateTaskbarBadge() {
  if (!mainWindow) return;
  const runningCount = Object.keys(serverProcesses).length;
  if (runningCount === 0) {
    mainWindow.setOverlayIcon(null, '');
  } else {
    // Create a small canvas-based badge image
    const { nativeImage } = require('electron');
    const { createCanvas } = (() => { try { return require('canvas'); } catch(e) { return null; } })() || {};
    
    if (createCanvas) {
      const size   = 16;
      const canvas = createCanvas(size, size);
      const ctx    = canvas.getContext('2d');
      ctx.fillStyle = runningCount > 0 ? '#39ff6e' : '#ff3b5c';
      ctx.beginPath();
      ctx.arc(size/2, size/2, size/2, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(runningCount), size/2, size/2);
      const img = nativeImage.createFromDataURL(canvas.toDataURL());
      mainWindow.setOverlayIcon(img, `${runningCount} server${runningCount !== 1 ? 's' : ''} running`);
    } else {
      // Fallback: use app badge count (works on Windows 11)
      try { app.setBadgeCount(runningCount); } catch(e) {}
      mainWindow.setOverlayIcon(null, `${runningCount} running`);
    }
  }
  // Also update title bar
  mainWindow.setTitle(`Omnex${runningCount > 0 ? ` · ${runningCount} running` : ''}`);
}


// ── System Tray ───────────────────────────────────────────────────────────────
let tray = null;

function buildTrayMenu() {
  const { Menu, MenuItem } = require('electron');
  const running = appData.servers.filter(s => serverProcesses[s.id]);
  const stopped = appData.servers.filter(s => !serverProcesses[s.id]);
  const items = [];

  items.push({ label: 'Omnex — Game Server Manager', enabled: false });
  items.push({ type: 'separator' });

  if (appData.servers.length === 0) {
    items.push({ label: 'No servers configured', enabled: false });
  } else {
    if (running.length) {
      items.push({ label: `● ${running.length} server${running.length>1?'s':''} running`, enabled: false });
      running.forEach(s => {
        items.push({
          label: `  ■ ${s.name}`,
          submenu: [
            { label: 'Stop',    click: () => killServer(s.id) },
            { label: 'Restart', click: async () => { await killServer(s.id); setTimeout(() => startServerById(s.id), 2000); } },
          ]
        });
      });
      items.push({ type: 'separator' });
    }
    stopped.forEach(s => {
      items.push({ label: `  ▷ ${s.name}`, click: () => startServerById(s.id) });
    });
    if (stopped.length) items.push({ type: 'separator' });
  }

  items.push({ label: 'Open Omnex', click: () => { mainWindow?.show(); mainWindow?.focus(); } });
  items.push({ label: 'Quit',       click: () => { Object.keys(serverProcesses).forEach(killServer); app.quit(); } });

  return Menu.buildFromTemplate(items);
}

function setupTray() {
  const { Tray, nativeImage } = require('electron');
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    const icon = nativeImage.createFromPath(iconPath).resize({ width:16, height:16 });
    tray = new Tray(icon);
    tray.setToolTip('Omnex');
    tray.setContextMenu(buildTrayMenu());
    tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
    tray.on('click',        () => tray.setContextMenu(buildTrayMenu()));
    setInterval(() => { try { tray?.setContextMenu(buildTrayMenu()); } catch(e){} }, 5000);
  } catch(e) { console.error('Tray failed:', e.message); }
}

// ── Game definitions ─────────────────────────────────────────────────────────
const GAME_DEFS = {
  'Minecraft':       { type:'minecraft', startExe:'server.jar', useJava:true },
  'CS2':             { type:'steam', serverAppId:'232330', startExe:'srcds.exe',               startArgs:(d,s)=>['-game','cs2','-console','+sv_lan','0','-port',String(s.port||27015)] },
  'Valheim':         { type:'steam', serverAppId:'896660', startExe:'valheim_server.exe',       startArgs:(d,s)=>['-nographics','-batchmode','-name',s.name||'MyServer','-port',String(s.port||2456),'-world','Dedicated','-password','secret','-instpath',d] },
  'Rust':            { type:'steam', serverAppId:'258550', startExe:'RustDedicated.exe',        startArgs:(d,s)=>['-batchmode','+server.port',String(s.port||28015),'+server.maxplayers','50','+rcon.web','1'] },
  'Satisfactory':    { type:'steam', serverAppId:'1690800',startExe:'FactoryServer.exe',        startArgs:(d,s)=>['-Port='+(s.port||15777)] },
  'Project Zomboid': { type:'steam', serverAppId:'380870', startExe:'ProjectZomboidServer.bat', startArgs:(d,s)=>['-port',String(s.port||16261)] },
  'Ark: Survival':   { type:'steam', serverAppId:'376030', startExe:'ShooterGameServer.exe',    startArgs:(d,s)=>[`TheIsland?listen?Port=${s.port||7777}?MaxPlayers=20`,'-server','-log'] },
  'V Rising':        { type:'steam', serverAppId:'1829350',startExe:'VRisingServer.exe',        startArgs:(d,s)=>['-persistentDataPath','./save-data','-serverName',s.name||'My V Rising Server','-port',String(s.port||9876)] },
  'Terraria':        { type:'steam', serverAppId:'105600', startExe:'TerrariaServer.exe',       startArgs:(d,s)=>['-port',String(s.port||7777),'-maxplayers','8'] },
  '7 Days to Die':   { type:'steam', serverAppId:'294420', startExe:'7DaysToDieServer.exe',     startArgs:(d,s)=>[] },
  'Palworld':        { type:'steam', serverAppId:'2394010',startExe:'PalServer-Win64-Shipping-Cmd.exe', startArgs:(d,s)=>{
    const args = ['-port='+(s.port||8211),'-publicport='+(s.port||8211),'-useperfthreads','-NoAsyncLoadingThread','-UseMultithreadForDS'];
    if (s.showInPublicList) { args.push('-publiclobby'); args.push('EpicApp=PalServer'); }
    return args;
  } },
  'Enshrouded':      { type:'steam', serverAppId:'2278520',startExe:'enshrouded_server.exe',    startArgs:(d,s)=>[] },
};

// Games where the real server can detach from the process we spawned, so on Stop
// we also kill by image name as a backstop. ONLY for games that run a single
// instance per machine (Palworld is pinned to Steam query port 27015), so this
// can never accidentally kill a second, unrelated server on the same box.
const FORCE_KILL_IMAGES = {
  'Palworld': ['PalServer-Win64-Shipping-Cmd.exe', 'PalServer-Win64-Shipping.exe', 'PalServer.exe'],
};

// ── Data ─────────────────────────────────────────────────────────────────────
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){}
  return { servers:[], schedules:[] };
}
function saveData() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(appData,null,2)); } catch(e){} }

let appData = loadData();

// Migration: default Palworld servers to community-list enabled unless already set
(function migratePalworldDefaults() {
  let changed = false;
  for (const s of appData.servers || []) {
    if (s.game === 'Palworld' && typeof s.showInPublicList === 'undefined') {
      s.showInPublicList = true;
      changed = true;
    }
  }
  if (changed) saveData();
})();
const serverProcesses = {};

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

// Enforce a single running instance. A second launch focuses the existing
// window and quits — two Omnex instances can never run at once and fight over
// servers.json, PIDs, or each other's server processes.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const isDev = !app.isPackaged;
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 900, minHeight: 600,
    frame: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    backgroundColor: '#0a0c10',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname,'preload.js') },
  });
  // Enable double-click-to-maximize on frameless windows (macOS-like behavior on Windows)
  mainWindow.on('maximize',   () => mainWindow.webContents.send('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', { maximized: false }));
  mainWindow.loadFile(path.join(__dirname,'renderer','index.html'));
  if (isDev) {
    // Open DevTools detached and refocus main window so inputs aren't blocked
    mainWindow.webContents.openDevTools({ mode: 'detach', activate: false });
    setTimeout(() => { mainWindow && mainWindow.focus(); }, 500);

    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.key.toLowerCase() === 'r') {
        mainWindow.webContents.reload();
      }
      if (input.key === 'F12') {
        // Toggle as detached, not docked
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow.webContents.openDevTools({ mode: 'detach', activate: false });
          setTimeout(() => mainWindow.focus(), 300);
        }
      }
    });

    // When DevTools window opens, force focus back to the main window
    mainWindow.webContents.on('devtools-opened', () => {
      setTimeout(() => { mainWindow && mainWindow.focus(); }, 200);
    });
  }
  mainWindow.on('close', e => {
    if (tray && appSettings.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
      tray.setContextMenu(buildTrayMenu());
    } else {
      Object.keys(serverProcesses).forEach(killServer);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}
if (gotSingleInstanceLock) app.whenReady().then(async () => {
  // Kill any servers orphaned by a previous session before showing the UI.
  try { await cleanupOrphanedServers(); } catch(e) {}
  createWindow();
  setupTray();
  initAutoUpdater();
  runStartupUpdateCheck();
  logSystemJavaInfo();
});

app.on('before-quit', () => {
  // Stop stats refresh and force-kill running servers so we don't leave orphans.
  statsCacheTime = 0;
  Object.keys(serverProcesses).forEach(id => {
    const proc = serverProcesses[id];
    try {
      if (process.platform === 'win32' && proc?.pid) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
        const srv = appData.servers.find(s => s.id === id);
        const images = (srv && FORCE_KILL_IMAGES[srv.game]) || [];
        if (images.length) {
          const imgArgs = []; images.forEach(img => { imgArgs.push('/IM', img); });
          spawn('taskkill', ['/F', '/T', ...imgArgs], { windowsHide: true });
        }
      } else {
        proc?.kill('SIGTERM');
      }
    } catch(e) {}
  });
});

async function logSystemJavaInfo() {
  try {
    const result = await new Promise(resolve => {
      const p = spawn('java', ['-version'], { shell: true });
      let out = '';
      p.stderr.on('data', d => out += d.toString());
      p.stdout.on('data', d => out += d.toString());
      p.on('close', () => resolve(out.trim()));
      p.on('error', () => resolve(null));
    });
    if (result) {
      // Get the java executable path
      const which = await new Promise(resolve => {
        const p = spawn('where', ['java'], { shell: true });
        let out = '';
        p.stdout.on('data', d => out += d.toString());
        p.on('close', () => resolve(out.trim()));
        p.on('error', () => resolve('unknown'));
      });
      console.log('[Omnex] System Java detected:');
      console.log('[Omnex] Version:', result.split('\n')[0]);
      console.log('[Omnex] Path:', which.split('\n')[0]);
    } else {
      console.log('[Omnex] No system Java found on PATH');
    }
  } catch(e) {}
}
app.on('window-all-closed', () => { if(process.platform!=='darwin') app.quit(); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function emit(ch, data)          { mainWindow?.webContents.send(ch, data); }
function log(id, type, text)     { emit('console-line', { serverId:id, type, text, ts:new Date().toLocaleTimeString('en-US',{hour12:false}) }); }
function setStatus(id, status)   { const s=appData.servers.find(s=>s.id===id); if(s){s.status=status; saveData(); emit('server-status',{serverId:id,status});} }

// ── App self-update (electron-updater with GitHub-link fallback) ───────────────
// autoUpdater downloads latest.yml + the NSIS installer from the GitHub release
// and can install + relaunch in one click. It only works in a packaged build
// whose release was published by electron-builder (so latest.yml exists) and
// whose releases are publicly downloadable. When any of that isn't true we fall
// back to the classic "open the GitHub releases page" flow.
let autoUpdater = null;
let updaterUsable = false;

function initAutoUpdater() {
  if (!app.isPackaged) return; // electron-updater is a no-op / throws in dev
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch(e) { autoUpdater = null; return; }

  autoUpdater.autoDownload = false;           // wait for the user to click
  autoUpdater.autoInstallOnAppQuit = true;    // if downloaded, finish on next quit
  updaterUsable = true;

  autoUpdater.on('checking-for-update', () => emit('update-status', { status: 'checking' }));
  autoUpdater.on('update-available',   info => emit('update-status', { status: 'available',   version: info?.version }));
  autoUpdater.on('update-not-available', info => emit('update-status', { status: 'none',      version: info?.version }));
  autoUpdater.on('download-progress',  p    => emit('update-status', { status: 'downloading', percent: Math.round(p?.percent || 0) }));
  autoUpdater.on('update-downloaded',  info => emit('update-status', { status: 'downloaded',  version: info?.version }));
  autoUpdater.on('error',              err  => emit('update-status', { status: 'error', error: (err?.message || String(err)) }));
}

// Silent check on launch. If the updater is usable it drives the banner via
// events; otherwise fall back to a plain GitHub API version comparison.
async function runStartupUpdateCheck() {
  if (updaterUsable) { try { await autoUpdater.checkForUpdates(); return; } catch(e) { /* fall through */ } }
  await checkAppUpdateViaGitHub();
}

// Fallback path: compare versions against the latest GitHub release and, if
// newer, tell the renderer to show the manual "download from GitHub" banner.
async function checkAppUpdateViaGitHub() {
  try {
    const data = await fetchJSON('https://api.github.com/repos/KOBRA1325/omnex/releases/latest');
    const latest = data.tag_name?.replace('v','');
    if (latest && latest !== APP_VERSION) {
      emit('app-update-available', { current: APP_VERSION, latest, url: data.html_url });
    }
    return { ok: true, current: APP_VERSION, latest, updateAvailable: !!(latest && latest !== APP_VERSION), url: data.html_url };
  } catch(e) { return { ok: false, current: APP_VERSION, error: e.message }; }
}

// Renderer-triggered check ("Check for updates" button). Returns the mode so the
// renderer knows whether to expect event-driven auto-update or a manual banner.
ipcMain.handle('updater-check', async () => {
  if (updaterUsable) {
    try { await autoUpdater.checkForUpdates(); return { mode: 'auto' }; }
    catch(e) { return { mode: 'manual', ...(await checkAppUpdateViaGitHub()) }; }
  }
  return { mode: 'manual', ...(await checkAppUpdateViaGitHub()) };
});

ipcMain.handle('updater-download', async () => {
  if (!updaterUsable) return { ok: false, error: 'Auto-update not available in this build' };
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('updater-install', () => {
  if (!updaterUsable) return { ok: false, error: 'Auto-update not available in this build' };
  // Kill any running servers first so their processes don't block the installer,
  // then quit and relaunch into the new version.
  Object.keys(serverProcesses).forEach(killServer);
  setTimeout(() => { try { autoUpdater.quitAndInstall(); } catch(e) {} }, 500);
  return { ok: true };
});

ipcMain.on('open-release-page', (e, url) => shell.openExternal(url));

ipcMain.on('tray-rebuild', () => { try { tray?.setContextMenu(buildTrayMenu()); } catch(e){} });

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.on('window-close',    () => mainWindow?.close());

// ── Server data ───────────────────────────────────────────────────────────────
ipcMain.handle('get-servers',   () => appData.servers.map(s => ({...s, status: serverProcesses[s.id]?'online':'offline'})));
ipcMain.handle('get-schedules', () => appData.schedules);
ipcMain.handle('get-app-version', () => APP_VERSION);

ipcMain.handle('remove-server', async (e, id) => {
  if (serverProcesses[id]) await killServer(id);
  const srv = appData.servers.find(s=>s.id===id);
  if (srv) {
    // SAFETY: only ever delete a folder that lives inside Omnex's own SERVERS_DIR.
    // Imports are now COPIED into SERVERS_DIR, so this deletes Omnex's copy and
    // never the user's original. Any server whose folder is outside SERVERS_DIR —
    // e.g. a legacy in-place import from an older version — is left fully untouched.
    const dir = srv.installDir ? path.resolve(srv.installDir) : '';
    const serversRoot = path.resolve(SERVERS_DIR);
    const insideServersDir = dir && (dir === serversRoot || dir.startsWith(serversRoot + path.sep));
    if (insideServersDir && fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
    }
  }
  appData.servers = appData.servers.filter(s=>s.id!==id);
  saveData(); return true;
});

ipcMain.handle('save-schedule',   (e,s)  => { const i=appData.schedules.findIndex(x=>x.id===s.id); if(i>=0) appData.schedules[i]=s; else appData.schedules.push({...s,id:`sched_${Date.now()}`}); saveData(); return appData.schedules; });
ipcMain.handle('toggle-schedule', (e,id) => { const s=appData.schedules.find(s=>s.id===id); if(s){s.active=!s.active; saveData();} return appData.schedules; });
ipcMain.handle('delete-schedule', (e,id) => { appData.schedules=appData.schedules.filter(s=>s.id!==id); saveData(); return appData.schedules; });

// ── Minecraft version/type fetching ──────────────────────────────────────────
ipcMain.handle('get-minecraft-versions', async () => {
  try {
    const manifest = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    // Only proper 1.x.x releases — filter out any snapshots or non-standard versions
    const releases = manifest.versions
      .filter(v => v.type === 'release' && v.id.startsWith('1.'))
      .map(v => v.id);
    return { ok:true, versions: releases };
  } catch(e) { return { ok:false, versions:[] }; }
});

ipcMain.handle('get-paper-versions', async () => {
  try {
    const data = await fetchJSON('https://api.papermc.io/v2/projects/paper');
    return { ok:true, versions: [...data.versions].reverse() };
  } catch(e) { return { ok:false, versions:[] }; }
});

ipcMain.handle('get-fabric-versions', async () => {
  try {
    const data = await fetchJSON('https://meta.fabricmc.net/v2/versions/game');
    const stable = data.filter(v=>v.stable).map(v=>v.version);
    return { ok:true, versions: stable };
  } catch(e) { return { ok:false, versions:[] }; }
});

// ── INSTALL ───────────────────────────────────────────────────────────────────

// Turn a user-provided server name into a safe folder name (Windows/macOS/Linux compatible)
function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return 'server';
  let safe = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')  // strip forbidden chars
    .replace(/\s+/g, '_')                    // spaces → underscores
    .replace(/_+/g, '_')                     // collapse multi underscores
    .replace(/^[._]+|[._]+$/g, '')           // trim leading/trailing dots+underscores
    .slice(0, 60);                           // keep it reasonable
  // Reserved Windows names
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (!safe || reserved.test(safe)) safe = `server_${safe || Date.now()}`;
  return safe;
}
// Guarantee the folder is unique inside SERVERS_DIR by appending _2, _3, etc. if needed
function uniqueInstallDir(baseName) {
  let candidate = path.join(SERVERS_DIR, baseName);
  if (!fs.existsSync(candidate)) return { dir: candidate, folder: baseName };
  let n = 2;
  while (n < 1000) {
    const attempt = `${baseName}_${n}`;
    const dir = path.join(SERVERS_DIR, attempt);
    if (!fs.existsSync(dir)) return { dir, folder: attempt };
    n++;
  }
  // Fallback if something is very wrong: append timestamp
  const fallback = `${baseName}_${Date.now()}`;
  return { dir: path.join(SERVERS_DIR, fallback), folder: fallback };
}

ipcMain.handle('install-server', async (e, config) => {
  const id = `srv_${Date.now()}`;
  const folderBase = sanitizeFolderName(config.name);
  const { dir: installDir } = uniqueInstallDir(folderBase);
  fs.mkdirSync(installDir, { recursive:true });

  const server = { id, name:config.name, game:config.game, icon:config.icon, fallback:config.fallback, port:config.port, installDir, status:'installing', mcType:config.mcType, mcVersion:config.mcVersion, steamPass:config.steamPass };
  // Palworld: default to showing in community server list (users can toggle off in config)
  if (config.game === 'Palworld') server.showInPublicList = true;
  appData.servers.push(server);
  saveData();
  emit('server-added', server);

  try {
    await runInstall(id, server, config);
    setStatus(id, 'offline');
    log(id,'success',`✔ ${config.game} server installed successfully!`);
    log(id,'warn','Press ▶ Start to launch your server.');
    emit('install-complete', { serverId:id });
    return { ok:true, serverId:id };
  } catch(err) {
    setStatus(id, 'error');
    log(id,'error',`Install failed: ${err.message}`);
    emit('install-error', { serverId:id, error:err.message });
    return { ok:false, error:err.message };
  }
});

// ── UPDATE SERVER ─────────────────────────────────────────────────────────────
ipcMain.handle('update-server', async (e, id) => {
  const server = appData.servers.find(s=>s.id===id);
  if (!server) return { ok:false, error:'Server not found' };
  if (serverProcesses[id]) return { ok:false, error:'Stop the server before updating.' };

  setStatus(id, 'updating');
  log(id,'warn',`Updating ${server.name}...`);

  try {
    await runInstall(id, server, { ...server, update:true });
    setStatus(id,'offline');
    log(id,'success',`✔ ${server.name} updated successfully!`);
    emit('install-complete', { serverId:id });
    return { ok:true };
  } catch(err) {
    setStatus(id,'offline');
    log(id,'error',`Update failed: ${err.message}`);
    emit('install-error', { serverId:id, error:err.message });
    return { ok:false, error:err.message };
  }
});

async function runInstall(id, server, config) {
  const def = GAME_DEFS[server.game];
  if (!def) throw new Error('Unknown game');

  if (def.type === 'steam' || def.type === 'steam_auth') {
    await ensureSteamCmd(id);
    // Provision the Visual C++ runtime that Steam servers need to launch.
    await ensureVCRedist(id);

    // Prepare Steam login (only for games that require an account).
    let username = '', password = '';
    if (def.type === 'steam_auth') {
      const creds = loadSteamCreds();
      username = creds.username || '';
      password = creds.password || '';
      if (!username || !password) {
        emit('install-needs-auth', { serverId: id });
        throw new Error('Steam account not connected. Go to Settings → Connections to connect your Steam account.');
      }
      log(id, 'info', `Using Steam account: ${username}`);
    }

    // Run SteamCMD, retrying if the server exe never appears. SteamCMD frequently
    // self-updates on the first run and doesn't finish the app download in one
    // pass (leaving a partial folder), so a second/third pass resumes and completes
    // it. Real auth errors reject and break out of the loop without retrying.
    const MAX_STEAM_ATTEMPTS = 3;
    let exePath = '';
    for (let attempt = 1; attempt <= MAX_STEAM_ATTEMPTS; attempt++) {
      if (attempt > 1) log(id, 'warn', `⚠ SteamCMD didn't finish the download — retrying (attempt ${attempt}/${MAX_STEAM_ATTEMPTS})...`);
      if (def.type === 'steam_auth') {
        await installViaSteamCmdAuth(id, server.installDir, def.serverAppId, server.game, username, password, '');
      } else {
        await installViaSteamCmd(id, server.installDir, def.serverAppId, server.game);
      }
      exePath = findExe(server.installDir, def.startExe);
      if (exePath) break;
    }
    if (def.type === 'steam_auth') delete server.steamPass; // clear stored password

    server.execPath = exePath || '';
    // Don't bake args at install time - regenerate them at start time so port changes apply
    server.args     = '';

    // Sync user's chosen name and port to per-game config files
    if (exePath) syncServerConfig(id, server, /* isInstall */ true);

    // CRITICAL: verify the install actually worked
    if (!exePath) {
      // Look for what's actually in the install dir
      let contents = [];
      try { contents = fs.readdirSync(server.installDir); } catch(e) {}
      log(id, 'error', `❌ Install completed but ${def.startExe} not found in ${server.installDir}`);
      log(id, 'error', `   Folder contents: ${contents.length > 0 ? contents.join(', ') : '(empty)'}`);
      log(id, 'error', `   SteamCMD did not finish downloading after ${MAX_STEAM_ATTEMPTS} attempts. Check disk space, antivirus, or Steam Guard / credentials, then try again.`);
      throw new Error(`${def.startExe} not found after install - SteamCMD did not actually download the files`);
    } else {
      log(id, 'success', `✔ Found ${def.startExe} at ${exePath}`);
    }

  } else if (def.type === 'minecraft') {
    await installMinecraft(id, server.installDir, config);
    server.execPath = path.join(server.installDir, 'server.jar');
  }
  saveData();
}


function installViaSteamCmdAuth(serverId, installDir, appId, gameName, username, password, steamGuardCode) {
  return new Promise((resolve, reject) => {
    log(serverId, 'info', `Installing ${gameName} (App ${appId}) — requires Steam login...`);

    // Always pass password if we have it - cache detection is unreliable
    if (steamGuardCode) {
      log(serverId, 'success', `🔐 Using Steam Guard code: ${steamGuardCode}`);
    }
    log(serverId, 'info', `🔐 Logging in as ${username}...`);

    // Write commands to a script file
    const scriptPath = path.join(STEAMCMD_DIR, `install_${serverId}.txt`);
    const scriptLines = [];
    scriptLines.push(`@ShutdownOnFailedCommand 1`);
    scriptLines.push(`force_install_dir "${installDir}"`);

    // Always pass the password if we have it - SteamCMD will use cache if valid,
    // or use the password as fallback. Without password, @NoPromptForPassword causes failure.
    if (steamGuardCode) scriptLines.push(`set_steam_guard_code ${steamGuardCode}`);
    if (password) {
      log(serverId, 'info', '🔐 Logging in (will use cached session if available)');
      scriptLines.push(`login ${username} ${password}`);
    } else {
      log(serverId, 'warn', '⚠ No password available - trying cache-only login');
      scriptLines.push(`login ${username}`);
    }
    scriptLines.push(`app_update ${appId} validate`);
    scriptLines.push(`quit`);
    fs.writeFileSync(scriptPath, scriptLines.join('\n'));

    log(serverId, 'info', `🔧 SteamCMD script: ${scriptPath}`);
    log(serverId, 'info', `🔧 SteamCMD exists: ${fs.existsSync(STEAMCMD_EXE)}`);

    let proc;
    try {
      proc = spawn(STEAMCMD_EXE, [`+runscript`, scriptPath], { cwd: STEAMCMD_DIR, windowsHide: true });
      log(serverId, 'success', `✔ SteamCMD process spawned (PID: ${proc.pid})`);
    } catch(err) {
      log(serverId, 'error', `❌ Failed to spawn SteamCMD: ${err.message}`);
      reject(err);
      return;
    }

    // Clean up script file when done
    const cleanupScript = () => {
      try { fs.unlinkSync(scriptPath); } catch(e) {}
    };

    let installPct = -1;
    let lastOutputTime = Date.now();
    let heartbeatCount = 0;
    let output = '';

    // Heartbeat: if no output for 15s, tell the user we are still working
    const heartbeat = setInterval(() => {
      const silentMs = Date.now() - lastOutputTime;
      if (silentMs > 15000) {
        heartbeatCount++;
        if (heartbeatCount === 1) {
          log(serverId, 'info', '⏳ SteamCMD is working silently (this is normal for the first install). The first download can take 10+ minutes...');
        } else if (heartbeatCount === 4) {
          log(serverId, 'warn', '⚠ SteamCMD has been silent for over a minute. If this persists, try cancelling and trying again.');
        } else if (heartbeatCount === 12) {
          log(serverId, 'error', '⚠ SteamCMD appears stuck. You can stop it manually via Task Manager and try again.');
        }
        lastOutputTime = Date.now(); // reset so we don\'t spam
      }
    }, 5000);

    proc.on('close', (code, signal) => {
      clearInterval(heartbeat);
      cleanupScript();
      log(serverId, 'info', `🔧 SteamCMD closed - code: ${code}, signal: ${signal}`);
    });
    proc.on('error', (err) => {
      clearInterval(heartbeat);
      log(serverId, 'error', `❌ SteamCMD error event: ${err.message}`);
    });
    proc.on('exit', (code, signal) => {
      log(serverId, 'info', `🔧 SteamCMD exited - code: ${code}, signal: ${signal}`);
    });
    proc.stderr.on('data', d => {
      const text = d.toString().trim();
      if (text) log(serverId, 'warn', `[stderr] ${text}`);
    });
    proc.stdout.on('data', d => {
      lastOutputTime = Date.now();
      const text = d.toString();
      output += text;
      text.split('\n').filter(l => l.trim()).forEach(line => {
        const t = line.toLowerCase();

        // QR code URL
        const qrMatch = line.match(/https?:\/\/s\.team\/[^\s]+/);
        if (qrMatch) {
          log(serverId, 'info', '📱 Scan QR code in Steam Mobile app to authorize');
          emit('steam-qr-code', { serverId, url: qrMatch[0] });
          return;
        }

        // SteamCMD "Update state ... downloading, progress: XX.XX (bytes / total)"
        const updateStateMatch = line.match(/progress:\s*([\d.]+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
        if (updateStateMatch) {
          const pct = Math.floor(parseFloat(updateStateMatch[1]));
          const downloaded = parseInt(updateStateMatch[2]);
          const total = parseInt(updateStateMatch[3]);
          if (pct !== installPct) {
            installPct = pct;
            const filled = Math.floor(pct / 5);
            const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
            const dlMb = (downloaded / 1048576).toFixed(0);
            const totalMb = (total / 1048576).toFixed(0);
            emit('console-progress', { serverId, text: `⬇  ${gameName}  [${bar}] ${pct}%  (${dlMb}/${totalMb} MB)` });
            if (pct === 0)   log(serverId, 'info',    `⬇  Starting download: ${gameName} (${totalMb} MB total)`);
            if (pct === 100) log(serverId, 'success', `✔  Download complete: ${gameName}`);
          }
          return;
        }

        // Skip noisy Update state lines that don't have progress info
        if (line.match(/Update state \(0x[0-9a-f]+\)/i)) {
          // Capture verifying/preallocating states for progress bar
          if (t.includes('verifying')) emit('console-progress', { serverId, text: `🔍 Verifying ${gameName}...` });
          else if (t.includes('preallocating')) emit('console-progress', { serverId, text: `📦 Preparing files for ${gameName}...` });
          else if (t.includes('committing')) emit('console-progress', { serverId, text: `💾 Finalizing ${gameName}...` });
          return;
        }

        // SteamCMD bracketed [XX%] progress
        const pctMatch = line.match(/\[\s*(\d+)%\]/);
        if (pctMatch) {
          const pct = parseInt(pctMatch[1]);
          if (pct !== installPct) {
            installPct = pct;
            const filled = Math.floor(pct / 5);
            const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
            emit('console-progress', { serverId, text: `⬇  Installing ${gameName}  [${bar}] ${pct}%` });
            if (pct === 0)   log(serverId, 'info',    `⬇  Starting download: ${gameName}`);
            if (pct === 100) log(serverId, 'success', `✔  Download complete: ${gameName}`);
          }
          return;
        }

        // Auth/Guard
        if (t.includes('waiting') || t.includes('guard') || t.includes('confirm') || t.includes('two-factor')) {
          log(serverId, 'warn', `🔐 ${line.trim()}`); return;
        }
        if (t.includes('logged in') || t.includes('steam public')) {
          log(serverId, 'success', `✔ ${line.trim()}`); return;
        }
        if (t.includes('fully installed') || (t.includes('success') && t.includes('app'))) {
          log(serverId, 'success', `✔ ${line.trim()}`); return;
        }
        // Hide harmless SteamCMD cosmetic warnings
        if (t.includes('ilocalize::addfile') || t.includes('steambootstrapper')) return;
        if (t.includes('error') || t.includes('failed') || t.includes('timeout')) {
          log(serverId, 'error', line.trim()); return;
        }
        // Filter out noisy verify/check lines but keep meaningful ones
        if (t.includes('verif') || t.includes('checking')) {
          return; // hide these - the progress bar already shows what's happening
        }
        if (t.includes('updat') && !t.includes('error')) {
          return; // hide noisy update state messages
        }
        if (line.trim()) log(serverId, 'dim', line.trim());
      });
    });
    proc.stderr.on('data', d => log(serverId, 'warn', d.toString().trim()));
    proc.on('close', code => {
      if (code === 0 || code === 7) {
        resolve();
      } else {
        // Check output for specific Steam Guard issues
        if (output.includes('Two-factor code mismatch') || output.includes('two-factor')) {
          // Clear the expired guard code
          const existing = loadSteamCreds();
          if (existing.steamGuardCode) {
            saveSteamCreds(existing.username, existing.password, '');
            log(serverId, 'warn', '🔐 Saved Steam Guard code is expired (one-time use). Get a fresh code from Steam Mobile app and reconnect in Settings.');
          }
          emit('install-needs-auth', { serverId });
          reject(new Error('Steam Guard code expired - reconnect in Settings → Connections with a fresh code'));
        } else if (output.includes('Invalid Password')) {
          reject(new Error('Invalid Steam password - check Settings → Connections'));
        } else if (output.includes('Rate Limit')) {
          reject(new Error('Steam rate limit hit - wait 5-10 minutes and try again'));
        } else {
          reject(new Error(`SteamCMD exited ${code}`));
        }
      }
    });
    proc.on('error', reject);
  });
}

// Palworld default settings template — bundled so we never depend on the game shipping one.
// Values here are Palworld's own defaults. User's port/name get patched in on install.
const PALWORLD_DEFAULT_INI = `[/Script/Pal.PalGameWorldSettings]
OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,NightTimeSpeedRate=1.000000,ExpRate=1.000000,PalCaptureRate=1.000000,PalSpawnNumRate=1.000000,PalDamageRateAttack=1.000000,PalDamageRateDefense=1.000000,PlayerDamageRateAttack=1.000000,PlayerDamageRateDefense=1.000000,PlayerStomachDecreaceRate=1.000000,PlayerStaminaDecreaceRate=1.000000,PlayerAutoHPRegeneRate=1.000000,PlayerAutoHpRegeneRateInSleep=1.000000,PalStomachDecreaceRate=1.000000,PalStaminaDecreaceRate=1.000000,PalAutoHPRegeneRate=1.000000,PalAutoHPRegeneRateInSleep=1.000000,BuildObjectDamageRate=1.000000,BuildObjectDeteriorationDamageRate=1.000000,CollectionDropRate=1.000000,CollectionObjectHpRate=1.000000,CollectionObjectRespawnSpeedRate=1.000000,EnemyDropItemRate=1.000000,DeathPenalty=All,bEnablePlayerToPlayerDamage=False,bEnableFriendlyFire=False,bEnableInvaderEnemy=True,bActiveUNKO=False,bEnableAimAssistPad=True,bEnableAimAssistKeyboard=False,DropItemMaxNum=3000,DropItemMaxNum_UNKO=100,BaseCampMaxNum=128,BaseCampWorkerMaxNum=15,DropItemAliveMaxHours=1.000000,bAutoResetGuildNoOnlinePlayers=False,AutoResetGuildTimeNoOnlinePlayers=72.000000,GuildPlayerMaxNum=20,PalEggDefaultHatchingTime=72.000000,WorkSpeedRate=1.000000,bIsMultiplay=False,bIsPvP=False,bHardcore=False,bCanPickupOtherGuildDeathPenaltyDrop=False,bEnableNonLoginPenalty=True,bEnableFastTravel=True,bIsStartLocationSelectByMap=True,bExistPlayerAfterLogout=False,bEnableDefenseOtherGuildPlayer=False,CoopPlayerMaxNum=4,ServerPlayerMaxNum=32,ServerName="My Palworld Server",ServerDescription="",AdminPassword="",ServerPassword="",PublicPort=8211,PublicIP="",RCONEnabled=False,RCONPort=25575,Region="",bUseAuth=True,BanListURL="https://api.palworldgame.com/api/banlist.txt",AutoSaveSpan=30.000000)
`;

// ── Server config sync: applies user's chosen name/port to per-game config files ──
// Called on install (create configs) and start (in case user changed name/port).
// Non-fatal - logs warnings if config file doesn't exist yet.
function syncServerConfig(serverId, server, isInstall = false) {
  if (!server || !server.installDir) return;
  const gameName = server.name || 'My Server';
  const port = server.port || 0;

  try {
    if (server.game === 'Palworld') {
      const cfgDir = path.join(server.installDir, 'Pal', 'Saved', 'Config', 'WindowsServer');
      const iniPath = path.join(cfgDir, 'PalWorldSettings.ini');
      const defaultIniPath = path.join(server.installDir, 'DefaultPalWorldSettings.ini');
      let ini = '';
      if (fs.existsSync(iniPath)) {
        ini = fs.readFileSync(iniPath, 'utf8');
      } else if (fs.existsSync(defaultIniPath)) {
        ini = fs.readFileSync(defaultIniPath, 'utf8');
      } else {
        // Neither user config nor bundled default present - use our embedded template
        ini = PALWORLD_DEFAULT_INI;
        if (isInstall) log(serverId, 'dim', 'Palworld defaults not shipped by SteamCMD, using bundled template.');
      }
      // Ensure the config directory exists before writing
      fs.mkdirSync(cfgDir, { recursive: true });
      if (ini) {
        // Sync port
        if (port) {
          if (ini.includes('PublicPort=')) ini = ini.replace(/PublicPort=\d+/, `PublicPort=${port}`);
          else if (ini.includes('OptionSettings=(')) ini = ini.replace(/OptionSettings=\(/, `OptionSettings=(PublicPort=${port},`);
        }
        // Sync server name
        const escapedName = gameName.replace(/"/g, '');
        if (ini.match(/ServerName="[^"]*"/)) {
          ini = ini.replace(/ServerName="[^"]*"/, `ServerName="${escapedName}"`);
        } else if (ini.includes('OptionSettings=(')) {
          ini = ini.replace(/OptionSettings=\(/, `OptionSettings=(ServerName="${escapedName}",`);
        }
        fs.writeFileSync(iniPath, ini);
        if (isInstall) log(serverId, 'success', `✔ PalWorldSettings.ini configured (name="${gameName}", port=${port})`);
      }
    }

    else if (server.game === 'Minecraft') {
      const propsPath = path.join(server.installDir, 'server.properties');
      if (fs.existsSync(propsPath)) {
        let content = fs.readFileSync(propsPath, 'utf8');
        // MOTD is what appears in the server list
        if (content.match(/^motd=.*$/m)) content = content.replace(/^motd=.*$/m, `motd=${gameName}`);
        else content += `\nmotd=${gameName}\n`;
        fs.writeFileSync(propsPath, content);
      }
    }

    else if (server.game === '7 Days to Die') {
      const xmlPath = path.join(server.installDir, 'serverconfig.xml');
      if (fs.existsSync(xmlPath)) {
        let xml = fs.readFileSync(xmlPath, 'utf8');
        const escapedName = gameName.replace(/"/g, '&quot;');
        if (xml.match(/property\s+name="ServerName"\s+value="[^"]*"/)) {
          xml = xml.replace(/property\s+name="ServerName"\s+value="[^"]*"/, `property name="ServerName" value="${escapedName}"`);
          fs.writeFileSync(xmlPath, xml);
        }
      }
    }

    else if (server.game === 'Satisfactory') {
      const iniPath = path.join(server.installDir, 'FactoryGame', 'Saved', 'Config', 'WindowsServer', 'Game.ini');
      if (fs.existsSync(iniPath)) {
        let ini = fs.readFileSync(iniPath, 'utf8');
        if (ini.match(/^ServerName=.*$/m)) ini = ini.replace(/^ServerName=.*$/m, `ServerName=${gameName}`);
        else ini += `\nServerName=${gameName}\n`;
        fs.writeFileSync(iniPath, ini);
      }
    }

    else if (server.game === 'Enshrouded') {
      const jsonPath = path.join(server.installDir, 'enshrouded_server.json');
      if (fs.existsSync(jsonPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          cfg.name = gameName;
          if (port) cfg.gamePort = port;
          fs.writeFileSync(jsonPath, JSON.stringify(cfg, null, 2));
        } catch(e) {}
      }
    }

    else if (server.game === 'Project Zomboid') {
      // Project Zomboid uses a .ini in Zomboid/Server/ folder within user profile
      // Server name is set via -servername launch arg (already handled in startArgs)
    }

    else if (server.game === 'Ark: Survival') {
      const iniPath = path.join(server.installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer', 'GameUserSettings.ini');
      if (fs.existsSync(iniPath)) {
        let ini = fs.readFileSync(iniPath, 'utf8');
        if (ini.match(/^SessionName=.*$/m)) ini = ini.replace(/^SessionName=.*$/m, `SessionName=${gameName}`);
        else if (ini.includes('[SessionSettings]')) ini = ini.replace(/\[SessionSettings\]/, `[SessionSettings]\nSessionName=${gameName}`);
        fs.writeFileSync(iniPath, ini);
      }
    }

    else if (server.game === 'V Rising') {
      // V Rising server name is set via launch arg -serverName (already in startArgs)
    }

    // Valheim, Rust, CS2, Terraria: server name set via launch args, already handled
  } catch(err) {
    if (isInstall) log(serverId, 'warn', `Could not sync config for ${server.game}: ${err.message}`);
  }
}

// ── SteamCMD ──────────────────────────────────────────────────────────────────
async function ensureSteamCmd(serverId) {
  if (fs.existsSync(STEAMCMD_EXE)) { log(serverId,'dim','SteamCMD found.'); return; }
  log(serverId,'info','Downloading SteamCMD from Valve...');
  const zipPath = path.join(STEAMCMD_DIR,'steamcmd.zip');
  await downloadFile('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', zipPath, pct => {
    const filled = Math.floor(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    emit('console-progress', { serverId, text: `🔧 SteamCMD  [${bar}] ${pct}%` });
  });
  log(serverId,'info','Extracting SteamCMD...');
  await extractZip(zipPath, STEAMCMD_DIR);
  log(serverId,'success','✔ SteamCMD ready.');
}

// Ensure the Microsoft Visual C++ x64 runtime is present. Almost every Steam
// dedicated server needs it to launch, and a fresh Windows install won't have it.
// A gaming PC usually already does (installed by other games), which is why this
// only bites clean machines. Downloads Microsoft's official evergreen redist and
// installs it silently. Non-fatal: if it can't confirm, the server may still run.
let vcRedistReady = false;
async function ensureVCRedist(serverId) {
  if (vcRedistReady || process.platform !== 'win32') { vcRedistReady = true; return; }
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const dll1 = path.join(sysRoot, 'System32', 'vcruntime140.dll');
  const dll2 = path.join(sysRoot, 'System32', 'vcruntime140_1.dll');
  if (fs.existsSync(dll1) && fs.existsSync(dll2)) { vcRedistReady = true; return; }

  log(serverId, 'info', '📦 Installing Microsoft Visual C++ Runtime (required to run game servers)...');
  log(serverId, 'warn', '👉 If Windows shows a security / "Do you want to allow this app to make changes?" prompt, click Yes to continue.');
  const depsDir = path.join(USER_DATA, 'deps');
  const installer = path.join(depsDir, 'vc_redist.x64.exe');
  try {
    fs.mkdirSync(depsDir, { recursive: true });
    await downloadFile('https://aka.ms/vs/17/release/vc_redist.x64.exe', installer, pct => {
      const filled = Math.floor(pct / 5);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      emit('console-progress', { serverId, text: `📦 Visual C++ Runtime  [${bar}] ${pct}%` });
    });
    log(serverId, 'info', '⏳ Installing Visual C++ Runtime (this can take a minute — there is no progress bar during the install step)...');
    // Keep the console alive so a silent install never looks frozen.
    const installTick = setInterval(() => emit('console-progress', { serverId, text: '⏳ Installing Visual C++ Runtime...' }), 4000);
    const code = await new Promise(resolve => {
      let done = false;
      const finish = (c) => { if (!done) { done = true; resolve(c); } };
      // A hung installer (e.g. Windows Installer busy on a fresh machine) must never
      // block the whole server install — give up after 3 min and continue. We don't
      // kill it, so it can finish in the background; the DLL check catches it later.
      const timer = setTimeout(() => {
        log(serverId, 'warn', '⚠ Visual C++ Runtime installer is taking unusually long — continuing without waiting. If the server fails to start, install "Visual C++ Redistributable (x64)" from Microsoft manually.');
        finish(-1);
      }, 180000);
      try {
        // Exit codes: 0 = ok, 3010 = ok (restart needed), 1638 = newer already installed.
        const p = spawn(installer, ['/install', '/quiet', '/norestart'], { windowsHide: true });
        p.on('close', c => { clearTimeout(timer); finish(c); });
        p.on('error', () => { clearTimeout(timer); finish(-1); });
      } catch(e) { clearTimeout(timer); finish(-1); }
    });
    clearInterval(installTick);
    if (fs.existsSync(dll1) && fs.existsSync(dll2)) {
      log(serverId, 'success', '✔ Visual C++ Runtime installed.');
      vcRedistReady = true;
    } else if ([0, 3010, 1638].includes(code)) {
      log(serverId, 'success', '✔ Visual C++ Runtime is present.');
      vcRedistReady = true;
    } else {
      log(serverId, 'warn', '⚠ Visual C++ Runtime install could not be confirmed. If a server fails to start, install the latest "Visual C++ Redistributable (x64)" from Microsoft.');
    }
  } catch (err) {
    log(serverId, 'warn', `⚠ Could not auto-install Visual C++ Runtime: ${err.message}. Server may still run if it is already present.`);
  } finally {
    try { fs.unlinkSync(installer); } catch(e) {}
  }
}

function installViaSteamCmd(serverId, installDir, appId, gameName) {
  return new Promise((resolve, reject) => {
    log(serverId,'info',`Installing/updating ${gameName} (App ${appId}) via SteamCMD...`);
    log(serverId,'dim','Only changed files will be downloaded for updates.');

    // Show progress bar immediately so user knows something is happening
    emit('console-progress', { serverId, text: `⏳ Starting install of ${gameName}...` });

    const proc = spawn(STEAMCMD_EXE, ['+force_install_dir',installDir,'+login','anonymous','+app_update',appId,'validate','+quit'], { cwd:STEAMCMD_DIR, windowsHide: true });
    let lastPct = -1;
    let lastProgressUpdate = Date.now();

    // Show a "still working" tick every 10s if no progress has come in
    const tick = setInterval(() => {
      if (Date.now() - lastProgressUpdate > 10000 && lastPct < 0) {
        const dots = '.'.repeat((Math.floor(Date.now()/1000) % 4));
        emit('console-progress', { serverId, text: `⏳ Downloading ${gameName}${dots} (SteamCMD is working silently)` });
      }
    }, 2000);

    proc.stdout.on('data', d => d.toString().split('\n').filter(l=>l.trim()).forEach(line => {
      lastProgressUpdate = Date.now();
      const t = line.toLowerCase();
      // SteamCMD bytes-based progress
      const updateStateMatch = line.match(/progress:\s*([\d.]+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
      if (updateStateMatch) {
        const pct = Math.floor(parseFloat(updateStateMatch[1]));
        const downloaded = parseInt(updateStateMatch[2]);
        const total = parseInt(updateStateMatch[3]);
        if (pct !== lastPct) {
          lastPct = pct;
          const filled = Math.floor(pct / 5);
          const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
          const dlMb = (downloaded/1048576).toFixed(0);
          const totalMb = (total/1048576).toFixed(0);
          emit('console-progress', { serverId, text: `⬇  ${gameName}  [${bar}] ${pct}%  (${dlMb}/${totalMb} MB)` });
          if (pct === 0)   log(serverId,'info',`⬇  Starting download: ${gameName} (${totalMb} MB total)`);
          if (pct === 100) log(serverId,'success',`✔  Download complete: ${gameName}`);
        }
        return;
      }
      // Fallback: percent-only match like "progress: 42.5"
      const pctOnlyMatch = line.match(/progress:\s*([\d.]+)(?!\s*\()/i);
      if (pctOnlyMatch) {
        const pct = Math.floor(parseFloat(pctOnlyMatch[1]));
        if (pct !== lastPct && pct >= 0 && pct <= 100) {
          lastPct = pct;
          const filled = Math.floor(pct / 5);
          const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
          emit('console-progress', { serverId, text: `⬇  ${gameName}  [${bar}] ${pct}%` });
        }
        return;
      }
      // Filter noisy state lines
      if (line.match(/Update state \(0x[0-9a-f]+\)/i)) {
        if (t.includes('verifying'))     emit('console-progress', { serverId, text: `🔍 Verifying ${gameName}...` });
        else if (t.includes('preallocating')) emit('console-progress', { serverId, text: `📦 Preparing files for ${gameName}...` });
        else if (t.includes('committing')) emit('console-progress', { serverId, text: `💾 Finalizing ${gameName}...` });
        else if (t.includes('downloading')) emit('console-progress', { serverId, text: `⬇  Downloading ${gameName}...` });
        return;
      }
      if (t.includes('error')) { log(serverId,'error',line.trim()); return; }
      if (t.includes('success') || t.includes('fully installed')) {
        emit('console-progress', { serverId, text: `✔  ${gameName} installed successfully!` });
        log(serverId,'success',line.trim());
        return;
      }
      if (t.includes('verif') || t.includes('checking') || t.includes('updat')) return; // hide noise
      if (line.trim()) log(serverId,'dim',line.trim());
    }));
    proc.stderr.on('data', d => log(serverId,'warn',d.toString().trim()));
    proc.on('close', code => {
      clearInterval(tick);
      (code===0||code===7) ? resolve() : reject(new Error(`SteamCMD exited ${code}`));
    });
    proc.on('error', err => { clearInterval(tick); reject(err); });
  });
}

// ── Minecraft install ─────────────────────────────────────────────────────────
async function installMinecraft(serverId, installDir, config) {
  const type    = config.mcType    || 'vanilla';
  const version = config.mcVersion || 'latest';

  log(serverId,'info',`Installing Minecraft ${type} ${version}...`);

  let resolvedVersion = version;
  if (type === 'vanilla') {
    resolvedVersion = await installVanilla(serverId, installDir, version);
  } else if (type === 'paper') {
    resolvedVersion = await installPaper(serverId, installDir, version);
  } else if (type === 'fabric') {
    resolvedVersion = await installFabric(serverId, installDir, version);
  } else if (type === 'forge') {
    resolvedVersion = await installForge(serverId, installDir, version);
  }
  // Save the actual resolved version back to the server record
  const srv = appData.servers.find(s => s.installDir === installDir);
  if (srv && resolvedVersion) {
    srv.mcVersion = resolvedVersion;
    srv.mcType    = type;
    saveData();
  }

  // Write eula + server.properties if not already there
  const eulaPath = path.join(installDir,'eula.txt');
  if (!fs.existsSync(eulaPath)) fs.writeFileSync(eulaPath,'eula=true\n');
  const propsPath = path.join(installDir,'server.properties');
  if (!fs.existsSync(propsPath)) fs.writeFileSync(propsPath, [`server-port=${config.port||25565}`,'gamemode=survival','difficulty=normal','max-players=20','online-mode=true',`motd=${config.name||'My Minecraft Server'}`].join('\n')+'\n');
}

async function installVanilla(serverId, installDir, version) {
  const manifest = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json');

  // Only consider proper release versions that start with 1.
  const releases = manifest.versions.filter(v => v.type === 'release' && v.id.startsWith('1.'));

  let ver;
  if (!version || version === 'latest') {
    ver = releases[0]?.id; // Most recent proper 1.x release
  } else {
    ver = version;
  }

  if (!ver) throw new Error('Could not determine Minecraft version');
  if (!ver.startsWith('1.')) throw new Error(`Invalid version "${ver}" - expected a 1.x.x release`);

  const vInfo = manifest.versions.find(v => v.id === ver);
  if (!vInfo) throw new Error(`Version ${ver} not found in manifest`);

  const vData = await fetchJSON(vInfo.url);
  const url   = vData.downloads?.server?.url;
  if (!url) throw new Error(`No server JAR download found for ${ver}`);

  log(serverId, 'info', `Downloading Minecraft Vanilla ${ver}...`);
  await downloadFile(url, path.join(installDir, 'server.jar'), pct => {
    const filled = Math.floor(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    emit('console-progress', { serverId, text: `⬇  Minecraft ${ver}  [${bar}] ${pct}%` });
  });
  log(serverId, 'success', `✔ Vanilla ${ver} downloaded.`);
  return ver;
}

async function installPaper(serverId, installDir, version) {
  const data = await fetchJSON('https://api.papermc.io/v2/projects/paper');
  const ver  = version==='latest' ? data.versions[data.versions.length-1] : version;
  const builds = await fetchJSON(`https://api.papermc.io/v2/projects/paper/versions/${ver}/builds`);
  const latest = builds.builds[builds.builds.length-1];
  const fileName = latest.downloads.application.name;
  const url = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${latest.build}/downloads/${fileName}`;
  log(serverId,'info',`Downloading PaperMC ${ver} build ${latest.build}...`);
  await downloadFile(url, path.join(installDir,'server.jar'), pct => {
    const filled = Math.floor(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    emit('console-progress', { serverId, text: `⬇  Paper ${ver}  [${bar}] ${pct}%` });
  });
  log(serverId,'success',`✔ Paper ${ver} downloaded.`);
  return ver;
}

async function installFabric(serverId, installDir, version) {
  const gameVersions = await fetchJSON('https://meta.fabricmc.net/v2/versions/game');
  const ver = version==='latest' ? gameVersions.find(v=>v.stable)?.version : version;
  if (!ver) throw new Error('Could not resolve Fabric game version');
  const loaders  = await fetchJSON('https://meta.fabricmc.net/v2/versions/loader');
  const loader   = loaders[0].version;
  const installs = await fetchJSON('https://meta.fabricmc.net/v2/versions/installer');
  const installer = installs[0].version;
  const url = `https://meta.fabricmc.net/v2/versions/loader/${ver}/${loader}/${installer}/server/jar`;
  log(serverId,'info',`Downloading Fabric ${ver} (loader ${loader})...`);
  await downloadFile(url, path.join(installDir,'server.jar'), pct => {
    const filled = Math.floor(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    emit('console-progress', { serverId, text: `⬇  Fabric ${ver}  [${bar}] ${pct}%` });
  });
  log(serverId,'success',`✔ Fabric ${ver} downloaded.`);
}

async function installForge(serverId, installDir, version) {
  // Forge requires running an installer JAR — we download it and run it
  log(serverId,'info',`Fetching Forge version list for MC ${version}...`);
  const promoData = await fetchJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const key   = version==='latest' ? null : `${version}-latest`;
  const fVer  = key ? promoData.promos[key] : promoData.promos[Object.keys(promoData.promos).find(k=>k.endsWith('-latest'))];
  if (!fVer) throw new Error(`No Forge build found for Minecraft ${version}`);
  const mcVer   = key ? version : Object.keys(promoData.promos).find(k=>k.endsWith('-latest')).replace('-latest','');
  const fullVer = `${mcVer}-${fVer}`;
  const installerUrl = `https://files.minecraftforge.net/maven/net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
  const installerPath = path.join(installDir,`forge-installer.jar`);
  log(serverId,'info',`Downloading Forge ${fullVer} installer...`);
  await downloadFile(installerUrl, installerPath, pct => {
    emit('console-progress', { serverId, text: `Downloading Forge ${fullVer}... ${pct}%` });
  });
  log(serverId,'info','Running Forge installer (this may take a minute)...');
  const srv = appData.servers.find(s => s.installDir === installDir);
  const javaExe = await ensureJava(serverId, srv?.mcVersion);
  await new Promise((resolve, reject) => {
    const proc = spawn(javaExe, ['-jar', installerPath, '--installServer'], { cwd: installDir });
    proc.stdout.on('data', d => log(serverId,'dim',d.toString().trim()));
    proc.stderr.on('data', d => log(serverId,'dim',d.toString().trim()));
    proc.on('close', code => code===0 ? resolve() : reject(new Error(`Forge installer exited ${code}`)));
    proc.on('error', err => reject(new Error(`Java error: ${err.message}`)));
  });
  // Forge creates a run.bat/run.sh — point to that
  const runBat = path.join(installDir,'run.bat');
  if (fs.existsSync(runBat)) {
    const srv = appData.servers.find(s=>s.installDir===installDir);
    if (srv) { srv.execPath=runBat; srv.useShell=true; }
  }
  log(serverId,'success',`✔ Forge ${fullVer} installed.`);
}



// ── Game-specific config definitions ─────────────────────────────────────────
const GAME_CONFIG_DEFS = {
  'Rust': {
    file: 'server.cfg',
    props: [
      { group: '🌍 Server', props: [
        { key: 'server.hostname',      label: 'Server Name',      type: 'text', basic: true },
        { key: 'server.description',   label: 'Description',      type: 'text' },
        { key: 'server.url',           label: 'Server URL',       type: 'text' },
        { key: 'server.headerimage',   label: 'Header Image URL', type: 'text' },
        { key: 'server.logoimage',     label: 'Logo Image URL',   type: 'text' },
        { key: 'server.port',          label: 'Port',             type: 'number', basic: true },
        { key: 'server.queryport',     label: 'Query Port',       type: 'number' },
        { key: 'server.maxplayers',    label: 'Max Players',      type: 'number' },
        { key: 'server.tags',          label: 'Server Tags',      type: 'text', placeholder: 'monthly,vanilla' },
      ]},
      { group: '🗺 World', props: [
        { key: 'server.worldsize',     label: 'World Size',       type: 'number', placeholder: '1000-6000' },
        { key: 'server.seed',          label: 'World Seed',       type: 'text', placeholder: 'Leave blank for random' },
        { key: 'server.level',         label: 'Map (Level)',      type: 'select', options: ['Procedural Map','Barren','HapisIsland','SavasIsland','Custom Map'] },
      ]},
      { group: '⚔️ Gameplay', props: [
        { key: 'server.pve',           label: 'PvE Mode',              type: 'bool' },
        { key: 'server.radiation',     label: 'Radiation',             type: 'bool' },
        { key: 'server.globalchat',    label: 'Global Chat',           type: 'bool' },
        { key: 'server.stability',     label: 'Building Stability',    type: 'bool' },
        { key: 'server.gamemode',      label: 'Game Mode',             type: 'select', options: ['vanilla','softcore','hardcore'] },
        { key: 'decay.scale',          label: 'Decay Scale',           type: 'number' },
        { key: 'craft.instant',        label: 'Instant Crafting',      type: 'bool' },
      ]},
      { group: '📈 Gather Rates', props: [
        { key: 'gather.rate dispenser wood', label: 'Wood Gather Rate',   type: 'number' },
        { key: 'gather.rate dispenser stones', label: 'Stone Gather Rate',type: 'number' },
        { key: 'gather.rate dispenser metal.ore', label: 'Metal Gather Rate', type: 'number' },
        { key: 'gather.rate dispenser sulfur.ore', label: 'Sulfur Gather Rate', type: 'number' },
        { key: 'gather.rate pickup *', label: 'Pickup Rate (all)',    type: 'number' },
      ]},
      { group: '🎁 Loot & Drops', props: [
        { key: 'spawn.min_rate',       label: 'Min Spawn Rate',        type: 'number' },
        { key: 'spawn.max_rate',       label: 'Max Spawn Rate',        type: 'number' },
        { key: 'spawn.min_density',    label: 'Min Density',           type: 'number' },
        { key: 'spawn.max_density',    label: 'Max Density',           type: 'number' },
      ]},
      { group: '⚙️ Performance & System', props: [
        { key: 'fps.limit',            label: 'FPS Limit',             type: 'number' },
        { key: 'server.saveinterval',  label: 'Save Interval (s)',     type: 'number' },
        { key: 'server.tickrate',      label: 'Tick Rate',             type: 'number' },
        { key: 'server.maxsleepingbags', label: 'Max Sleeping Bags',   type: 'number' },
        { key: 'rcon.web',             label: 'RCON Web',              type: 'bool' },
        { key: 'rcon.port',            label: 'RCON Port',             type: 'number' },
        { key: 'rcon.password',        label: 'RCON Password',         type: 'text' },
      ]},
    ],
  },
  'Valheim': {
    file: 'start_server.bat',
    useArgs: true,
    props: [
      { group: '🌍 Server', props: [
        { key: '-name',     label: 'Server Name',  type: 'text', basic: true },
        { key: '-world',    label: 'World Name',   type: 'text' },
        { key: '-password', label: 'Password',     type: 'text', basic: true },
        { key: '-port',     label: 'Port',         type: 'number', basic: true },
        { key: '-public',   label: 'Public Server',type: 'bool01' },
      ]},
    ],
  },
  'Project Zomboid': {
    file: 'Server/servertest.ini',
    props: [
      { group: '🌍 Server', props: [
        { key: 'PublicName',           label: 'Server Name',        type: 'text', basic: true },
        { key: 'PublicDescription',    label: 'Description',        type: 'text' },
        { key: 'Port',                 label: 'Port',               type: 'number', basic: true },
        { key: 'MaxPlayers',           label: 'Max Players',        type: 'number' },
        { key: 'Password',             label: 'Password',           type: 'text', basic: true },
        { key: 'AdminPassword',        label: 'Admin Password',     type: 'text' },
        { key: 'Public',               label: 'Public Server',      type: 'bool' },
        { key: 'Open',                 label: 'Open (Non-Whitelist)', type: 'bool' },
        { key: 'AutoCreateUserInWhiteList', label: 'Auto-Whitelist New Players', type: 'bool' },
        { key: 'PingLimit',            label: 'Ping Limit',         type: 'number' },
      ]},
      { group: '⚔️ Gameplay', props: [
        { key: 'PVP',                  label: 'PvP',                type: 'bool' },
        { key: 'Difficulty',           label: 'Difficulty',         type: 'select', options: ['Survivor','Apocalypse','Beginner','Builder','Custom'] },
        { key: 'DayLength',            label: 'Day Length (min)',   type: 'number' },
        { key: 'StartYear',            label: 'Start Year',         type: 'number' },
        { key: 'StartMonth',           label: 'Start Month (1-12)', type: 'number' },
        { key: 'StartDay',             label: 'Start Day (1-31)',   type: 'number' },
        { key: 'StartTime',            label: 'Start Time (0-23)',  type: 'number' },
        { key: 'PauseEmpty',           label: 'Pause When Empty',   type: 'bool' },
        { key: 'MinutesPerPage',       label: 'Reading Time (min/page)', type: 'number' },
      ]},
      { group: '🧟 Zombies', props: [
        { key: 'MaxZombiesByMap',      label: 'Max Zombies',        type: 'number' },
        { key: 'ZombieLore.Speed',     label: 'Zombie Speed',       type: 'select', options: ['Sprinters','Fast Shamblers','Shamblers','Random'] },
        { key: 'ZombieLore.Strength',  label: 'Zombie Strength',    type: 'select', options: ['Superhuman','Normal','Weak','Random'] },
        { key: 'ZombieLore.Toughness', label: 'Zombie Toughness',   type: 'select', options: ['Tough','Normal','Fragile','Random'] },
        { key: 'ZombieLore.Cognition', label: 'Zombie Cognition',   type: 'select', options: ['Navigate+Use Doors','Navigate','Basic','Random'] },
        { key: 'ZombieLore.Sight',     label: 'Zombie Sight',       type: 'select', options: ['Eagle','Normal','Poor','Random'] },
        { key: 'ZombieLore.Hearing',   label: 'Zombie Hearing',     type: 'select', options: ['Pinpoint','Normal','Poor','Random'] },
        { key: 'ZombieLore.Smell',     label: 'Zombie Smell',       type: 'select', options: ['Pinpoint','Normal','Poor','Random'] },
        { key: 'ZombieLore.ActiveOnly',label: 'Zombies Active Only',type: 'select', options: ['Both','Day','Night'] },
      ]},
      { group: '🚗 Vehicles & Loot', props: [
        { key: 'CarSpawnRate',         label: 'Car Spawn Rate',     type: 'number' },
        { key: 'LootRespawn',          label: 'Loot Respawn',       type: 'select', options: ['None','Every Day','Every Week','Every Month'] },
        { key: 'HoursForLootRespawn',  label: 'Loot Respawn Hours', type: 'number' },
        { key: 'ContainersMaxPct',     label: 'Container Fill %',   type: 'number' },
      ]},
      { group: '🏗 Safehouse & Base', props: [
        { key: 'SafehouseAllowFireplace', label: 'Allow Fireplace in Safehouse', type: 'bool' },
        { key: 'SafehouseAllowNonResident', label: 'Non-Residents Can Enter',   type: 'bool' },
        { key: 'SafehouseAllowLoot',   label: 'Non-Residents Can Loot',  type: 'bool' },
        { key: 'SafehouseAllowTrepass',label: 'Trespass Damages Safehouse', type: 'bool' },
        { key: 'SafehouseAllowRespawn',label: 'Respawn in Safehouse',    type: 'bool' },
        { key: 'SafehouseDaySurvivedToClaim', label: 'Days Survived to Claim', type: 'number' },
        { key: 'PlayerSafehouse',      label: 'Player-Owned Safehouses', type: 'bool' },
        { key: 'AdminSafehouse',       label: 'Admin Safehouses',        type: 'bool' },
      ]},
      { group: '🔧 System', props: [
        { key: 'ServerWelcomeMessage', label: 'Welcome Message',    type: 'text' },
        { key: 'SaveWorldEveryMinutes',label: 'Save Every (min)',   type: 'number' },
        { key: 'RCONEnabled',          label: 'RCON Enabled',       type: 'bool' },
        { key: 'RCONPort',             label: 'RCON Port',          type: 'number' },
        { key: 'RCONPassword',         label: 'RCON Password',      type: 'text' },
        { key: 'MapRemotePlayerVisibility', label: 'Map Player Visibility (1-3)', type: 'number' },
        { key: 'KickFastPlayers',      label: 'Kick Fast Players',  type: 'bool' },
      ]},
    ],
  },
  'Ark: Survival': {
    file: 'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
    props: [
      { group: '🌍 Server', props: [
        { key: 'SessionName',        label: 'Server Name',       type: 'text', basic: true },
        { key: 'ServerPassword',     label: 'Password',          type: 'text', basic: true },
        { key: 'ServerAdminPassword',label: 'Admin Password',    type: 'text' },
        { key: 'SpectatorPassword',  label: 'Spectator Password',type: 'text' },
        { key: 'MaxPlayers',         label: 'Max Players',       type: 'number' },
        { key: 'ServerHardcore',     label: 'Hardcore Mode',     type: 'bool' },
        { key: 'ServerPVE',          label: 'PvE Mode',          type: 'bool' },
        { key: 'ServerCrosshair',    label: 'Crosshair',         type: 'bool' },
        { key: 'ShowMapPlayerLocation',    label: 'Show Player Location on Map', type: 'bool' },
        { key: 'AllowThirdPersonPlayer',   label: 'Allow Third Person',           type: 'bool' },
      ]},
      { group: '⚔️ Difficulty & Rates', props: [
        { key: 'DifficultyOffset',              label: 'Difficulty',           type: 'number' },
        { key: 'OverrideOfficialDifficulty',    label: 'Override Difficulty',  type: 'number' },
        { key: 'XPMultiplier',                  label: 'XP Multiplier',        type: 'number' },
        { key: 'TamingSpeedMultiplier',         label: 'Taming Speed',         type: 'number' },
        { key: 'HarvestAmountMultiplier',       label: 'Harvest Rate',         type: 'number' },
        { key: 'HarvestHealthMultiplier',       label: 'Harvest Health',       type: 'number' },
        { key: 'ResourcesRespawnPeriodMultiplier', label: 'Resource Respawn',  type: 'number' },
        { key: 'DayCycleSpeedScale',            label: 'Day Cycle Speed',      type: 'number' },
        { key: 'DayTimeSpeedScale',             label: 'Day Time Speed',       type: 'number' },
        { key: 'NightTimeSpeedScale',           label: 'Night Time Speed',     type: 'number' },
      ]},
      { group: '🦖 Dinos & Taming', props: [
        { key: 'DinoCountMultiplier',            label: 'Dino Spawn Density',   type: 'number' },
        { key: 'DinoDamageMultiplier',           label: 'Wild Dino Damage',     type: 'number' },
        { key: 'DinoResistanceMultiplier',       label: 'Wild Dino Resistance', type: 'number' },
        { key: 'TamedDinoDamageMultiplier',      label: 'Tamed Dino Damage',    type: 'number' },
        { key: 'TamedDinoResistanceMultiplier',  label: 'Tamed Dino Resistance',type: 'number' },
        { key: 'DinoCharacterFoodDrainMultiplier', label:'Dino Food Drain',     type: 'number' },
        { key: 'MaxTamedDinos',                  label: 'Max Tamed Dinos',      type: 'number' },
        { key: 'AllowRaidDinoFeeding',           label: 'Allow Raid Dino Feeding',type: 'bool' },
        { key: 'bAllowFlyerCarryPvE',            label: 'Flyer Carry (PvE)',    type: 'bool' },
      ]},
      { group: '👤 Player', props: [
        { key: 'PlayerCharacterWaterDrainMultiplier',  label: 'Water Drain',    type: 'number' },
        { key: 'PlayerCharacterFoodDrainMultiplier',   label: 'Food Drain',     type: 'number' },
        { key: 'PlayerCharacterStaminaDrainMultiplier',label: 'Stamina Drain',  type: 'number' },
        { key: 'PlayerCharacterHealthRecoveryMultiplier',label:'Health Recovery',type: 'number' },
        { key: 'PlayerDamageMultiplier',    label: 'Player Damage',   type: 'number' },
        { key: 'PlayerResistanceMultiplier',label: 'Player Resistance', type: 'number' },
      ]},
      { group: '🏗 Structures', props: [
        { key: 'StructureResistanceMultiplier',  label: 'Structure Resistance', type: 'number' },
        { key: 'StructureDamageMultiplier',      label: 'Structure Damage',     type: 'number' },
        { key: 'TheMaxStructuresInRange',        label: 'Max Structures in Range', type: 'number' },
        { key: 'DisableStructureDecayPvE',       label: 'Disable Decay (PvE)',  type: 'bool' },
        { key: 'AllowFlyingStaminaRecovery',     label: 'Flyer Stamina Recovery', type: 'bool' },
      ]},
      { group: '🔧 System', props: [
        { key: 'AutoSavePeriodMinutes',        label: 'Auto-save Interval (min)', type: 'number' },
        { key: 'KickIdlePlayersPeriod',        label: 'Kick Idle After (s)',      type: 'number' },
        { key: 'RCONEnabled',                  label: 'RCON Enabled',             type: 'bool' },
        { key: 'RCONPort',                     label: 'RCON Port',                type: 'number' },
        { key: 'EnableExtraStructurePreventionVolumes', label: 'Prevent Griefing Zones', type: 'bool' },
        { key: 'ClampResourceHarvestDamage',   label: 'Clamp Harvest Damage',     type: 'bool' },
      ]},
    ],
  },
  'V Rising': {
    file: 'VRisingServer_Data/StreamingAssets/Settings/ServerGameSettings.json',
    type: 'json',
    props: [
      { group: '🌍 Server', props: [
        { key: 'Name',              label: 'Server Name',     type: 'text', basic: true },
        { key: 'Description',       label: 'Description',     type: 'text' },
        { key: 'MaxConnectedUsers', label: 'Max Players',     type: 'number' },
        { key: 'MaxConnectedAdmins',label: 'Max Admins',      type: 'number' },
        { key: 'Password',          label: 'Password',        type: 'text', basic: true },
        { key: 'ListOnEOSSteam',    label: 'Show in Server List (EOS)',  type: 'bool' },
        { key: 'ListOnSteam',       label: 'Show in Server List (Steam)',type: 'bool' },
        { key: 'AutoSaveCount',     label: 'Autosaves Kept',  type: 'number' },
        { key: 'AutoSaveInterval',  label: 'Autosave Interval (s)', type: 'number' },
      ]},
      { group: '⚔️ Difficulty & Combat', props: [
        { key: 'GameDifficulty',       label: 'Difficulty',           type: 'select', options: ['Relaxed','Normal','Brutal'] },
        { key: 'GameModeType',         label: 'Game Mode',            type: 'select', options: ['PvP','PvE'] },
        { key: 'CastleDamageMode',     label: 'Castle Damage Mode',   type: 'select', options: ['Never','TimeRestricted','Always'] },
        { key: 'SiegeWeaponHealth',    label: 'Siege Weapon Health',  type: 'select', options: ['VeryLow','Low','Normal','High','VeryHigh'] },
        { key: 'PlayerDamageMode',     label: 'Player Damage',        type: 'select', options: ['Enabled','Disabled'] },
        { key: 'CanLootEnemyContainers', label: 'Loot Enemy Bases',   type: 'bool' },
        { key: 'BloodBoundEquipment',  label: 'Blood-Bound Equipment',type: 'bool' },
      ]},
      { group: '🏰 Base & Building', props: [
        { key: 'CastleDecayRateModifier',       label: 'Castle Decay Rate',    type: 'number' },
        { key: 'CastleBloodEssenceDrainModifier', label: 'Blood Essence Drain',type: 'number' },
        { key: 'CastleMinimumDistanceInFloors', label: 'Min Castle Distance',  type: 'number' },
        { key: 'ClanSize',                      label: 'Max Clan Size',        type: 'number' },
        { key: 'BloodEssenceMaxLevel',          label: 'Blood Essence Max',    type: 'number' },
        { key: 'RelicSpawnType',                label: 'Relic Spawn',          type: 'select', options: ['Unique','Plentiful'] },
      ]},
      { group: '📈 Rates & Multipliers', props: [
        { key: 'InventoryStacksModifier',   label: 'Inventory Stack Multiplier',  type: 'number' },
        { key: 'DropTableModifier_General', label: 'General Loot Modifier',       type: 'number' },
        { key: 'DropTableModifier_Missions',label: 'Mission Loot Modifier',       type: 'number' },
        { key: 'MaterialYieldModifier_Global',   label: 'Material Yield Modifier',type: 'number' },
        { key: 'BloodEssenceYieldModifier',      label: 'Blood Essence Yield',    type: 'number' },
        { key: 'DurabilityCostModifier',    label: 'Durability Cost',             type: 'number' },
        { key: 'ItemStackSizeModifier',     label: 'Item Stack Size Multiplier',  type: 'number' },
        { key: 'CraftRateModifier',         label: 'Craft Rate',                  type: 'number' },
        { key: 'ResearchCostModifier',      label: 'Research Cost',               type: 'number' },
      ]},
      { group: '⏱ Time & VBlood', props: [
        { key: 'DayDurationInSeconds',      label: 'Day Length (s)',          type: 'number' },
        { key: 'DayStartHour',              label: 'Day Start Hour',          type: 'number' },
        { key: 'DayEndHour',                label: 'Day End Hour',            type: 'number' },
        { key: 'BuffDurationModifier',      label: 'Buff Duration',           type: 'number' },
        { key: 'PvPProtectionMode',         label: 'PvP Protection',          type: 'select', options: ['Disabled','Short','Medium','Long'] },
        { key: 'DeathContainerPermission',  label: 'Death Container Access',  type: 'select', options: ['ClanMembers','Anyone','OnlyKiller'] },
      ]},
    ],
  },
  'Satisfactory': {
    file: 'FactoryGame/Saved/Config/WindowsServer/Game.ini',
    props: [
      { group: '🌍 Server', props: [
        { key: 'ServerName',            label: 'Server Name',        type: 'text', basic: true },
        { key: 'ServerDescription',     label: 'Description',        type: 'text' },
        { key: 'ServerPassword',        label: 'Client Password',    type: 'text', basic: true },
        { key: 'AdminPassword',         label: 'Admin Password',     type: 'text' },
        { key: 'MaxPlayers',            label: 'Max Players',        type: 'number' },
      ]},
      { group: '⚔️ Gameplay', props: [
        { key: 'AutoPause',             label: 'Auto-Pause When Empty', type: 'bool' },
        { key: 'AutoSaveOnDisconnect',  label: 'Auto-Save on Disconnect', type: 'bool' },
        { key: 'DisableSeasonalEvents', label: 'Disable Seasonal Events', type: 'bool' },
      ]},
      { group: '💾 Saves & Networking', props: [
        { key: 'AutosaveInterval',      label: 'Autosave Interval (s)', type: 'number' },
        { key: 'AutosaveOnRestart',     label: 'Autosave on Restart',   type: 'bool' },
        { key: 'KeepAutosaveCount',     label: 'Autosaves Kept',        type: 'number' },
        { key: 'AdvancedGameSettings',  label: 'Enable Advanced Settings', type: 'bool' },
        { key: 'NetworkQuality',        label: 'Network Quality (0-3)',    type: 'number' },
      ]},
    ],
  },
  '7 Days to Die': {
    file: 'serverconfig.xml',
    type: 'xml',
    props: [
      { group: '🌍 Server', props: [
        { key: 'ServerName',           label: 'Server Name',        type: 'text', basic: true },
        { key: 'ServerDescription',    label: 'Description',        type: 'text' },
        { key: 'ServerWebsiteURL',     label: 'Website URL',        type: 'text' },
        { key: 'ServerPort',           label: 'Port',               type: 'number', basic: true },
        { key: 'ServerMaxPlayerCount', label: 'Max Players',        type: 'number' },
        { key: 'ServerPassword',       label: 'Password',           type: 'text', basic: true },
        { key: 'ServerLoginConfirmationText', label: 'Login Message', type: 'text' },
        { key: 'ServerReservedSlots',  label: 'Reserved Slots',     type: 'number' },
        { key: 'ServerIsPublic',       label: 'Public Server',      type: 'bool' },
        { key: 'ServerVisibility',     label: 'Visibility (0-2)',   type: 'number' },
        { key: 'ServerDisabledNetworkProtocols', label: 'Disabled Protocols', type: 'text' },
      ]},
      { group: '⚔️ Difficulty & Gameplay', props: [
        { key: 'GameDifficulty',       label: 'Difficulty (0-5)',   type: 'number', min: 0, max: 5 },
        { key: 'GameMode',             label: 'Game Mode',          type: 'select', options: ['GameModeSurvival','GameModeCreative'] },
        { key: 'DayNightLength',       label: 'Day Length (min)',   type: 'number' },
        { key: 'DayLightLength',       label: 'Daylight Hours (h)', type: 'number' },
        { key: 'BloodMoonEnemyCount',  label: 'Blood Moon Enemy Count', type: 'number' },
        { key: 'BloodMoonFrequency',   label: 'Blood Moon Days',    type: 'number' },
        { key: 'BloodMoonRange',       label: 'Blood Moon Random Range', type: 'number' },
        { key: 'DropOnDeath',          label: 'Drop on Death',      type: 'select', options: ['0','1','2','3','4'] },
        { key: 'DropOnQuit',           label: 'Drop on Quit',       type: 'select', options: ['0','1','2','3'] },
      ]},
      { group: '🧟 Zombies', props: [
        { key: 'ZombiesRun',           label: 'Zombie Speed (Day)', type: 'select', options: ['0','1','2','3','4'] },
        { key: 'EnemyDifficulty',      label: 'Enemy Difficulty (0-1)', type: 'number' },
        { key: 'EnemySpawnMode',       label: 'Enemy Spawn Mode',   type: 'select', options: ['0','1','2','3','4'] },
        { key: 'ZombieMove',           label: 'Zombie Move Speed',  type: 'select', options: ['0','1','2','3','4'] },
        { key: 'ZombieMoveNight',      label: 'Zombie Move (Night)',type: 'select', options: ['0','1','2','3','4'] },
        { key: 'ZombieFeralMove',      label: 'Feral Zombie Speed', type: 'select', options: ['0','1','2','3','4'] },
        { key: 'ZombieBMMove',         label: 'BloodMoon Zombie Speed', type: 'select', options: ['0','1','2','3','4'] },
      ]},
      { group: '📈 Rates & Multipliers', props: [
        { key: 'XPMultiplier',         label: 'XP Multiplier',      type: 'number' },
        { key: 'LootAbundance',        label: 'Loot Abundance',     type: 'number' },
        { key: 'LootRespawnDays',      label: 'Loot Respawn (days)',type: 'number' },
        { key: 'AirDropFrequency',     label: 'Air Drop Frequency (hrs)', type: 'number' },
        { key: 'AirDropMarker',        label: 'Air Drop Marker',    type: 'bool' },
      ]},
      { group: '🌿 World Generation', props: [
        { key: 'GameWorld',            label: 'World',              type: 'select', options: ['Navezgane','PREGEN10k','PREGEN8k','PREGEN6k','RWG'] },
        { key: 'WorldGenSeed',         label: 'World Seed',         type: 'text' },
        { key: 'WorldGenSize',         label: 'World Size',         type: 'number', placeholder: '4096-16384' },
        { key: 'GameName',             label: 'Save Name',          type: 'text' },
      ]},
      { group: '🏗 Building & Land Claims', props: [
        { key: 'BedrollDeadZoneSize',  label: 'Bedroll Deadzone (m)', type: 'number' },
        { key: 'BedrollExpiryTime',    label: 'Bedroll Expiry (days)',type: 'number' },
        { key: 'LandClaimCount',       label: 'Land Claims per Player', type: 'number' },
        { key: 'LandClaimSize',        label: 'Land Claim Size',    type: 'number' },
        { key: 'LandClaimDeadZone',    label: 'Land Claim Deadzone',type: 'number' },
        { key: 'LandClaimDecayMode',   label: 'Land Claim Decay',   type: 'select', options: ['0','1','2'] },
      ]},
      { group: '🔧 System', props: [
        { key: 'SaveGameFolder',       label: 'Save Folder',        type: 'text' },
        { key: 'ControlPanelEnabled', label: 'Control Panel',      type: 'bool' },
        { key: 'ControlPanelPort',    label: 'Control Panel Port', type: 'number' },
        { key: 'ControlPanelPassword',label: 'Control Panel Password', type: 'text' },
        { key: 'TelnetEnabled',       label: 'Telnet Enabled',     type: 'bool' },
        { key: 'TelnetPort',          label: 'Telnet Port',        type: 'number' },
        { key: 'TelnetPassword',      label: 'Telnet Password',    type: 'text' },
        { key: 'ServerLoginConfirmationText', label: 'Login Message', type: 'text' },
      ]},
    ],
  },
  'CS2': {
    file: 'csgo/cfg/server.cfg',
    props: [
      { group: '🌍 Server', props: [
        { key: 'hostname',           label: 'Server Name',       type: 'text', basic: true },
        { key: 'sv_password',        label: 'Password',          type: 'text', basic: true },
        { key: 'rcon_password',      label: 'RCON Password',     type: 'text' },
        { key: 'sv_maxplayers',      label: 'Max Players',       type: 'number' },
        { key: 'sv_region',          label: 'Region',            type: 'select', options: ['0','1','2','3','4','5','6','7','255'] },
        { key: 'sv_tags',            label: 'Server Tags',       type: 'text' },
      ]},
      { group: '⚔️ Gameplay', props: [
        { key: 'sv_cheats',          label: 'Allow Cheats',      type: 'bool01' },
        { key: 'sv_lan',             label: 'LAN Only',          type: 'bool01' },
        { key: 'mp_friendlyfire',    label: 'Friendly Fire',     type: 'bool01' },
        { key: 'mp_autoteambalance', label: 'Auto Team Balance', type: 'bool01' },
        { key: 'mp_timelimit',       label: 'Time Limit (min)',  type: 'number' },
        { key: 'mp_maxrounds',       label: 'Max Rounds',        type: 'number' },
        { key: 'mp_warmuptime',      label: 'Warmup Time (s)',   type: 'number' },
        { key: 'mp_freezetime',      label: 'Freeze Time (s)',   type: 'number' },
        { key: 'mp_roundtime',       label: 'Round Time (min)',  type: 'number' },
        { key: 'mp_startmoney',      label: 'Start Money',       type: 'number' },
        { key: 'mp_maxmoney',        label: 'Max Money',         type: 'number' },
        { key: 'mp_c4timer',         label: 'C4 Timer (s)',      type: 'number' },
        { key: 'mp_buytime',         label: 'Buy Time (s)',      type: 'number' },
        { key: 'sv_alltalk',         label: 'All Talk',          type: 'bool01' },
        { key: 'sv_deadtalk',        label: 'Dead Talk',         type: 'bool01' },
        { key: 'sv_pausable',        label: 'Pausable',          type: 'bool01' },
      ]},
      { group: '🎮 Match Format', props: [
        { key: 'game_type',          label: 'Game Type',         type: 'select', options: ['0','1','2','3'] },
        { key: 'game_mode',          label: 'Game Mode',         type: 'select', options: ['0','1','2','3'] },
        { key: 'mp_teamname_1',      label: 'Team 1 Name',       type: 'text' },
        { key: 'mp_teamname_2',      label: 'Team 2 Name',       type: 'text' },
        { key: 'mp_overtime_enable', label: 'Overtime Enabled',  type: 'bool01' },
        { key: 'mp_overtime_maxrounds', label: 'Overtime Rounds', type: 'number' },
        { key: 'mp_overtime_startmoney',label: 'Overtime Start Money', type: 'number' },
      ]},
      { group: '⚙️ Performance & Network', props: [
        { key: 'sv_mincmdrate',      label: 'Min CMD Rate',      type: 'number' },
        { key: 'sv_maxcmdrate',      label: 'Max CMD Rate',      type: 'number' },
        { key: 'sv_minrate',         label: 'Min Rate',          type: 'number' },
        { key: 'sv_maxrate',         label: 'Max Rate',          type: 'number' },
        { key: 'sv_mintickrate',     label: 'Min Tick Rate',     type: 'number' },
        { key: 'sv_maxtickrate',     label: 'Max Tick Rate',     type: 'number' },
        { key: 'fps_max',            label: 'FPS Cap',           type: 'number' },
      ]},
    ],
  },
  'Terraria': {
    file: 'serverconfig.txt',
    props: [
      { group: '🌍 Server', props: [
        { key: 'worldname',          label: 'World Name',        type: 'text', basic: true },
        { key: 'motd',               label: 'Message of Day',    type: 'text' },
        { key: 'port',               label: 'Port',              type: 'number', basic: true },
        { key: 'maxplayers',         label: 'Max Players',       type: 'number' },
        { key: 'password',           label: 'Password',          type: 'text', basic: true },
        { key: 'priority',           label: 'Process Priority',  type: 'select', options: ['0','1','2','3','4','5'] },
      ]},
      { group: '🌿 World Generation', props: [
        { key: 'autocreate',         label: 'World Size',        type: 'select', options: ['1','2','3'] },
        { key: 'difficulty',         label: 'Difficulty',        type: 'select', options: ['0','1','2','3'] },
        { key: 'seed',               label: 'World Seed',        type: 'text', placeholder: 'Leave blank for random' },
        { key: 'worldpath',          label: 'World Path',        type: 'text' },
        { key: 'banlist',            label: 'Banlist File',      type: 'text' },
      ]},
      { group: '⚙️ Server Options', props: [
        { key: 'secure',             label: 'VAC Secure',        type: 'bool01' },
        { key: 'language',           label: 'Language',          type: 'text', placeholder: 'en-US' },
        { key: 'upnp',               label: 'UPnP',              type: 'bool01' },
        { key: 'npcstream',          label: 'NPC Stream',        type: 'number' },
        { key: 'lowpriority',        label: 'Low Priority',      type: 'bool01' },
        { key: 'announcementboxrange', label: 'Announcement Box Range', type: 'number' },
      ]},
    ],
  },
  'Enshrouded': {
    file: 'enshrouded_server.json',
    type: 'json',
    props: [
      { group: '🌍 Server', props: [
        { key: 'name',                label: 'Server Name',        type: 'text', basic: true },
        { key: 'password',            label: 'Password',           type: 'text', basic: true },
        { key: 'gamePort',            label: 'Game Port',          type: 'number', basic: true },
        { key: 'queryPort',           label: 'Query Port',         type: 'number' },
        { key: 'slotCount',           label: 'Max Players',        type: 'number' },
        { key: 'ip',                  label: 'Bind IP',            type: 'text', placeholder: '0.0.0.0' },
        { key: 'saveDirectory',       label: 'Save Directory',     type: 'text' },
        { key: 'logDirectory',        label: 'Log Directory',      type: 'text' },
      ]},
      { group: '⚔️ Difficulty & Rates', props: [
        { key: 'gameSettingsPreset',        label: 'Preset',                type: 'select', options: ['Default','Relaxed','Hard','Custom'] },
        { key: 'playerHealthFactor',        label: 'Player Health',         type: 'number' },
        { key: 'playerManaFactor',          label: 'Player Mana',           type: 'number' },
        { key: 'playerStaminaFactor',       label: 'Player Stamina',        type: 'number' },
        { key: 'playerBodyHeatFactor',      label: 'Player Body Heat',      type: 'number' },
        { key: 'enableDurability',          label: 'Enable Durability',     type: 'bool' },
        { key: 'enableStarvingDebuff',      label: 'Starving Debuff',       type: 'bool' },
        { key: 'foodBuffDurationFactor',    label: 'Food Buff Duration',    type: 'number' },
        { key: 'fromHungerToStarving',      label: 'Hunger → Starving Time',type: 'number' },
        { key: 'shroudTimeFactor',          label: 'Shroud Time Multiplier',type: 'number' },
      ]},
      { group: '⚙️ Combat', props: [
        { key: 'tombstoneMode',             label: 'Tombstone Mode',        type: 'select', options: ['AddBackpackMaterials','Everything','None'] },
        { key: 'enableGliderTurbulences',   label: 'Glider Turbulences',    type: 'bool' },
        { key: 'weatherFrequency',          label: 'Weather Frequency',     type: 'select', options: ['Disabled','Rare','Normal','Often'] },
        { key: 'miningDamageFactor',        label: 'Mining Damage',         type: 'number' },
        { key: 'plantGrowthSpeedFactor',    label: 'Plant Growth Speed',    type: 'number' },
        { key: 'resourceDropStackAmountFactor', label: 'Resource Drop Multiplier', type: 'number' },
      ]},
      { group: '🎁 Loot & XP', props: [
        { key: 'factoryProductionSpeedFactor', label: 'Factory Speed',      type: 'number' },
        { key: 'perkUpgradeRecyclingFactor',   label: 'Perk Recycling',      type: 'number' },
        { key: 'perkCostFactor',            label: 'Perk Cost',              type: 'number' },
        { key: 'experienceCombatFactor',    label: 'Combat XP',              type: 'number' },
        { key: 'experienceMiningFactor',    label: 'Mining XP',              type: 'number' },
        { key: 'experienceExplorationQuestsFactor', label: 'Exploration XP', type: 'number' },
        { key: 'randomSpawnerAmount',       label: 'Random Spawn Amount',    type: 'select', options: ['Off','Few','Normal','Many'] },
        { key: 'aggroPoolAmount',           label: 'Aggro Pool',             type: 'select', options: ['Off','Few','Normal','Many'] },
      ]},
    ],
  },
  'Palworld': {
    file: 'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini',
    props: [
      { group: '🌍 Server', props: [
        { key: 'ServerName',        label: 'Server Name',     type: 'text', basic: true },
        { key: 'ServerDescription', label: 'Description',     type: 'text' },
        { key: 'ServerPassword',    label: 'Password',        type: 'text', basic: true },
        { key: 'AdminPassword',     label: 'Admin Password',  type: 'text' },
        { key: 'PublicPort',        label: 'Port',            type: 'number', basic: true },
        { key: 'ServerPlayerMaxNum',label: 'Max Players',     type: 'number' },
        { key: 'CoopPlayerMaxNum',  label: 'Max Co-op Players', type: 'number' },
      ]},
      { group: '🌐 Community Listing', props: [
        { key: 'showInPublicList', label: 'Show in Community Server List',
          type: 'serverBool',
          basic: true,
          desc: 'Adds -publiclobby flag + EpicApp=PalServer. Also requires port 27015 (TCP/UDP) open in firewall.' },
      ]},
      { group: '⚔️ Difficulty & Rates', props: [
        { key: 'Difficulty',        label: 'Difficulty',      type: 'select', options: ['None','Normal','Difficult'] },
        { key: 'ExpRate',           label: 'XP Rate',         type: 'number' },
        { key: 'PalCaptureRate',    label: 'Pal Capture Rate',type: 'number' },
        { key: 'PalSpawnNumRate',   label: 'Pal Spawn Rate',  type: 'number' },
        { key: 'PalDamageRateAttack',label:'Pal Damage Dealt',type: 'number' },
        { key: 'PalDamageRateDefense',label:'Pal Damage Taken',type: 'number' },
        { key: 'PlayerDamageRateAttack',label:'Player Damage Dealt',type: 'number' },
        { key: 'PlayerDamageRateDefense',label:'Player Damage Taken',type: 'number' },
      ]},
      { group: '⏱ Day/Night & Weather', props: [
        { key: 'DayTimeSpeedRate',       label: 'Day Time Speed',     type: 'number' },
        { key: 'NightTimeSpeedRate',     label: 'Night Time Speed',   type: 'number' },
        { key: 'PlayerStomachDecreaceRate', label: 'Player Hunger Rate',    type: 'number' },
        { key: 'PlayerStaminaDecreaceRate', label: 'Player Stamina Drain',   type: 'number' },
        { key: 'PlayerAutoHPRegeneRate',    label: 'Player Auto Heal Rate',  type: 'number' },
        { key: 'PlayerAutoHpRegeneRateInSleep', label: 'Player Heal Sleep Rate', type: 'number' },
      ]},
      { group: '🐾 Pals', props: [
        { key: 'PalStomachDecreaceRate',  label: 'Pal Hunger Rate',    type: 'number' },
        { key: 'PalStaminaDecreaceRate',  label: 'Pal Stamina Drain',  type: 'number' },
        { key: 'PalAutoHPRegeneRate',     label: 'Pal Auto Heal Rate', type: 'number' },
        { key: 'PalEggDefaultHatchingTime', label: 'Egg Hatch Time (hrs)', type: 'number' },
      ]},
      { group: '🏗 Building & Base', props: [
        { key: 'BuildObjectDamageRate',   label: 'Building Damage Rate', type: 'number' },
        { key: 'BuildObjectDeteriorationDamageRate', label: 'Building Decay Rate', type: 'number' },
        { key: 'CollectionDropRate',      label: 'Gather Drop Rate',   type: 'number' },
        { key: 'CollectionObjectHpRate',  label: 'Gather Object HP',   type: 'number' },
        { key: 'CollectionObjectRespawnSpeedRate', label: 'Gather Respawn Speed', type: 'number' },
        { key: 'EnemyDropItemRate',       label: 'Enemy Item Drop Rate', type: 'number' },
        { key: 'GuildPlayerMaxNum',       label: 'Max Guild Size',     type: 'number' },
        { key: 'BaseCampWorkerMaxNum',    label: 'Max Base Workers',   type: 'number' },
      ]},
      { group: '💀 Death & PvP', props: [
        { key: 'DeathPenalty',            label: 'Death Penalty',
          type: 'select', options: ['None','Item','ItemAndEquipment','All'] },
        { key: 'bEnablePlayerToPlayerDamage', label: 'PvP Damage Enabled', type: 'bool' },
        { key: 'bEnableFriendlyFire',     label: 'Friendly Fire',      type: 'bool' },
        { key: 'bEnableInvaderEnemy',     label: 'Enable Raid Attacks', type: 'bool' },
        { key: 'bActiveUNKO',             label: 'Active UNKO',        type: 'bool' },
        { key: 'bEnableAimAssistPad',     label: 'Aim Assist (Controller)', type: 'bool' },
        { key: 'bEnableAimAssistKeyboard',label: 'Aim Assist (Keyboard)',   type: 'bool' },
      ]},
      { group: '🔧 System', props: [
        { key: 'DropItemMaxNum',          label: 'Max Dropped Items',  type: 'number' },
        { key: 'DropItemMaxNum_UNKO',     label: 'Max UNKO Drops',     type: 'number' },
        { key: 'DropItemAliveMaxHours',   label: 'Item Despawn (hrs)', type: 'number' },
        { key: 'bAutoResetGuildNoOnlinePlayers', label: 'Auto-Reset Empty Guilds', type: 'bool' },
        { key: 'AutoResetGuildTimeNoOnlinePlayers', label: 'Guild Reset Time (hrs)', type: 'number' },
        { key: 'AutoSaveSpan',            label: 'Auto-save Interval (s)', type: 'number' },
        { key: 'bIsMultiplay',            label: 'Multiplayer Enabled',type: 'bool' },
        { key: 'bIsPvP',                  label: 'PvP Enabled',        type: 'bool' },
        { key: 'bHardcore',               label: 'Hardcore Mode',      type: 'bool' },
        { key: 'RCONEnabled',             label: 'RCON Enabled',       type: 'bool' },
        { key: 'RCONPort',                label: 'RCON Port',          type: 'number' },
      ]},
    ],
  },
};

// Enhanced read-config that handles multiple file types
ipcMain.handle('read-server-config', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server?.installDir) return { ok: false, error: 'No install directory' };

  if (server.game === 'Minecraft') {
    const propsPath = path.join(server.installDir, 'server.properties');
    if (!fs.existsSync(propsPath)) return { ok: false, error: 'server.properties not found. Start the server once to generate it.' };
    const raw = fs.readFileSync(propsPath, 'utf8');
    const props = {};
    raw.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq === -1) return;
      props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
    return { ok: true, type: 'minecraft', props };
  }

  // Steam game configs
  const def = GAME_CONFIG_DEFS[server.game];
  if (def) {
    // Prefer the exact path from the schema (e.g. 'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini')
    // Falls back to a recursive search if the file isn't at the expected location.
    let configPath = null;
    if (def.file) {
      const expected = path.join(server.installDir, def.file.replace(/\//g, path.sep));
      if (fs.existsSync(expected)) configPath = expected;
    }
    if (!configPath) {
      configPath = findFileRecursive(server.installDir, def.file?.split('/').pop() || '', 6);
    }

    // Palworld: auto-generate the config from our embedded template if it doesn't exist yet
    if (!configPath && server.game === 'Palworld') {
      try {
        syncServerConfig(server.id, server, /* isInstall */ false);
        const expected = path.join(server.installDir, 'Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini');
        if (fs.existsSync(expected)) configPath = expected;
      } catch(e) {}
    }

    if (!configPath) {
      return { ok: true, type: 'steam', game: server.game, props: {}, defs: def, empty: true,
        error: `Config file not found. Start the server once to generate it.` };
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      let props = {};

      if (def.type === 'json') {
        try { props = JSON.parse(raw); } catch(e) {}
      } else if (def.type === 'xml') {
        // Parse XML property elements: <property name="key" value="val"/>
        const matches = raw.matchAll(/<property[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g);
        for (const m of matches) props[m[1]] = m[2];
      } else {
        // INI/CFG style: key=value or key value
        raw.split('\n').forEach(line => {
          line = line.trim();
          if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) return;
          const eq = line.indexOf('=');
          if (eq > -1) {
            props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          } else {
            const sp = line.indexOf(' ');
            if (sp > -1) props[line.slice(0, sp).trim()] = line.slice(sp + 1).trim();
          }
        });

        // Palworld special case: values are crammed inside OptionSettings=(...)
        // Extract them so the UI can render each field individually
        if (server.game === 'Palworld' && props.OptionSettings) {
          const inner = props.OptionSettings.replace(/^\(/, '').replace(/\)$/, '');
          // Split on commas that aren't inside quoted strings
          const parts = [];
          let current = '', inQuote = false;
          for (const ch of inner) {
            if (ch === '"') { inQuote = !inQuote; current += ch; }
            else if (ch === ',' && !inQuote) { parts.push(current); current = ''; }
            else current += ch;
          }
          if (current.trim()) parts.push(current);
          for (const p of parts) {
            const eq = p.indexOf('=');
            if (eq > -1) {
              const k = p.slice(0, eq).trim();
              let v = p.slice(eq + 1).trim();
              // Strip surrounding quotes on string values
              if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
              props[k] = v;
            }
          }
          delete props.OptionSettings; // hide the raw tuple from UI
        }
      }

      return { ok: true, type: 'steam', game: server.game, props, defs: def, configPath };
    } catch(err) {
      return { ok: false, error: err.message };
    }
  }

  return { ok: true, type: 'unsupported', game: server.game };
});

// Write steam game config
ipcMain.handle('write-steam-config', (e, { id, props, configPath }) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server?.installDir || !configPath) return { ok: false };

  try {
    const def = GAME_CONFIG_DEFS[server.game];
    if (!def) return { ok: false, error: 'No config definition' };

    if (def.type === 'json') {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8') || '{}');
      const merged = { ...existing, ...props };
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
    } else if (def.type === 'xml') {
      let raw = fs.readFileSync(configPath, 'utf8');
      for (const [key, val] of Object.entries(props)) {
        raw = raw.replace(
          new RegExp(`(<property[^>]+name="${key}"[^>]+value=")[^"]*(")`),
          `$1${val}$2`
        );
      }
      fs.writeFileSync(configPath, raw);
    } else {
      // INI/CFG
      let raw = fs.readFileSync(configPath, 'utf8');

      // Palworld special case: all settings live inside OptionSettings=(...)
      if (server.game === 'Palworld' && raw.includes('OptionSettings=(')) {
        // Extract, patch, and re-serialize the tuple
        const tupleMatch = raw.match(/OptionSettings=\(([\s\S]*?)\)/);
        if (tupleMatch) {
          const inner = tupleMatch[1];
          // Parse existing tuple into a Map preserving order
          const existing = new Map();
          const parts = [];
          let current = '', inQuote = false;
          for (const ch of inner) {
            if (ch === '"') { inQuote = !inQuote; current += ch; }
            else if (ch === ',' && !inQuote) { parts.push(current); current = ''; }
            else current += ch;
          }
          if (current.trim()) parts.push(current);
          for (const p of parts) {
            const eq = p.indexOf('=');
            if (eq > -1) existing.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
          }
          // Apply changes from props
          const stringKeys = new Set(['ServerName','ServerDescription','ServerPassword','AdminPassword','PublicIP','RegionCode','BanListURL']);
          for (const [k, v] of Object.entries(props)) {
            if (stringKeys.has(k)) {
              existing.set(k, `"${String(v).replace(/"/g,'')}"`);
            } else {
              existing.set(k, String(v));
            }
          }
          const newTuple = Array.from(existing.entries()).map(([k,v]) => `${k}=${v}`).join(',');
          raw = raw.replace(/OptionSettings=\([\s\S]*?\)/, `OptionSettings=(${newTuple})`);
          fs.writeFileSync(configPath, raw);
          return { ok: true };
        }
      }

      const lines = raw.split('\n');
      const updated = new Set();
      const result = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('[')) return line;
        const eq = trimmed.indexOf('=');
        const sp = trimmed.indexOf(' ');
        const sep = eq > -1 ? eq : sp;
        if (sep === -1) return line;
        const key = trimmed.slice(0, sep).trim();
        if (key in props) { updated.add(key); return `${key}${eq > -1 ? '=' : ' '}${props[key]}`; }
        return line;
      });
      // Append any new keys
      for (const [k, v] of Object.entries(props)) {
        if (!updated.has(k)) result.push(`${k}=${v}`);
      }
      fs.writeFileSync(configPath, result.join('\n'));
    }
    return { ok: true };
  } catch(err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('write-server-config', (e, { id, props }) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server?.installDir) return { ok: false };
  const propsPath = path.join(server.installDir, 'server.properties');
  if (!fs.existsSync(propsPath)) return { ok: false, error: 'server.properties not found' };

  // Read existing file to preserve comments and ordering
  const raw = fs.readFileSync(propsPath, 'utf8');
  const lines = raw.split('\n');
  const updated = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in props) return `${key}=${props[key]}`;
    return line;
  });

  // Add any new keys that weren't in the file
  const existingKeys = new Set(lines.map(l => l.split('=')[0].trim()));
  Object.entries(props).forEach(([k, v]) => {
    if (!existingKeys.has(k)) updated.push(`${k}=${v}`);
  });

  fs.writeFileSync(propsPath, updated.join('\n'));
  return { ok: true };
});

function findFileRecursive(dir, name, maxDepth = 3) {
  if (maxDepth === 0) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === name) return path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileRecursive(path.join(dir, entry.name), name, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch(e) {}
  return null;
}



// ── Backup System ─────────────────────────────────────────────────────────────
const BACKUPS_DIR = path.join(USER_DATA, 'backups');
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

function getServerBackupDir(serverId) {
  const dir = path.join(BACKUPS_DIR, serverId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getBackupList(serverId) {
  const dir = getServerBackupDir(serverId);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const full = path.join(dir, e.name);
        const meta = path.join(full, 'backup-meta.json');
        let info = {};
        try { info = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch(err) {}
        return {
          id:      e.name,
          path:    full,
          size:    getDirSize(full),
          created: info.created || e.name,
          label:   info.label   || e.name,
          trigger: info.trigger || 'manual',
        };
      })
      .sort((a, b) => b.created - a.created);
  } catch(e) { return []; }
}

async function createBackup(serverId, label = 'Manual backup', trigger = 'manual') {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server?.installDir || !fs.existsSync(server.installDir)) {
    throw new Error('Server install directory not found');
  }

  const backupId  = `backup_${Date.now()}`;
  const backupDir = path.join(getServerBackupDir(serverId), backupId);
  fs.mkdirSync(backupDir, { recursive: true });

  log(serverId, 'info', `Creating backup: ${label}...`);

  // Determine what to back up — world data and configs only, not binaries
  const foldersToBackup = ['world', 'world_nether', 'world_the_end', 'saves', 'config', 'mods', 'plugins'];
  const filesToBackup   = ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json'];

  let backedUp = 0;

  // Copy relevant folders
  for (const folder of foldersToBackup) {
    const src = path.join(server.installDir, folder);
    if (fs.existsSync(src)) {
      const dest = path.join(backupDir, folder);
      fs.cpSync(src, dest, { recursive: true });
      backedUp++;
      log(serverId, 'dim', `  Backed up: ${folder}/`);
    }
  }

  // Copy config files
  for (const file of filesToBackup) {
    const src = path.join(server.installDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, file));
      backedUp++;
    }
  }

  if (backedUp === 0) {
    // Fall back to backing up everything except binaries and Java
    const skip = new Set(['_java', 'steamcmd', 'logs', 'crash-reports']);
    for (const entry of fs.readdirSync(server.installDir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.endsWith('.exe') || entry.name.endsWith('.dll')) continue;
      const src  = path.join(server.installDir, entry.name);
      const dest = path.join(backupDir, entry.name);
      if (entry.isDirectory()) fs.cpSync(src, dest, { recursive: true });
      else fs.copyFileSync(src, dest);
    }
  }

  // Write metadata
  const meta = {
    label,
    trigger,
    created:    Date.now(),
    serverId,
    serverName: server.name,
    game:       server.game,
    mcVersion:  server.mcVersion,
    mcType:     server.mcType,
  };
  fs.writeFileSync(path.join(backupDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));

  // Enforce retention — keep max 10 backups per server
  const keepCount = appData.servers.find(s=>s.id===serverId)?.backupSettings?.keepCount ?? 10;
  await enforceRetention(serverId, keepCount > 0 ? keepCount : 999);

  const size = getDirSize(backupDir);
  log(serverId, 'success', `✔ Backup complete: ${label} (${formatBytesNative(size)})`);
  if (trigger !== 'manual') {
    notify('backup', {
      title: `💾 Backup complete — ${server.name}`,
      body: `${label} (${formatBytesNative(size)})`,
      fields: [
        { name: 'Server', value: server.name, inline: true },
        { name: 'Size', value: formatBytesNative(size), inline: true },
      ],
    });
  }
  return { id: backupId, size, label };
}

function formatBytesNative(bytes) {
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)     return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function enforceRetention(serverId, maxBackups) {
  const backups = getBackupList(serverId);
  if (backups.length <= maxBackups) return;
  const toDelete = backups.slice(maxBackups);
  for (const b of toDelete) {
    try {
      fs.rmSync(b.path, { recursive: true, force: true });
      console.log(`[Backup] Deleted old backup: ${b.label}`);
    } catch(e) {}
  }
}

async function restoreBackup(serverId, backupId) {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server?.installDir) throw new Error('Server not found');
  if (serverProcesses[serverId]) throw new Error('Stop the server before restoring');

  const backupDir = path.join(getServerBackupDir(serverId), backupId);
  if (!fs.existsSync(backupDir)) throw new Error('Backup not found');

  log(serverId, 'warn', 'Restoring from backup...');

  // Remove existing world/config files before restore
  const toClean = ['world', 'world_nether', 'world_the_end', 'saves', 'server.properties',
    'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'config', 'mods', 'plugins'];
  for (const item of toClean) {
    const target = path.join(server.installDir, item);
    try {
      if (fs.existsSync(target)) {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      }
    } catch(e) {}
  }

  // Copy backup contents back
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (entry.name === 'backup-meta.json') continue;
    const src  = path.join(backupDir, entry.name);
    const dest = path.join(server.installDir, entry.name);
    if (entry.isDirectory()) fs.cpSync(src, dest, { recursive: true });
    else fs.copyFileSync(src, dest);
  }

  log(serverId, 'success', '✔ Restore complete. Start the server to apply.');
}

// IPC handlers
ipcMain.handle('get-backups',      (e, id)              => getBackupList(id));
ipcMain.handle('create-backup',    async (e, { id, label }) => createBackup(id, label, 'manual'));
ipcMain.handle('restore-backup',   async (e, { serverId, backupId }) => {
  try { await restoreBackup(serverId, backupId); return { ok: true }; }
  catch(err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('delete-backup',    (e, { serverId, backupId }) => {
  const dir = path.join(getServerBackupDir(serverId), backupId);
  try { fs.rmSync(dir, { recursive: true, force: true }); return { ok: true }; } catch(e) { return { ok: false }; }
});
ipcMain.handle('get-backup-settings', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  return server?.backupSettings || { enabled: false, interval: 'daily', keepCount: 10 };
});
ipcMain.handle('save-backup-settings', (e, { id, settings }) => {
  const server = appData.servers.find(s => s.id === id);
  if (server) { server.backupSettings = settings; saveData(); }
  return { ok: true };
});

// Auto-backup scheduler — runs every hour, checks per-server settings
setInterval(async () => {
  const now  = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  for (const server of appData.servers) {
    const bs = server.backupSettings;
    if (!bs?.enabled || server.status !== 'online') continue;
    let shouldRun = false;
    if (bs.interval === 'hourly') shouldRun = true;
    if (bs.interval === 'daily'  && hhmm === (bs.time || '03:00')) shouldRun = true;
    if (bs.interval === '6hours' && now.getHours() % 6 === 0 && now.getMinutes() === 0) shouldRun = true;
    if (shouldRun) {
      try {
        await createBackup(server.id, `Auto backup (${bs.interval})`, 'auto');
        emit('backup-created', { serverId: server.id });
      } catch(e) { console.error('Auto-backup failed:', e.message); }
    }
  }
}, 60000);


// ── Server notes ─────────────────────────────────────────────────────────────
ipcMain.handle('save-notes', (e, { id, notes }) => {
  const server = appData.servers.find(s => s.id === id);
  if (server) { server.notes = notes; saveData(); }
  return { ok: true };
});


// ── Player management ─────────────────────────────────────────────────────────
ipcMain.handle('get-players', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  return server?.players || [];
});

ipcMain.handle('player-action', async (e, { serverId, action, player }) => {
  const server = appData.servers.find(s => s.id === serverId);
  const proc = serverProcesses[serverId];
  if (!proc) return { ok: false, error: 'Server not running' };

  // Palworld: kick/ban via RCON using the player's Steam ID.
  if (server && server.game === 'Palworld') {
    if (!server.rconPassword) return { ok: false, error: 'RCON not ready — stop and start the server once.' };
    const rc = { kick: 'KickPlayer', ban: 'BanPlayer' }[action];
    if (!rc) return { ok: false, error: 'Only kick and ban are available for Palworld.' };
    if (!player) return { ok: false, error: 'Missing player Steam ID.' };
    const res = await rconCommand('127.0.0.1', server.rconPort || 25575, server.rconPassword, `${rc} ${player}`);
    if (res === null) return { ok: false, error: 'RCON command failed.' };
    setTimeout(() => pollPalworldPlayers(server), 1500); // refresh the list after the action
    return { ok: true };
  }

  // Minecraft-style stdin commands.
  const commands = {
    kick:  `kick ${player}`,
    ban:   `ban ${player}`,
    op:    `op ${player}`,
    deop:  `deop ${player}`,
    msg:   `msg ${player} Message from admin`,
  };
  const cmd = commands[action];
  if (!cmd) return { ok: false, error: 'Unknown action' };
  try { proc.stdin.write(cmd + '\n'); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('send-player-command', (e, { serverId, command }) => {
  const proc = serverProcesses[serverId];
  if (!proc) return { ok: false, error: 'Not running' };
  try { proc.stdin.write(command + '\n'); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});


// ── Auto-restart ──────────────────────────────────────────────────────────────
ipcMain.handle('get-autorestart', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  return server?.autoRestart || { enabled: false, maxRetries: 3, cooldown: 10 };
});

ipcMain.handle('save-autorestart', (e, { id, settings }) => {
  const server = appData.servers.find(s => s.id === id);
  if (server) { server.autoRestart = settings; saveData(); }
  return { ok: true };
});


// ── Log file browser ──────────────────────────────────────────────────────────
ipcMain.handle('get-log-files', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server?.installDir) return [];
  const logDirs = [
    path.join(server.installDir, 'logs'),
    path.join(server.installDir, 'crash-reports'),
    server.installDir,
  ];
  const results = [];
  for (const dir of logDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!['.log','.txt','.gz','.json'].some(ext => e.name.endsWith(ext))) continue;
        const full = path.join(dir, e.name);
        const stat = fs.statSync(full);
        results.push({
          name:     e.name,
          path:     full,
          size:     stat.size,
          modified: stat.mtime.getTime(),
          dir:      path.basename(dir),
        });
      }
    } catch(e) {}
  }
  return results.sort((a, b) => b.modified - a.modified);
});

ipcMain.handle('read-log-file', (e, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) {
      // Large file — read last 500KB only
      const buf = Buffer.alloc(512 * 1024);
      const fd  = fs.openSync(filePath, 'r');
      const offset = Math.max(0, stat.size - 512 * 1024);
      fs.readSync(fd, buf, 0, 512 * 1024, offset);
      fs.closeSync(fd);
      return { ok: true, content: '... [file truncated - showing last 500KB] ...\n\n' + buf.toString('utf8'), truncated: true };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('open-log-folder', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server?.installDir) return;
  const logsDir = path.join(server.installDir, 'logs');
  require('electron').shell.openPath(fs.existsSync(logsDir) ? logsDir : server.installDir);
});

ipcMain.handle('open-server-folder', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server?.installDir) return { ok: false, error: 'Server not found' };
  if (!fs.existsSync(server.installDir)) return { ok: false, error: 'Install folder does not exist' };
  require('electron').shell.openPath(server.installDir);
  return { ok: true };
});

// ── Mod / Plugin manager ──────────────────────────────────────────────────────
ipcMain.handle('search-modrinth', async (e, { query, loader, gameVersion }) => {
  try {
    const params = new URLSearchParams({
      query,
      limit: '20',
      facets: JSON.stringify([
        [`project_type:mod`],
        loader     ? [`categories:${loader}`]    : [],
        gameVersion? [`versions:${gameVersion}`] : [],
      ].filter(f => f.length)),
    });
    const data = await fetchJSON(`https://api.modrinth.com/v2/search?${params}`);
    return { ok: true, hits: data.hits || [] };
  } catch(e) { return { ok: false, hits: [], error: e.message }; }
});

ipcMain.handle('get-modrinth-versions', async (e, { projectId, gameVersion, loader }) => {
  try {
    const params = new URLSearchParams();
    if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
    if (loader)      params.set('loaders',       JSON.stringify([loader]));
    const data = await fetchJSON(`https://api.modrinth.com/v2/project/${projectId}/version?${params}`);
    return { ok: true, versions: data };
  } catch(e) { return { ok: false, versions: [] }; }
});

ipcMain.handle('install-mod', async (e, { serverId, downloadUrl, filename }) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server?.installDir) return { ok: false, error: 'Server not found' };

  // Determine mods folder
  const modsDir = path.join(server.installDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  const destPath = path.join(modsDir, filename);
  log(serverId, 'info', `Installing mod: ${filename}...`);

  try {
    await downloadFile(downloadUrl, destPath, pct => {
      emit('console-progress', { serverId, text: `Downloading ${filename}... ${pct}%` });
    });
    log(serverId, 'success', `✔ Mod installed: ${filename}`);
    return { ok: true };
  } catch(err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-installed-mods', (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server?.installDir) return [];
  const modsDir = path.join(server.installDir, 'mods');
  if (!fs.existsSync(modsDir)) return [];
  try {
    return fs.readdirSync(modsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.jar'))
      .map(e => {
        const full = path.join(modsDir, e.name);
        return { name: e.name, size: fs.statSync(full).size, path: full };
      });
  } catch(e) { return []; }
});

ipcMain.handle('delete-mod', (e, { serverId, modPath }) => {
  try { fs.unlinkSync(modPath); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});


// ── Settings ──────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch(e) {}
  return {
    startMinimized:      false,
    minimizeToTray:      false,
    notifications:       true,
    notifyOnCrash:       true,
    notifyOnStart:       false,
    notifyOnStop:        false,
    notifyOnBackup:      true,
    notifyOnPlayerJoin:  false,
    discordEnabled:      false,
    discordWebhookUrl:   '',
    maxConsoleLines:     500,
    defaultBackupKeep:   10,
    autoStartServers:    [],
    theme:               'dark',
    consoleFont:         'Share Tech Mono',
    consoleFontSize:     12,
    appTextScale:        1,
  };
}

function saveSettings(settings) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch(e) {}
}

let appSettings = loadSettings();

ipcMain.handle('get-settings', () => appSettings);
ipcMain.handle('save-settings', (e, settings) => {
  appSettings = { ...appSettings, ...settings };
  saveSettings(appSettings);
  applySettings();
  return { ok: true };
});

function applySettings() {
  // Apply console font size etc via emit
  emit('settings-changed', appSettings);
}


// ── Notifications ─────────────────────────────────────────────────────────────
function sendNotification(title, body, urgency = 'normal') {
  if (!appSettings.notifications) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      new Notification({ title, body, urgency }).show();
    }
  } catch(e) {}
}

// Post a rich embed to a Discord webhook. Resolves { ok, error } and never throws.
function postDiscordWebhook(webhookUrl, { title, description, color, fields }) {
  return new Promise(resolve => {
    if (!webhookUrl || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//i.test(webhookUrl.trim())) {
      return resolve({ ok: false, error: 'Invalid Discord webhook URL' });
    }
    let payload;
    try {
      const embed = { title, description, color: typeof color === 'number' ? color : 0x5865F2, timestamp: new Date().toISOString(), footer: { text: 'Omnex' } };
      if (Array.isArray(fields) && fields.length) embed.fields = fields;
      payload = JSON.stringify({ username: 'Omnex', embeds: [embed] });
    } catch(e) { return resolve({ ok: false, error: 'Failed to build payload' }); }

    let u;
    try { u = new URL(webhookUrl.trim()); } catch(e) { return resolve({ ok: false, error: 'Invalid webhook URL' }); }
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Omnex/1.0' },
    };
    const req = https.request(opts, res => {
      res.resume(); // drain
      if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
      else resolve({ ok: false, error: `Discord returned HTTP ${res.statusCode}` });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

// Discord embed colors per event type.
const NOTIFY_COLORS = { crash: 0xED4245, start: 0x57F287, stop: 0x99AAB5, backup: 0x5865F2, playerJoin: 0x57F287, playerLeave: 0xFAA61A };

// Unified notification dispatcher. Fires a Windows toast (respecting `notifications`
// + the per-event toggle) AND a Discord webhook (respecting `discordEnabled` + the
// same per-event toggle). `event` is one of crash|start|stop|backup|playerJoin|playerLeave.
function notify(event, { title, body, fields, urgency = 'normal' }) {
  const toggleKey = {
    crash: 'notifyOnCrash', start: 'notifyOnStart', stop: 'notifyOnStop',
    backup: 'notifyOnBackup', playerJoin: 'notifyOnPlayerJoin', playerLeave: 'notifyOnPlayerJoin',
  }[event];
  const enabled = toggleKey ? appSettings[toggleKey] : true;
  if (!enabled) return;

  sendNotification(title, body, urgency);

  if (appSettings.discordEnabled && appSettings.discordWebhookUrl) {
    postDiscordWebhook(appSettings.discordWebhookUrl, {
      title, description: body, color: NOTIFY_COLORS[event], fields,
    }).catch(() => {});
  }
}

ipcMain.handle('test-discord-webhook', async (e, url) => {
  const webhook = (url && url.trim()) || appSettings.discordWebhookUrl;
  return postDiscordWebhook(webhook, {
    title: '✅ Omnex connected',
    description: 'This is a test message. Your Discord webhook is working — Omnex will post server events here.',
    color: NOTIFY_COLORS.start,
  });
});


// ── Server Templates ──────────────────────────────────────────────────────────
const TEMPLATES_FILE = path.join(USER_DATA, 'templates.json');

function loadTemplates() {
  try {
    if (fs.existsSync(TEMPLATES_FILE)) return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch(e) {}
  return [];
}
function saveTemplates(templates) {
  try { fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2)); } catch(e) {}
}

ipcMain.handle('get-templates', () => loadTemplates());

ipcMain.handle('save-template', (e, { serverId, name }) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return { ok: false };
  const templates = loadTemplates();
  const template = {
    id:          `tpl_${Date.now()}`,
    name:        name || `${server.name} Template`,
    game:        server.game,
    icon:        server.icon,
    fallback:    server.fallback,
    port:        server.port,
    mcType:      server.mcType,
    mcVersion:   server.mcVersion,
    args:        server.args,
    notes:       server.notes,
    autoRestart: server.autoRestart,
    backupSettings: server.backupSettings,
    createdAt:   Date.now(),
  };
  templates.push(template);
  saveTemplates(templates);
  return { ok: true, template };
});

ipcMain.handle('delete-template', (e, id) => {
  const templates = loadTemplates().filter(t => t.id !== id);
  saveTemplates(templates);
  return { ok: true };
});

// ── Remote Access (local network) ─────────────────────────────────────────────
let remoteServer = null;
let remotePort   = 54321;

ipcMain.handle('start-remote-access', async (e, port) => {
  if (remoteServer) return { ok: false, error: 'Already running' };
  remotePort = port || 54321;
  try {
    const http = require('http');
    const os   = require('os');

    remoteServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/api/servers') {
        const data = appData.servers.map(s => ({
          id: s.id, name: s.name, game: s.game,
          status: serverProcesses[s.id] ? 'online' : 'offline',
          port: s.port, players: s.players || [],
          mcVersion: s.mcVersion, mcType: s.mcType,
        }));
        res.end(JSON.stringify(data));
      } else if (req.url === '/api/status') {
        res.end(JSON.stringify({ ok: true, version: app.getVersion(), servers: appData.servers.length }));
      } else if (req.method === 'POST' && (req.url === '/api/action' || req.url === '/')) {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { action, serverId } = JSON.parse(body);
            if (action === 'start')   startServerById(serverId).then(() => res.end(JSON.stringify({ ok: true })));
            else if (action === 'stop') killServer(serverId).then(() => res.end(JSON.stringify({ ok: true })));
            else if (action === 'restart') {
              killServer(serverId).then(() => setTimeout(() => startServerById(serverId), 2000));
              res.end(JSON.stringify({ ok: true }));
            } else res.end(JSON.stringify({ ok: false, error: 'Unknown action' }));
          } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
        });
      } else {
        // Serve a simple mobile-friendly dashboard page
        res.setHeader('Content-Type', 'text/html');
        const html = generateRemoteDashboard();
        res.end(html);
      }
    });

    remoteServer.listen(remotePort);

    // Get local IP
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) { localIp = addr.address; break; }
      }
      if (localIp !== 'localhost') break;
    }

    return { ok: true, port: remotePort, ip: localIp, url: `http://${localIp}:${remotePort}` };
  } catch(err) {
    remoteServer = null;
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stop-remote-access', () => {
  if (remoteServer) { remoteServer.close(); remoteServer = null; }
  return { ok: true };
});

ipcMain.handle('get-remote-status', () => ({
  running: !!remoteServer,
  port:    remotePort,
}));

function generateRemoteDashboard() {
  const servers = appData.servers.map(s => ({
    id: s.id, name: s.name, game: s.game,
    status: serverProcesses[s.id] ? 'online' : 'offline',
    port: s.port, players: s.players || [],
  }));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Omnex Remote</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0c10;color:#c8d4e8;font-family:system-ui,sans-serif;padding:16px}
  h1{color:#00e5ff;font-size:20px;margin-bottom:4px;letter-spacing:2px}
  .sub{color:#5a6a80;font-size:12px;margin-bottom:20px}
  .card{background:#141820;border:1px solid #1e2535;border-radius:10px;padding:14px;margin-bottom:12px}
  .sname{font-weight:700;font-size:15px;color:#e8f0ff;margin-bottom:4px}
  .smeta{font-size:11px;color:#5a6a80;margin-bottom:10px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .online{background:#39ff6e}.offline{background:#5a6a80}.crashed{background:#ff3b5c}
  .btns{display:flex;gap:8px;flex-wrap:wrap}
  button{padding:8px 16px;border-radius:6px;border:none;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:1px}
  .bstart{background:rgba(57,255,110,0.15);color:#39ff6e;border:1px solid #39ff6e}
  .bstop{background:rgba(255,59,92,0.15);color:#ff3b5c;border:1px solid #ff3b5c}
  .brestart{background:rgba(255,215,0,0.15);color:#ffd700;border:1px solid #ffd700}
  .msg{background:rgba(0,229,255,0.08);border:1px solid rgba(0,229,255,0.2);border-radius:6px;padding:10px;font-size:11px;color:#00e5ff;margin-top:8px;display:none}
</style>
</head>
<body>
<h1>OMNEX</h1>
<div class="sub">Remote Access - Local Network</div>
${servers.map(s => `
<div class="card">
  <div class="sname"><span class="dot ${s.status}"></span>${s.name}</div>
  <div class="smeta">${s.game} · Port ${s.port} · ${s.players.length} player${s.players.length !== 1 ? 's' : ''}</div>
  <div class="btns">
    ${s.status !== 'online' ? `<button class="bstart" onclick="act('start','${s.id}',this)">▶ Start</button>` : ''}
    ${s.status === 'online' ? `<button class="bstop" onclick="act('stop','${s.id}',this)">⏹ Stop</button>` : ''}
    ${s.status === 'online' ? `<button class="brestart" onclick="act('restart','${s.id}',this)">🔄 Restart</button>` : ''}
  </div>
</div>`).join('')}
<script>
async function act(action,id,btn){
  btn.disabled=true; btn.textContent='...';
  await fetch('/api/action',{method:'POST',body:JSON.stringify({action,serverId:id}),headers:{'Content-Type':'application/json'}});
  setTimeout(()=>location.reload(),2000);
}
</script>
</body>
</html>`;
}


// ── Network Info ──────────────────────────────────────────────────────────────
ipcMain.handle('get-network-info', async (e, port) => {
  const os = require('os');

  // Get local IP
  let localIp = 'Unknown';
  try {
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          localIp = addr.address;
          break;
        }
      }
      if (localIp !== 'Unknown') break;
    }
  } catch(e) {}

  // Get public IP via external service
  let publicIp = 'Checking...';
  try {
    const data = await fetchJSON('https://api.ipify.org?format=json');
    publicIp = data.ip || 'Unavailable';
  } catch(e) {
    publicIp = 'Unavailable (no internet)';
  }

  return { localIp, publicIp, port };
});

// ── Set arbitrary field on server object (for server-level settings) ─────────
ipcMain.handle('set-server-field', (e, { id, key, value }) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server) return { ok: false, error: 'Server not found' };
  server[key] = value;
  saveData();
  return { ok: true };
});

ipcMain.handle('rename-server', (e, { id, newName }) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server) return { ok: false, error: 'Server not found' };
  if (!newName || typeof newName !== 'string' || !newName.trim()) return { ok: false, error: 'Invalid name' };
  const clean = newName.trim().slice(0, 60);
  server.name = clean;
  saveData();
  emit('server-status', { serverId: id, status: server.status || 'offline' });
  // Also update per-game config so the in-game ServerName reflects the new name
  try { syncServerConfig(id, server, /* isInstall */ false); } catch(e) {}
  return { ok: true, name: clean };
});

// ── App info IPC (LICENSE, THIRD_PARTY_NOTICES, updates, external URLs) ─────
ipcMain.handle('read-app-file', async (e, filename) => {
  // Only allow reading specific safe files from the app root (no path traversal)
  const allowed = new Set(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']);
  if (!allowed.has(filename)) return '';
  try {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch(err) { return ''; }
});

ipcMain.handle('open-external', async (e, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { ok: false };
    await require('electron').shell.openExternal(url);
    return { ok: true };
  } catch(err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('check-for-updates', async () => {
  const current = app.getVersion();
  const UPDATE_URL = 'https://api.github.com/repos/KOBRA1325/omnex/releases/latest';
  try {
    // Fetch latest release info from GitHub
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get(UPDATE_URL, { headers: { 'User-Agent': 'Omnex' }, timeout: 5000 }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
    const parsed = JSON.parse(data);
    const latest = (parsed.tag_name || '').replace(/^v/, '');
    if (!latest) return { ok: false, error: 'No release info available', current };
    // Simple semantic comparison
    const cmp = (a, b) => {
      const ap = a.split('.').map(n => parseInt(n, 10) || 0);
      const bp = b.split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        if ((ap[i]||0) > (bp[i]||0)) return 1;
        if ((ap[i]||0) < (bp[i]||0)) return -1;
      }
      return 0;
    };
    const updateAvailable = cmp(latest, current) > 0;
    return { ok: true, current, latest, updateAvailable, url: parsed.html_url };
  } catch(err) {
    return { ok: false, error: `Update check unavailable: ${err.message}`, current };
  }
});

// ── Windows Firewall helper (adds inbound TCP+UDP rules for a set of ports) ──
ipcMain.handle('add-firewall-rule', async (e, { id, ports }) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Firewall helper is Windows-only' };
  const server = appData.servers.find(s => s.id === id);
  if (!server) return { ok: false, error: 'Server not found' };
  if (!Array.isArray(ports) || ports.length === 0) return { ok: false, error: 'No ports specified' };

  const { exec } = require('child_process');
  const ruleName = `Omnex - ${server.name}`.replace(/"/g, '');

  // Build port list (unique)
  const uniquePorts = [...new Set(ports.map(p => parseInt(p, 10)).filter(p => p > 0 && p < 65536))];
  if (uniquePorts.length === 0) return { ok: false, error: 'No valid ports' };

  // Run netsh for each protocol. Escape rule name in quotes.
  const runNetsh = (protocol) => new Promise(resolve => {
    const portArg = uniquePorts.join(',');
    // First delete any existing rule with the same name so re-runs are idempotent
    const delCmd  = `netsh advfirewall firewall delete rule name="${ruleName} (${protocol})" >nul 2>&1`;
    const addCmd  = `netsh advfirewall firewall add rule name="${ruleName} (${protocol})" dir=in action=allow protocol=${protocol} localport=${portArg}`;
    exec(`${delCmd} & ${addCmd}`, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ protocol, err: err ? (stderr || err.message) : null });
    });
  });

  log(id, 'info', `🛡️ Adding Windows Firewall rules for ports: ${uniquePorts.join(', ')}...`);
  const [tcp, udp] = await Promise.all([runNetsh('TCP'), runNetsh('UDP')]);

  if (tcp.err && udp.err) {
    log(id, 'error', `Firewall rule failed: ${tcp.err}`);
    return { ok: false, error: 'Netsh failed. Omnex may need admin privileges. Right-click Omnex.exe → Run as administrator.' };
  }
  if (tcp.err) log(id, 'warn', `TCP rule warning: ${tcp.err}`);
  if (udp.err) log(id, 'warn', `UDP rule warning: ${udp.err}`);
  log(id, 'success', `✔ Firewall rules added for "${ruleName}" (TCP + UDP, ports ${uniquePorts.join(', ')})`);
  return { ok: true };
});


// ── System stats (shared by get-stats and get-server-bundle) ──────────────────
async function getStats() {
  try {
    const si = require('systeminformation');
    const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
    return { systemCpu: Math.round(cpu.currentLoad), systemRam: Math.round((mem.used / mem.total) * 100), procCpu: 0, procMem: 0 };
  } catch { return { systemCpu: 0, systemRam: 0, procCpu: 0, procMem: 0 }; }
}

// ── Batched server data IPC ───────────────────────────────────────────────────
ipcMain.handle('get-server-bundle', async (e, id) => {
  const server = appData.servers.find(s => s.id === id);
  if (!server) return { ok: false };

  const [stats, backups, backupSettings, autoRestart] = await Promise.all([
    getStats(),
    Promise.resolve(getBackupList(id)),
    Promise.resolve(server.backupSettings || { enabled: false, interval: 'daily', keepCount: 10 }),
    Promise.resolve(server.autoRestart   || { enabled: false, maxRetries: 3, cooldown: 10 }),
  ]);

  return {
    ok: true,
    schedules:      appData.schedules.filter(s => !s.serverId || s.serverId === id),
    backups,
    backupSettings,
    autoRestart,
    stats,
    notes:          server.notes || '',
    players:        server.players || [],
  };
});


// ── Server Import ─────────────────────────────────────────────────────────────
ipcMain.handle('import-server', async (e, config) => {
  const { name, game, port, importDir } = config;
  if (!fs.existsSync(importDir)) return { ok: false, error: 'Directory not found' };

  const id  = `srv_${Date.now()}`;
  const def = GAME_DEFS[game];

  // Copy the existing server INTO Omnex's own SERVERS_DIR and run from that copy.
  // The user's original folder is never referenced again, so nothing Omnex does
  // afterward (including Remove) can ever touch or delete their original files.
  const { dir: installDir } = uniqueInstallDir(sanitizeFolderName(name || `${game} Server`));

  const server = {
    id,
    name:            name || `${game} Server`,
    game,
    icon:            config.icon,
    fallback:        config.fallback,
    port:            port || '25565',
    installDir,
    execPath:        '',
    status:          'installing',
    imported:        true,
    copiedIntoOmnex: true,
    sourcePath:      importDir,
    mcType:          config.mcType,
    mcVersion:       config.mcVersion,
  };
  // Palworld: default to showing in community server list
  if (game === 'Palworld') server.showInPublicList = true;

  appData.servers.push(server);
  saveData();
  emit('server-added', server);

  try {
    log(id, 'info', `Importing ${server.name} — copying files into Omnex...`);
    log(id, 'dim', `Source: ${importDir}`);
    log(id, 'dim', 'Your original folder is left completely untouched; Omnex runs from its own copy.');
    fs.mkdirSync(installDir, { recursive: true });
    // Full recursive copy of the existing server (world, configs, binaries).
    await fs.promises.cp(importDir, installDir, { recursive: true });

    // Locate the executable inside the copy.
    let execPath = '';
    if (def?.startExe) execPath = findExe(installDir, def.startExe) || '';
    if (game === 'Minecraft') {
      const jar = path.join(installDir, 'server.jar');
      if (fs.existsSync(jar)) execPath = jar;
    }
    server.execPath = execPath;
    server.status   = 'offline';
    saveData();
    log(id, 'success', `✔ Imported ${server.name} (copied into Omnex). Your original folder was not modified.`);
    emit('install-complete', { serverId: id });
    return { ok: true, server };
  } catch (err) {
    server.status = 'error';
    saveData();
    log(id, 'error', `Import failed while copying: ${err.message}`);
    emit('install-error', { serverId: id, error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:      'Select Server Folder',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Default listen ports per game — used when we can't read the real one from a config file.
const GAME_DEFAULT_PORTS = {
  'Minecraft':'25565', 'CS2':'27015', 'Valheim':'2456', 'Rust':'28015', 'Satisfactory':'15777',
  'Project Zomboid':'16261', 'Ark: Survival':'7777', 'V Rising':'9876', 'Terraria':'7777',
  '7 Days to Die':'26900', 'Palworld':'8211', 'Enshrouded':'15636',
};

// Best-effort: read the actual configured port out of a known server config file.
// Returns a string port, or null if we couldn't find one.
function detectServerPort(dir, game) {
  const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch(e) { return null; } };
  try {
    if (game === 'Minecraft') {
      const m = (readIf(path.join(dir, 'server.properties')) || '').match(/^\s*server-port\s*=\s*(\d+)/m);
      if (m) return m[1];
    } else if (game === '7 Days to Die') {
      const m = (readIf(path.join(dir, 'serverconfig.xml')) || '').match(/name="ServerPort"\s+value="(\d+)"/i);
      if (m) return m[1];
    } else if (game === 'Terraria') {
      const m = (readIf(path.join(dir, 'serverconfig.txt')) || '').match(/^\s*port\s*=\s*(\d+)/m);
      if (m) return m[1];
    } else if (game === 'Enshrouded') {
      const m = (readIf(path.join(dir, 'enshrouded_server.json')) || '').match(/"gamePort"\s*:\s*(\d+)/);
      if (m) return m[1];
    } else if (game === 'V Rising') {
      for (const c of [path.join(dir, 'save-data', 'Settings', 'ServerHostSettings.json'), path.join(dir, 'Settings', 'ServerHostSettings.json')]) {
        const m = (readIf(c) || '').match(/"Port"\s*:\s*(\d+)/);
        if (m) return m[1];
      }
    }
  } catch(e) {}
  return null;
}

// Scan an existing server folder and figure out which game it is (+ its port),
// so the Import flow doesn't have to ask the user to pick a game.
ipcMain.handle('detect-server', async (e, dir) => {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Folder not found' };
  let game = null;
  // server.properties is a reliable Minecraft signal across vanilla/paper/fabric/forge.
  if (fs.existsSync(path.join(dir, 'server.properties'))) game = 'Minecraft';
  // Otherwise, match by the game's known server executable.
  if (!game) {
    for (const [name, def] of Object.entries(GAME_DEFS)) {
      if (name === 'Minecraft' || !def.startExe) continue;
      if (findExe(dir, def.startExe)) { game = name; break; }
    }
  }
  if (!game) return { ok: true, game: null };
  const port = detectServerPort(dir, game) || GAME_DEFAULT_PORTS[game] || '';
  return { ok: true, game, port, name: path.basename(dir) };
});


// ── Arma 3 / Workshop mod support ────────────────────────────────────────────
const STEAM_CREDS_FILE = path.join(USER_DATA, 'steam_creds.json');
const ARMA_MODS_DIR    = (installDir) => path.join(installDir, 'mods');

// Known Antistasi Ultimate mod IDs + their common dependencies
const ANTISTASI_ULTIMATE_MODS = [
  { id: '3020755032', name: 'Antistasi Ultimate',          required: true  },
  { id: '450814997',  name: 'CBA_A3',                      required: true  },
  { id: '463939057',  name: 'ACE3',                        required: true  },
  { id: '583496184',  name: 'RHS AFRF',                    required: false },
  { id: '541888371',  name: 'RHS USAF',                    required: false },
  { id: '843425103',  name: '3den Enhanced',               required: false },
  { id: '2018593667', name: 'CUP Terrains Core',           required: false },
  { id: '583544987',  name: 'CUP Terrains Maps',           required: false },
  { id: '497661914',  name: 'CUP Units',                   required: false },
  { id: '541888371',  name: 'RHS Escalation',              required: false },
];

// Save/load Steam credentials (stored locally, never transmitted)
function loadSteamCreds() {
  try {
    if (fs.existsSync(STEAM_CREDS_FILE)) return JSON.parse(fs.readFileSync(STEAM_CREDS_FILE, 'utf8'));
  } catch(e) {}
  return { username: '', saved: false };
}

function saveSteamCreds(username, password, steamGuardCode) {
  try {
    const data = { username, saved: !!username };
    if (password !== undefined) data.password = password;
    if (steamGuardCode !== undefined) data.steamGuardCode = steamGuardCode;
    fs.writeFileSync(STEAM_CREDS_FILE, JSON.stringify(data));
  } catch(e) {}
}

ipcMain.handle('get-steam-creds',     () => loadSteamCreds());
ipcMain.handle('save-steam-creds-all', (e, { username, password, steamGuardCode }) => {
  saveSteamCreds(username || '', password || '', steamGuardCode || '');
  return { ok: true };
});
ipcMain.handle('save-steam-username', (e, username) => { 
  const existing = loadSteamCreds();
  saveSteamCreds(username, existing.password || '', existing.steamGuardCode || '');
  return { ok: true };
});
ipcMain.handle('save-steam-password', (e, password) => {
  const existing = loadSteamCreds();
  saveSteamCreds(existing.username || '', password, existing.steamGuardCode || '');
  return { ok: true };
});
ipcMain.handle('save-steam-guard-code', (e, code) => {
  const existing = loadSteamCreds();
  saveSteamCreds(existing.username || '', existing.password || '', code);
  return { ok: true };
});
ipcMain.handle('get-antistasi-mods', () => ANTISTASI_ULTIMATE_MODS);

// ── Parse Arma 3 Launcher HTML preset file ────────────────────────────────────
ipcMain.handle('parse-arma3-preset', async (e, htmlContent) => {
  try {
    const mods = [];
    // Match Steam Workshop mod entries
    // Format: <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=XXXXXX" data-type="Link">
    //          <td data-type="DisplayName">Mod Name</td>
    const itemRegex = /<tr data-type="ModContainer">[\s\S]*?<td data-type="DisplayName">([^<]+)<\/td>[\s\S]*?filedetails\/\?id=(\d+)/g;
    let match;
    while ((match = itemRegex.exec(htmlContent)) !== null) {
      mods.push({
        name: match[1].trim(),
        id: match[2].trim()
      });
    }

    // Also try alternative format used by some launchers
    if (mods.length === 0) {
      const altRegex = /href="https?:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=(\d+)"[^>]*>([^<]+)</g;
      while ((match = altRegex.exec(htmlContent)) !== null) {
        mods.push({
          name: match[2].trim(),
          id: match[1].trim()
        });
      }
    }

    return { ok: true, mods };
  } catch(err) {
    return { ok: false, error: err.message };
  }
});

// ── Check for mod updates ─────────────────────────────────────────────────────
ipcMain.handle('check-arma3-mod-updates', async (e, { serverId }) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server || !server.arma3Mods || server.arma3Mods.length === 0) {
    return { ok: false, error: 'No mods to check' };
  }

  // For each mod, check if Steam has a newer timestamp
  // This requires the workshop API which doesn\'t need auth
  const updates = [];
  for (const mod of server.arma3Mods) {
    try {
      const localPath = path.join(STEAMCMD_DIR, 'steamapps', 'workshop', 'content', '107410', mod.id);
      const localMTime = fs.existsSync(localPath) ? fs.statSync(localPath).mtimeMs : 0;
      updates.push({ ...mod, localTime: localMTime, hasUpdate: false }); // basic for now
    } catch(err) {}
  }
  return { ok: true, updates };
});

// ── Get installed Arma 3 mods ─────────────────────────────────────────────────
ipcMain.handle('get-arma3-mods', async (e, { serverId }) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return { ok: false, error: 'Server not found' };
  return { ok: true, mods: server.arma3Mods || [] };
});

// ── Save server.cfg ───────────────────────────────────────────────────────────
ipcMain.handle('save-arma3-config', async (e, { serverId, config }) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return { ok: false, error: 'Server not found' };
  try {
    const cfgPath = path.join(server.installDir, 'server.cfg');
    fs.writeFileSync(cfgPath, config);
    return { ok: true };
  } catch(err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('load-arma3-config', async (e, { serverId }) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return { ok: false, error: 'Server not found' };
  try {
    const cfgPath = path.join(server.installDir, 'server.cfg');
    if (!fs.existsSync(cfgPath)) return { ok: true, config: '' };
    return { ok: true, config: fs.readFileSync(cfgPath, 'utf8') };
  } catch(err) {
    return { ok: false, error: err.message };
  }
});



// Download a Workshop mod using SteamCMD with user login
async function downloadWorkshopMod(serverId, installDir, modId, modName, username, password) {
  // If no password passed, try saved creds
  if (!password) { const creds = loadSteamCreds(); password = creds.password || ''; }
  return new Promise((resolve, reject) => {
    log(serverId, 'info', `Downloading Workshop mod: ${modName} (${modId})...`);

    const modsDir = ARMA_MODS_DIR(installDir);
    fs.mkdirSync(modsDir, { recursive: true });

    // SteamCMD workshop_download_item 107410 = Arma 3 app ID
    const args = [
      '+login', username, password,
      '+workshop_download_item', '107410', modId,
      '+quit'
    ];

    const proc = spawn(STEAMCMD_EXE, args, { cwd: STEAMCMD_DIR });
    let output = '';

    let lastPct = -1;
    proc.stdout.on('data', d => {
      const text = d.toString();
      output += text;
      text.split('\n').filter(l => l.trim()).forEach(line => {
        const t = line.toLowerCase();

        // QR code detection
        const qrMatch = line.match(/https?:\/\/s\.team\/[^\s]+/);
        if (qrMatch) {
          log(serverId, 'info', '📱 Scan QR code in Steam Mobile app to authorize');
          emit('steam-qr-code', { serverId, url: qrMatch[0] });
          return;
        }

        // Progress bar
        const pctMatch = line.match(/\[\s*(\d+)%\]/);
        if (pctMatch) {
          const pct = parseInt(pctMatch[1]);
          if (pct !== lastPct) {
            lastPct = pct;
            const filled = Math.floor(pct / 5);
            const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
            emit('console-progress', { serverId, text: `📦 ${modName}  [${bar}] ${pct}%` });
            if (pct === 0)   log(serverId, 'info',    `⬇  Downloading: ${modName}`);
            if (pct === 100) log(serverId, 'success', `✔  Downloaded:  ${modName}`);
          }
          return;
        }

        // Auth/Guard messages
        if (t.includes('waiting') || t.includes('guard') || t.includes('confirm') || t.includes('two-factor')) {
          log(serverId, 'warn', `🔐 ${line.trim()}`); return;
        }

        if (t.includes('fully installed') || t.includes('success')) {
          log(serverId, 'success', `✔ ${line.trim()}`); return;
        }
        if (t.includes('error') || t.includes('failed')) {
          log(serverId, 'error', line.trim()); return;
        }
        if (t.includes('verif') || t.includes('updat') || t.includes('downloading')) {
          log(serverId, 'info', line.trim()); return;
        }
        if (line.trim()) log(serverId, 'dim', line.trim());
      });
    });
    proc.stderr.on('data', d => log(serverId, 'warn', d.toString().trim()));
    proc.on('close', code => {
      if (code === 0 || output.includes('Success')) {
        // Find downloaded mod and link/copy to server mods folder
        const workshopPath = path.join(STEAMCMD_DIR, 'steamapps', 'workshop', 'content', '107410', modId);
        const modDestName  = `@${modName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        const modDest      = path.join(modsDir, modDestName);

        if (fs.existsSync(workshopPath)) {
          try {
            // Copy mod to server mods folder
            if (!fs.existsSync(modDest)) {
              fs.cpSync(workshopPath, modDest, { recursive: true });
            }
            log(serverId, 'success', `✔ ${modName} ready at ${modDest}`);
            resolve({ ok: true, path: modDest, folderName: modDestName });
          } catch(err) {
            resolve({ ok: true, path: workshopPath, folderName: modDestName });
          }
        } else {
          // Mod might be in a different location
          resolve({ ok: true, path: '', folderName: modDestName });
        }
      } else {
        reject(new Error(`SteamCMD exited ${code} for mod ${modName}`));
      }
    });
    proc.on('error', reject);
  });
}

// Install Arma 3 server + optionally download Workshop mods
ipcMain.handle('install-arma3-mods', async (e, { serverId, mods, username, password }) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return { ok: false, error: 'Server not found' };

  await ensureSteamCmd(serverId);

  const sessionFile = path.join(STEAMCMD_DIR, 'config', 'config.vdf');
  const hasCachedSession = fs.existsSync(sessionFile) && fs.statSync(sessionFile).size > 100;

  if (hasCachedSession) {
    log(serverId, 'info', '🔓 Using cached Steam session');
  }

  // Download a single mod with retry logic
  async function downloadOneMod(mod, attempt = 1) {
    return new Promise((resolve) => {
      const args = [];
      if (hasCachedSession) {
        args.push('+login', username);
      } else {
        args.push('+login', username, password);
      }
      args.push('+workshop_download_item', '107410', mod.id, 'validate');
      args.push('+quit');

      log(serverId, 'info', attempt === 1
        ? `⬇  Downloading: ${mod.name}`
        : `🔄 Retry ${attempt}/3: ${mod.name}`);

      const proc = spawn(STEAMCMD_EXE, args, { cwd: STEAMCMD_DIR, windowsHide: true });
      let output = '';
      let lastPct = -1;
      let succeeded = false;
      let errorReason = '';

      proc.stdout.on('data', d => {
        const text = d.toString();
        output += text;
        text.split('\n').filter(l => l.trim()).forEach(line => {
          const t = line.toLowerCase();

          // QR code
          const qrMatch = line.match(/https?:\/\/s\.team\/[^\s]+/);
          if (qrMatch) {
            log(serverId, 'info', '📱 Scan QR code in Steam Mobile app');
            emit('steam-qr-code', { serverId, url: qrMatch[0] });
            return;
          }

          // Progress
          const updateStateMatch = line.match(/progress:\s*([\d.]+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
          if (updateStateMatch) {
            const pct = Math.floor(parseFloat(updateStateMatch[1]));
            const downloaded = parseInt(updateStateMatch[2]);
            const total = parseInt(updateStateMatch[3]);
            if (pct !== lastPct) {
              lastPct = pct;
              const filled = Math.floor(pct / 5);
              const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
              const dlMb = (downloaded/1048576).toFixed(0);
              const totalMb = (total/1048576).toFixed(0);
              emit('console-progress', { serverId, text: `📦 ${mod.name}  [${bar}] ${pct}%  (${dlMb}/${totalMb} MB)` });
            }
            return;
          }
          if (line.match(/Update state \(0x[0-9a-f]+\)/i)) return;

          // Success
          if (line.match(/Success\. Downloaded item (\d+)/i)) {
            succeeded = true;
            log(serverId, 'success', `✔  Downloaded: ${mod.name}`);
            return;
          }

          // Capture failure reasons
          const errMatch = line.match(/ERROR! Download item (\d+) failed \(([^)]+)\)/i);
          if (errMatch) {
            errorReason = errMatch[2];
            return;
          }

          if (t.includes('logged in') || t.includes('steam public')) return;
          if (t.includes('error') && !t.includes('please run')) {
            log(serverId, 'error', line.trim());
            return;
          }
          // suppress noisy lines
        });
      });

      proc.stderr.on('data', d => { output += d.toString(); });

      proc.on('close', code => {
        if (succeeded) {
          resolve({ ok: true });
        } else {
          // Retry up to 3 times for transient failures
          if (attempt < 3) {
            log(serverId, 'warn', `⚠  ${mod.name} failed${errorReason ? ' ('+errorReason+')' : ''} — retrying in 5s...`);
            setTimeout(() => {
              downloadOneMod(mod, attempt + 1).then(resolve);
            }, 5000);
          } else {
            log(serverId, 'error', `✗  ${mod.name} failed after 3 attempts${errorReason ? ' ('+errorReason+')' : ''}`);
            resolve({ ok: false, error: errorReason || 'Download failed' });
          }
        }
      });

      proc.on('error', err => {
        if (attempt < 3) {
          setTimeout(() => downloadOneMod(mod, attempt + 1).then(resolve), 5000);
        } else {
          resolve({ ok: false, error: err.message });
        }
      });
    });
  }

  // Download all mods sequentially
  log(serverId, 'info', `Downloading ${mods.length} mod${mods.length!==1?'s':''} (one at a time, with auto-retry)...`);
  const results = [];
  const modFolders = [];
  const modsDir = path.join(server.installDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  for (const mod of mods) {
    const result = await downloadOneMod(mod);
    if (result.ok) {
      // Copy from workshop to mods folder
      const workshopPath = path.join(STEAMCMD_DIR, 'steamapps', 'workshop', 'content', '107410', mod.id);
      const modDestName = `@${mod.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      const modDest = path.join(modsDir, modDestName);
      if (fs.existsSync(workshopPath)) {
        try {
          if (!fs.existsSync(modDest)) fs.cpSync(workshopPath, modDest, { recursive: true });
          modFolders.push(modDestName);
          results.push({ ...mod, ok: true, path: modDest, folderName: modDestName });
        } catch(err) {
          results.push({ ...mod, ok: false, error: err.message });
          log(serverId, 'error', `✗ Failed to copy ${mod.name}: ${err.message}`);
        }
      } else {
        results.push({ ...mod, ok: false, error: 'Downloaded file not found at expected path' });
        log(serverId, 'error', `✗ ${mod.name}: workshop file missing after download`);
      }
    } else {
      results.push({ ...mod, ok: false, error: result.error });
    }
    // Small delay between mods to avoid rate limiting
    await new Promise(r => setTimeout(r, 1500));
  }

  if (modFolders.length > 0) {
    const modParam = modFolders.map(f => `mods\\\\${f}`).join(';');
    server.arma3Mods = results.filter(r => r.ok);
    server.args = `-config=server.cfg -port=${server.port} "-mod=${modParam}"`;
    saveData();
    log(serverId, 'success', `✔ Launch args updated with ${modFolders.length} mod${modFolders.length!==1?'s':''}`);
  }

  const failedCount = results.filter(r => !r.ok).length;
  if (failedCount > 0) {
    log(serverId, 'warn', `⚠ ${failedCount} mod${failedCount!==1?'s':''} failed to download. You can try again later.`);
  }

  emit('install-complete', { serverId });
  return { ok: true, results, modFolders };
});





// ── Window drag via IPC (no -webkit-app-region needed) ────────────────────────
let dragOffset = null;
ipcMain.on('window-drag-start', (e, { offsetX, offsetY }) => {
  dragOffset = { x: offsetX, y: offsetY };
});
ipcMain.on('window-drag-move', (e, { screenX, screenY }) => {
  if (!dragOffset || !mainWindow) return;
  mainWindow.setPosition(screenX - dragOffset.x, screenY - dragOffset.y);
});
ipcMain.on('window-drag-end', () => { dragOffset = null; });

// ── Window resize via IPC (manual resize handles for frameless window) ────────
ipcMain.on('window-resize', (e, { x, y, width, height }) => {
  if (!mainWindow || mainWindow.isMaximized()) return;
  try {
    // Enforce reasonable minimums so the window can't be resized to nothing
    const minW = 900, minH = 600;
    const w = Math.max(minW, Math.round(width));
    const h = Math.max(minH, Math.round(height));
    mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  } catch(err) {}
});

// ── Direct Steam Login (using steam-session, like FASTER) ─────────────────────
ipcMain.handle('steam-direct-login', async (e, { username, password, guardCode }) => {
  if (!steamAuth) return { ok: false, error: 'Steam auth library not installed. Run npm install in the Omnex folder.' };

  const emit = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('console-line', { serverId: null, type: 'info', text: msg });
    }
  };

  try {
    const result = await steamAuth.steamLogin({ username, password, guardCode, emit });
    return result;
  } catch(err) {
    return { ok: false, error: err.message };
  }
});


ipcMain.handle('steam-submit-guard-code', async (e, { username, code, codeType }) => {
  if (!steamAuth) return { ok: false, error: 'Steam auth library not available' };
  try {
    return await steamAuth.submitGuardCode(username, code, codeType || 'EmailCode');
  } catch(err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('steam-cancel-login', async (e, username) => {
  if (!steamAuth) return { ok: false };
  steamAuth.clearPendingSession(username);
  return { ok: true };
});

ipcMain.handle('steam-check-token', async (e, username) => {
  if (!steamAuth) return { hasToken: false };
  return { hasToken: steamAuth.hasValidToken(username) };
});

ipcMain.handle('steam-clear-tokens', async (e, username) => {
  if (!steamAuth) return { ok: false };
  steamAuth.clearTokens(username);
  return { ok: true };
});


// ── Authenticate SteamCMD with one email code (creates SteamCMD's own cache) ──
ipcMain.handle('steamcmd-auth', async (e, { username, password, steamGuardCode }) => {
  try {
    await ensureSteamCmd('settings');
  } catch(err) {
    return { ok: false, error: 'Could not initialize SteamCMD: ' + err.message };
  }

  return new Promise((resolve) => {
    emit('console-line', { serverId: 'settings', type: 'info', text: '🔐 Authenticating SteamCMD with your credentials...' });

    // Write a one-time auth script
    const scriptPath = path.join(STEAMCMD_DIR, 'auth.txt');
    const scriptLines = [
      '@ShutdownOnFailedCommand 1',
      '@NoPromptForPassword 1',
    ];
    if (steamGuardCode) scriptLines.push(`set_steam_guard_code ${steamGuardCode}`);
    scriptLines.push(`login ${username} ${password}`);
    scriptLines.push('quit');
    fs.writeFileSync(scriptPath, scriptLines.join('\n'));

    const proc = spawn(STEAMCMD_EXE, ['+runscript', scriptPath], { cwd: STEAMCMD_DIR, windowsHide: true });
    let output = '';

    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });

    proc.on('close', code => {
      try { fs.unlinkSync(scriptPath); } catch(e) {}
      const lower = output.toLowerCase();

      // Check for ERRORS FIRST - SteamCMD includes "Steam Public" in error messages too!
      if (lower.includes('two-factor code mismatch') || lower.includes('two-factor') ||
          lower.includes('account logon denied') || lower.includes('check your email')) {
        emit('console-line', { serverId: 'settings', type: 'warn', text: '📧 SteamCMD email code needed - check inbox' });
        resolve({ ok: false, needsCode: true, error: 'Steam Guard code required from email' });
        return;
      }
      if (lower.includes('invalid password')) {
        resolve({ ok: false, error: 'Invalid password' });
        return;
      }
      if (lower.includes('rate limit')) {
        resolve({ ok: false, error: 'Steam rate limit - wait a few minutes and try again' });
        return;
      }
      if (lower.includes('error') && lower.includes('logging in')) {
        resolve({ ok: false, error: 'Login failed - check console for details', output: output.slice(-500) });
        return;
      }
      if (lower.includes('failed')) {
        resolve({ ok: false, error: 'Authentication failed', output: output.slice(-500) });
        return;
      }

      // Only THEN check for success - using strict markers
      // "Logged in OK" or "Waiting for user info...OK" indicate actual successful login
      if (lower.includes('logged in ok') || lower.includes('waiting for user info...ok')) {
        emit('console-line', { serverId: 'settings', type: 'success', text: '✔ SteamCMD authenticated. Future installs will not need codes.' });
        resolve({ ok: true });
        return;
      }

      // Unknown state - assume failed
      resolve({ ok: false, error: 'Authentication state unclear', output: output.slice(-500) });
    });

    proc.on('error', err => resolve({ ok: false, error: err.message }));
  });
});

// ── Test Steam login (validates credentials with SteamCMD) ────────────────────
ipcMain.handle('test-steam-login', async (e, { username, password, steamGuardCode }) => {
  try {
    await ensureSteamCmd('settings');
  } catch(err) {
    return { ok: false, error: 'Could not initialize SteamCMD: ' + err.message };
  }

  return new Promise((resolve) => {
    emit('console-line', { serverId: null, type: 'info', text: 'Testing Steam login & creating session cache...' });

    const args = [];
    if (steamGuardCode) args.push('+set_steam_guard_code', steamGuardCode);
    // Login + a benign command that ensures session is fully cached
    args.push('+login', username, password);
    args.push('+app_info_print', '107410');  // Forces full session establishment
    args.push('+quit');

    const proc = spawn(STEAMCMD_EXE, args, { cwd: STEAMCMD_DIR, windowsHide: true });
    let output = '';
    let timedOut = false;

    // 60 second timeout for the test
    const timeout = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch(e) {}
      resolve({ ok: false, error: 'Login timed out — Steam Guard may not have been approved in time' });
    }, 60000);

    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });

    proc.on('close', code => {
      clearTimeout(timeout);
      if (timedOut) return;

      const lower = output.toLowerCase();
      if (lower.includes('logged in') || lower.includes('steam public') || lower.includes('waiting for user info...ok')) {
        resolve({ ok: true });
      } else if (lower.includes('rate limit')) {
        resolve({ ok: false, error: 'Steam rate limit - wait a few minutes and try again' });
      } else if (lower.includes('invalid password') || lower.includes('account login denied') || lower.includes('failed to login')) {
        resolve({ ok: false, error: 'Invalid username or password' });
      } else if (lower.includes('two-factor') || lower.includes('steam guard') || lower.includes('account login denied need two-factor code')) {
        resolve({ ok: false, error: 'Steam Guard code required or incorrect', needsGuardCode: true });
      } else if (lower.includes('timed out') || lower.includes('mobile authenticator')) {
        resolve({ ok: false, error: 'Steam Guard mobile approval timed out' });
      } else {
        resolve({ ok: false, error: 'Login failed - check console for details' });
      }
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message });
    });
  });
});

// ── Pre-authenticate Steam (opens visible terminal for Steam Guard) ────────────
ipcMain.handle('steam-preauth', async (e, { username, password }) => {
  try {
    await ensureSteamCmd('preauth');
  } catch(err) {}

  return new Promise((resolve) => {
    const { exec } = require('child_process');
    // Build a login script for SteamCMD
    const loginArgs = password
      ? `+login ${username} ${password} +quit`
      : `+login ${username} +quit`;

    // Open a visible cmd window so user can interact with Steam Guard prompts
    const cmd = `start "SteamCMD - Approve Steam Guard in Mobile App" cmd /k "${STEAMCMD_EXE}" ${loginArgs}`;
    exec(cmd, { cwd: STEAMCMD_DIR }, (err) => {
      if (err) resolve({ ok: false, error: err.message });
      else resolve({ ok: true });
    });
  });
});

// ── Storage Manager ───────────────────────────────────────────────────────────
ipcMain.handle('get-storage-info', async () => {
  const result = {
    appData:     getDirSize(USER_DATA),
    servers:     [],
    orphans:     [],
    tempFiles:   [],
    totalBytes:  0,
  };

  // Per-server breakdown
  for (const srv of appData.servers) {
    if (!srv.installDir || !fs.existsSync(srv.installDir)) continue;
    const gameSize = getDirSize(srv.installDir);
    const javaDir  = path.join(srv.installDir, '_java');
    const javaSize = fs.existsSync(javaDir) ? getDirSize(javaDir) : 0;
    result.servers.push({
      id:       srv.id,
      name:     srv.name,
      game:     srv.game,
      gameSize,
      javaSize,
      totalSize: gameSize,
      installDir: srv.installDir,
    });
  }

  // Orphaned folders — dirs in SERVERS_DIR not linked to any server
  if (fs.existsSync(SERVERS_DIR)) {
    const knownDirs = new Set(appData.servers.map(s => s.installDir).filter(Boolean));
    for (const entry of fs.readdirSync(SERVERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(SERVERS_DIR, entry.name);
      if (!knownDirs.has(full)) {
        result.orphans.push({ path: full, size: getDirSize(full) });
      }
    }
  }

  // Leftover temp/zip files
  const scanForTemp = (dir, depth = 0) => {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && (entry.name.endsWith('.zip') || entry.name.endsWith('.tmp') || entry.name === 'forge-installer.jar')) {
          result.tempFiles.push({ path: full, size: fs.statSync(full).size });
        } else if (entry.isDirectory()) {
          scanForTemp(full, depth + 1);
        }
      }
    } catch(e) {}
  };
  scanForTemp(USER_DATA);

  // SteamCMD size
  result.steamCmd = fs.existsSync(STEAMCMD_DIR) ? getDirSize(STEAMCMD_DIR) : 0;

  result.totalBytes = result.servers.reduce((a, s) => a + s.totalSize, 0)
    + result.orphans.reduce((a, o) => a + o.size, 0)
    + result.tempFiles.reduce((a, t) => a + t.size, 0)
    + result.steamCmd;

  return result;
});

ipcMain.handle('clean-temp-files', () => {
  let freed = 0;
  // Remove leftover zips and temp files inside app data
  const scanForTemp = (dir, depth = 0) => {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && (entry.name.endsWith('.zip') || entry.name.endsWith('.tmp') || entry.name === 'forge-installer.jar')) {
          try { freed += fs.statSync(full).size; fs.unlinkSync(full); } catch(e) {}
        } else if (entry.isDirectory()) {
          scanForTemp(full, depth + 1);
        }
      }
    } catch(e) {}
  };
  scanForTemp(USER_DATA);
  return { ok: true, freed };
});

ipcMain.handle('clean-orphans', () => {
  let freed = 0;
  if (!fs.existsSync(SERVERS_DIR)) return { ok: true, freed };
  const knownDirs = new Set(appData.servers.map(s => s.installDir).filter(Boolean));
  for (const entry of fs.readdirSync(SERVERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(SERVERS_DIR, entry.name);
    if (!knownDirs.has(full)) {
      try { freed += getDirSize(full); fs.rmSync(full, { recursive: true, force: true }); } catch(e) {}
    }
  }
  return { ok: true, freed };
});

ipcMain.handle('clean-java', (e, serverId) => {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return { ok: false };
  const javaDir = path.join(server.installDir, '_java');
  let freed = 0;
  if (fs.existsSync(javaDir)) {
    freed = getDirSize(javaDir);
    try { fs.rmSync(javaDir, { recursive: true, force: true }); } catch(e) {}
  }
  // Clear cached java path
  server.javaExe = null;
  saveData();
  return { ok: true, freed };
});

ipcMain.handle('clean-steamcmd', () => {
  let freed = 0;
  if (fs.existsSync(STEAMCMD_DIR)) {
    freed = getDirSize(STEAMCMD_DIR);
    try { fs.rmSync(STEAMCMD_DIR, { recursive: true, force: true }); } catch(e) {}
    fs.mkdirSync(STEAMCMD_DIR, { recursive: true });
  }
  return { ok: true, freed };
});

ipcMain.handle('open-data-folder', () => {
  require('electron').shell.openPath(USER_DATA);
});

function getDirSize(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch(e) {}
      } else if (entry.isDirectory()) {
        total += getDirSize(full);
      }
    }
  } catch(e) {}
  return total;
}

// ── Java check IPC ───────────────────────────────────────────────────────────
ipcMain.handle('check-java', async (e, { serverId, mcVersion } = {}) => {
  const server = serverId ? appData.servers.find(s => s.id === serverId) : null;
  // Check server-local Java
  if (server?.javaExe && fs.existsSync(server.javaExe)) {
    return { found: true, exe: server.javaExe, version: getRequiredJavaVersion(mcVersion), local: true };
  }
  // Check system Java
  const required = getRequiredJavaVersion(mcVersion);
  const sys = await getSystemJava(required);
  return { found: !!sys, exe: sys, version: required, local: false };
});

// ── START / STOP ──────────────────────────────────────────────────────────────
// ── Live log tailing: for games that write to log files instead of stdout ─────
const logTailers = {}; // serverId -> { path, watcher, position, interval }

function getGameLogPath(server) {
  if (!server || !server.installDir) return null;
  switch (server.game) {
    case 'Palworld':
      // Palworld log location — most recent per-run log
      return findLatestLog(path.join(server.installDir, 'Pal', 'Saved', 'Logs'), '.log');
    case 'Ark: Survival':
      return findLatestLog(path.join(server.installDir, 'ShooterGame', 'Saved', 'Logs'), '.log');
    case 'V Rising':
      return findLatestLog(path.join(server.installDir, 'logs'), '.log');
    case 'Satisfactory':
      return findLatestLog(path.join(server.installDir, 'FactoryGame', 'Saved', 'Logs'), '.log');
    case '7 Days to Die':
      return findLatestLog(server.installDir, 'output_log__*.txt');
    case 'Enshrouded':
      return findLatestLog(path.join(server.installDir, 'logs'), '.log');
    default:
      return null;
  }
}

function findLatestLog(dir, extOrPattern) {
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    const matches = entries.filter(f => extOrPattern.includes('*')
      ? new RegExp('^' + extOrPattern.replace(/\./g,'\\.').replace(/\*/g,'.*') + '$').test(f)
      : f.endsWith(extOrPattern));
    if (matches.length === 0) return null;
    // Return the most recently modified file
    const withStats = matches.map(f => {
      const full = path.join(dir, f);
      try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch(e) { return null; }
    }).filter(Boolean);
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0]?.full || null;
  } catch(e) { return null; }
}

function startLogTailer(serverId, server) {
  // Wait briefly for the game to create its log file, then start tailing
  setTimeout(() => {
    const logPath = getGameLogPath(server);
    if (!logPath || !fs.existsSync(logPath)) {
      log(serverId, 'dim', `(no log file to tail for ${server.game})`);
      return;
    }
    log(serverId, 'dim', `📄 Tailing log: ${path.basename(logPath)}`);

    let position = 0;
    // Skip existing content so we only see new lines (game just started)
    try { position = fs.statSync(logPath).size; } catch(e) {}

    const readNew = () => {
      try {
        const stat = fs.statSync(logPath);
        if (stat.size < position) position = 0; // log rotated
        if (stat.size === position) return;
        const stream = fs.createReadStream(logPath, { start: position, end: stat.size, encoding: 'utf8' });
        let buffer = '';
        stream.on('data', chunk => { buffer += chunk; });
        stream.on('end', () => {
          const lines = buffer.split(/\r?\n/).filter(l => l.trim());
          for (const line of lines) {
            // Filter out overly noisy Unreal frame-timing lines
            if (/LogRHI:|LogSlate:|LogEditor:|LogInit:.*OS: Windows/.test(line)) continue;
            // Hide the automatic RCON ShowPlayers poll (runs every 20s for player counts)
            if (/RCON executed the command\.?\s*ShowPlayers/i.test(line)) continue;
            log(serverId, classifyLine(line), line);
          }
          position = stat.size;
        });
      } catch(e) {}
    };

    const interval = setInterval(readNew, 1000);
    logTailers[serverId] = { path: logPath, position, interval };
  }, 2000);
}

function stopLogTailer(serverId) {
  const t = logTailers[serverId];
  if (!t) return;
  clearInterval(t.interval);
  delete logTailers[serverId];
}

async function startServerById(id) {
  const server = appData.servers.find(s=>s.id===id);
  if (!server)             return { ok:false, error:'Server not found' };
  if (serverProcesses[id]) return { ok:false, error:'Already running' };

  // Port conflict detection — check if another running server uses this port
  const conflict = appData.servers.find(s =>
    s.id !== id &&
    s.port === server.port &&
    serverProcesses[s.id]
  );
  if (conflict) {
    return { ok:false, error:`Port ${server.port} is already in use by "${conflict.name}". Change the port in Server Config before starting.` };
  }

  // Sync user's name and port to per-game config files (in case they changed after install)
  syncServerConfig(id, server, /* isInstall */ false);

  // Palworld: make sure RCON is enabled with a known admin password so we can
  // gracefully shut it down and read live player counts.
  if (server.game === 'Palworld') configurePalworldRcon(server);

  const def = GAME_DEFS[server.game];
  let exe, args;

  // Steam servers need the VC++ runtime to launch; ensure it's present before
  // starting (covers imported/copied servers that never ran through the installer).
  if (def?.type === 'steam' || def?.type === 'steam_auth') {
    try { await ensureVCRedist(id); } catch(e) {}
  }

  if (def?.type === 'minecraft' || def?.useJava) {
    try {
      exe = await ensureJava(id, server.mcVersion);
    } catch(err) {
      return { ok:false, error:`Java setup failed: ${err.message}` };
    }
    args = ['-Xmx2G','-Xms512M','-jar', server.execPath || path.join(server.installDir,'server.jar'), 'nogui'];
  } else if (server.useShell) {
    exe  = server.execPath;
    args = [];
  } else {
    exe  = server.execPath;
    args = server.args ? server.args.split(' ').filter(Boolean) : (def?.startArgs ? def.startArgs(server.installDir, server) : []);
  }

  // Palworld migration: PalServer.exe is a launcher that spawns a child console.
  // Re-target to the actual binary so windowsHide works and Stop can kill it directly.
  if (server.game === 'Palworld' && exe && exe.toLowerCase().endsWith('palserver.exe')) {
    const realExe = findExe(server.installDir, 'PalServer-Win64-Shipping-Cmd.exe');
    if (realExe) {
      log(id, 'dim', `Using ${path.basename(realExe)} directly (bypasses launcher)`);
      exe = realExe;
      server.execPath = realExe;
      saveData();
    }
  }

  if (!exe) return { ok:false, error:'No executable found. Try reinstalling.' };

  log(id, 'info', `▶ Starting ${server.name}...`);
  log(id, 'dim', `Executable: ${path.basename(exe)}`);
  log(id, 'dim', `Working dir: ${server.installDir}`);
  if (args && args.length) {
    // Redact potential passwords from displayed args
    const safeArgs = args.map(a => /pass(word)?[=]/i.test(a) ? a.replace(/=[^\s]+/, '=***') : a);
    log(id, 'dim', `Args: ${safeArgs.join(' ')}`);
  }

  try {
    const proc = spawn(exe, args, { cwd:server.installDir, shell: !!server.useShell, windowsHide: true });
    serverProcesses[id] = proc;
    // Persist the PID so a later Omnex session (after a restart/update/crash) can
    // find and clean up this process instead of leaving it orphaned and joinable.
    server.pid = proc.pid;
    saveData();
    log(id, 'success', `✔ Process spawned (PID: ${proc.pid})`);
    notify('start', {
      title: `▶ ${server.name} started`,
      body: `${server.name} is now running.`,
      fields: [
        { name: 'Server', value: server.name, inline: true },
        { name: 'Game', value: server.game || 'Unknown', inline: true },
        { name: 'Port', value: String(server.port || '—'), inline: true },
      ],
    });

    // Some games (Palworld, Ark, other Unreal titles) don't emit useful stdout — they log to files.
    // Tail those log files so their output shows up in the Live Console.
    startLogTailer(id, server);
    proc.stdout.on('data', d => {
      d.toString().split('\n').filter(l=>l.trim()).forEach(l => {
        // Suppress /list command output from flooding the console
        if (/There are \d+ of a max(imum)? of \d+ players online/i.test(l)) {
          parsePlayerEvent(id, l); // still parse for player names
          return; // but don't show in console
        }
        log(id, classifyLine(l), l);
        parsePlayerEvent(id, l);
      });
    });
    proc.stderr.on('data', d => {
      d.toString().split('\n').filter(l=>l.trim()).forEach(l => {
        if (/There are \d+ of a max(imum)? of \d+ players online/i.test(l)) {
          parsePlayerEvent(id, l);
          return;
        }
        log(id, 'warn', l);
        parsePlayerEvent(id, l);
      });
    });
    let startTime = Date.now();
    if (mainWindow) updateTaskbarBadge();
    proc.on('close', code => {
      delete serverProcesses[id];
      const uptime = Math.round((Date.now() - startTime) / 1000);
      const intentional = proc._omnexIntentionalStop;
      if (code !== 0 && code !== null && !intentional) {
        // Crash detection — distinguish crash from intentional stop
        const isCrash = uptime < 30; // ran for less than 30 seconds = likely crash
        log(id, 'error', `⚠ Server stopped unexpectedly (exit code ${code})`);
        if (isCrash) {
          log(id, 'error', `Server crashed after only ${uptime}s. Check the logs above for errors.`);
          log(id, 'warn',  'Common causes: wrong Java version, corrupted world, missing mods, port in use.');
        } else {
          log(id, 'warn', `Server ran for ${formatBytesNative(uptime).replace(' B','')}s then exited with code ${code}.`);
        }
        emit('server-crashed', { serverId:id, code, uptime, isCrash });
        notify('crash', {
          title: `⚠ ${server.name} crashed`,
          body: `${server.name} stopped unexpectedly after ${uptime}s (exit code ${code}).`,
          urgency: 'critical',
          fields: [
            { name: 'Server', value: server.name, inline: true },
            { name: 'Game', value: server.game || 'Unknown', inline: true },
            { name: 'Exit code', value: String(code), inline: true },
          ],
        });
      } else {
        // Clean or intentional shutdown
        notify('stop', {
          title: `⏹ ${server.name} stopped`,
          body: `${server.name} has shut down.`,
          fields: [
            { name: 'Server', value: server.name, inline: true },
            { name: 'Game', value: server.game || 'Unknown', inline: true },
          ],
        });
      }
      // Clear player list + persisted PID on stop
      const stoppedSrv = appData.servers.find(s => s.id === id);
      if (stoppedSrv) { stoppedSrv.players = []; stoppedSrv.pid = null; saveData(); }
      emit('players-updated', { serverId: id, players: [] });
      emit('server-stopped', { serverId:id, code });
      stopLogTailer(id);
      updateTaskbarBadge();
    });
    proc.on('error', err => {
      delete serverProcesses[id];
      log(id, 'error', `Failed to start process: ${err.message}`);
      if (err.code === 'ENOENT') log(id, 'warn', 'Executable not found - try reinstalling the server.');
      emit('server-stopped', { serverId:id, code:1 });
      stopLogTailer(id);
    });
    // Watch server.properties for changes and notify renderer
    const propsPath = path.join(server.installDir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      let watchDebounce;
      const watcher = fs.watch(propsPath, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          emit('server-config-changed', { serverId: id });
        }, 500);
      });
      proc.on('close', () => { try { watcher.close(); } catch(e) {} });
    }

    return { ok:true };
  } catch(err) { return { ok:false, error:err.message }; }
}

ipcMain.handle('start-server', async (e, id) => startServerById(id));

ipcMain.handle('stop-server',   async (e,id) => killServer(id));
ipcMain.handle('send-command',  (e,{id,command}) => {
  const proc = serverProcesses[id];
  if (!proc) return { ok:false, error:'Not running' };
  try { proc.stdin.write(command+'\n'); return { ok:true }; } catch(e) { return { ok:false, error:e.message }; }
});

// ── RCON (Source protocol) — graceful Palworld shutdown + live player counts ──
// Connects, authenticates, runs one command, returns the response text.
// Resolves null on any failure — RCON is best-effort and never blocks a stop.
function rconCommand(host, port, password, command, timeoutMs = 3000) {
  return new Promise(resolve => {
    if (!password) return resolve(null);
    let settled = false, authed = false, buf = Buffer.alloc(0);
    const socket = new net.Socket();
    const done = (val) => { if (settled) return; settled = true; try { socket.destroy(); } catch(e){} resolve(val); };
    const encode = (id, type, body) => {
      const b = Buffer.from(String(body), 'ascii');
      const size = 10 + b.length;                       // id(4) + type(4) + body + 2 nulls
      const pkt = Buffer.alloc(4 + size);
      pkt.writeInt32LE(size, 0); pkt.writeInt32LE(id, 4); pkt.writeInt32LE(type, 8); b.copy(pkt, 12);
      return pkt;
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.on('error', () => done(null));
    socket.on('connect', () => socket.write(encode(1, 3, password))); // SERVERDATA_AUTH
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (size < 10 || buf.length < 4 + size) break;
        const id = buf.readInt32LE(4), type = buf.readInt32LE(8);
        const body = buf.toString('ascii', 12, 4 + size - 2);
        buf = buf.subarray(4 + size);
        if (!authed) {
          if (id === -1) return done(null);                          // auth failed
          if (type === 2) { authed = true; socket.write(encode(2, 2, command)); } // authed → exec
        } else {
          return done(body);                                          // command response
        }
      }
    });
    socket.connect(port || 25575, host || '127.0.0.1');
  });
}

// Ensure a Palworld server has RCON enabled with an admin password Omnex knows,
// so it can gracefully shut down (deregisters from the community list) and read
// player counts. Only generates an admin password if the user hasn't set one.
function configurePalworldRcon(server) {
  try {
    const iniPath = path.join(server.installDir, 'Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini');
    if (!fs.existsSync(iniPath)) return;
    let raw = fs.readFileSync(iniPath, 'utf8');
    const m = raw.match(/OptionSettings=\(([\s\S]*?)\)/);
    if (!m) return;
    const map = new Map(); const parts = []; let cur = '', q = false;
    for (const ch of m[1]) { if (ch === '"') { q = !q; cur += ch; } else if (ch === ',' && !q) { parts.push(cur); cur = ''; } else cur += ch; }
    if (cur.trim()) parts.push(cur);
    for (const p of parts) { const e = p.indexOf('='); if (e > -1) map.set(p.slice(0, e).trim(), p.slice(e + 1).trim()); }
    let changed = false;
    if (map.get('RCONEnabled') !== 'True') { map.set('RCONEnabled', 'True'); changed = true; }
    const rconPort = parseInt(String(map.get('RCONPort') || '').replace(/[^0-9]/g, ''), 10) || 25575;
    if (!map.has('RCONPort')) { map.set('RCONPort', String(rconPort)); changed = true; }
    let admin = String(map.get('AdminPassword') || '').replace(/^"|"$/g, '');
    if (!admin) {
      admin = 'omnex' + Math.random().toString(36).slice(2, 10);
      map.set('AdminPassword', `"${admin}"`); changed = true;
      log(server.id, 'dim', 'Enabled RCON with an auto-generated admin password (for graceful shutdown + player counts). You can view/change it in Config → Admin Password.');
    }
    if (changed) {
      const tuple = Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join(',');
      raw = raw.replace(/OptionSettings=\([\s\S]*?\)/, `OptionSettings=(${tuple})`);
      fs.writeFileSync(iniPath, raw);
    }
    server.rconPort = rconPort;
    server.rconPassword = admin;
  } catch(e) {}
}

// Graceful stop: for Palworld with RCON, ask the server to shut down cleanly
// first (so it deregisters from the community list quickly), then hard-kill.
async function killServer(id) {
  const srv  = appData.servers.find(s => s.id === id);
  const proc = serverProcesses[id];
  if (proc && srv && srv.game === 'Palworld' && srv.rconPassword) {
    proc._omnexIntentionalStop = true;
    try {
      const res = await rconCommand('127.0.0.1', srv.rconPort || 25575, srv.rconPassword, 'Shutdown 1 Server_shutting_down');
      if (res !== null) {
        log(id, 'dim', 'Sent graceful shutdown via RCON — the community listing will clear quickly.');
        for (let i = 0; i < 8 && serverProcesses[id]; i++) await new Promise(r => setTimeout(r, 500)); // up to ~4s to exit
      }
    } catch(e) {}
    if (!serverProcesses[id]) { srv.pid = null; saveData(); return { ok:true }; }
  }
  return hardKill(id);
}

// Force-kill: taskkill the tracked PID (+ children) with an image-name backstop.
function hardKill(id) {
  return new Promise(resolve => {
    const proc = serverProcesses[id];
    const srv  = appData.servers.find(s => s.id === id);
    const images = (srv && FORCE_KILL_IMAGES[srv.game]) || [];

    let done = false;
    const finish = () => {
      if (done) return; done = true;
      if (srv) { srv.pid = null; saveData(); }
      delete serverProcesses[id];
      resolve({ ok:true });
    };

    // Backstop: kill the game's known server exe(s) by image name to catch any
    // process that detached from the one we spawned. Only runs for single-instance
    // games (FORCE_KILL_IMAGES), so it can't hit another unrelated server.
    const forceKillImages = () => new Promise(res => {
      if (!images.length || process.platform !== 'win32') return res();
      const imgArgs = [];
      images.forEach(img => { imgArgs.push('/IM', img); });
      const k = spawn('taskkill', ['/F', '/T', ...imgArgs], { windowsHide: true });
      k.on('close', () => res());
      k.on('error', () => res());
    });

    if (!proc) {
      // Nothing tracked — still run the image backstop in case an orphan is alive.
      forceKillImages().then(finish);
      return;
    }

    // Mark this kill as intentional so proc.on('close') doesn't log it as a crash
    proc._omnexIntentionalStop = true;

    if (process.platform === 'win32' && proc.pid) {
      // taskkill kills the process AND its children (/T = tree, /F = force).
      const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      const fallback = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch(e) {}
        forceKillImages().then(finish);
      }, 8000);
      const after = () => { clearTimeout(fallback); forceKillImages().then(finish); };
      killer.on('close', after);
      killer.on('error', after);
    } else {
      // POSIX / dev: SIGTERM then SIGKILL after 5s
      try { proc.kill('SIGTERM'); } catch(e){}
      setTimeout(() => {
        try { if(serverProcesses[id]) proc.kill('SIGKILL'); } catch(e){}
        finish();
      }, 5000);
    }
  });
}

// On launch, clean up game-server processes left running by a previous Omnex
// session (a crash, force-close, or auto-update restart loses the in-memory
// handle, leaving the server alive, joinable, and holding its ports). We match
// the persisted PID AND its image name so a reused PID can never hit an
// unrelated process.
async function cleanupOrphanedServers() {
  if (process.platform !== 'win32') return;
  const withPid = appData.servers.filter(s => s.pid);
  if (!withPid.length) return;
  for (const s of withPid) {
    const pid = s.pid;
    const exe = s.execPath ? path.basename(s.execPath) : '';
    s.pid = null; // clear the record regardless of outcome
    if (!pid || !exe) continue;
    const alive = await new Promise(res => {
      let out = '';
      const t = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FI', `IMAGENAME eq ${exe}`, '/NH', '/FO', 'CSV'], { windowsHide: true });
      t.stdout.on('data', d => out += d.toString());
      t.on('close', () => res(out.toLowerCase().includes(exe.toLowerCase())));
      t.on('error', () => res(false));
    });
    if (alive) {
      console.log(`[Omnex] Cleaning orphaned server "${s.name}" (pid ${pid}, ${exe}) left running from a previous session`);
      await new Promise(res => {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        k.on('close', () => res());
        k.on('error', () => res());
      });
    }
  }
  saveData();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
ipcMain.handle('get-stats', async (e, id) => getStats());

// ── Scheduler ─────────────────────────────────────────────────────────────────

// Games whose dedicated servers read commands from stdin, so we can push an
// in-game chat broadcast. Others (most Unreal/Steam titles) don't, and the
// warning falls back to the Live Console + Discord only.
function serverAcceptsConsoleChat(server) {
  const def = GAME_DEFS[server?.game];
  return !!(def?.type === 'minecraft' || def?.useJava || server?.game === 'Terraria');
}

// Broadcast a restart/shutdown warning: always to the Live Console, in-game chat
// where the engine supports it, and Discord when configured.
function broadcastWarning(serverId, message) {
  const server = appData.servers.find(s => s.id === serverId);
  const proc = serverProcesses[serverId];
  log(serverId, 'warn', `[Broadcast] ${message}`);
  if (proc && serverAcceptsConsoleChat(server)) {
    try { proc.stdin.write(`say ${message}\n`); } catch(e) {}
  }
  if (appSettings.discordEnabled && appSettings.discordWebhookUrl) {
    postDiscordWebhook(appSettings.discordWebhookUrl, {
      title: `⏳ ${server?.name || 'Server'}`,
      description: message,
      color: NOTIFY_COLORS.playerLeave,
    }).catch(() => {});
  }
}

// Track servers mid-countdown so a minute-tick can't start a second sequence.
const pendingShutdowns = new Set();

// Run a scheduled stop/restart, optionally preceded by timed in-game warnings.
// warnMinutes is an array like [15,5,1] — minutes-before-action to announce.
function runScheduledShutdown(serverId, action, warnMinutes) {
  if (pendingShutdowns.has(serverId)) return;
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return;
  const verb = action === 'restart' ? 'restart' : 'shut down';

  const doAction = async () => {
    pendingShutdowns.delete(serverId);
    if (action === 'restart') { await killServer(serverId); setTimeout(() => startServerById(serverId), 3000); }
    else await killServer(serverId);
  };

  // Sanitize: positive whole minutes, unique, largest first.
  const warns = [...new Set((warnMinutes || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => b - a);

  // No warnings, or server isn't running → act right away.
  if (!serverProcesses[serverId] || !warns.length) return void doAction();

  pendingShutdowns.add(serverId);
  const lead = warns[0];
  warns.forEach(m => {
    setTimeout(() => {
      if (!serverProcesses[serverId]) { pendingShutdowns.delete(serverId); return; } // gone already
      broadcastWarning(serverId, `Server will ${verb} in ${m} ${m === 1 ? 'minute' : 'minutes'}!`);
    }, (lead - m) * 60000);
  });
  setTimeout(() => {
    if (!serverProcesses[serverId]) { pendingShutdowns.delete(serverId); return; }
    broadcastWarning(serverId, `Server is ${action === 'restart' ? 'restarting' : 'shutting down'} now!`);
    setTimeout(doAction, 3000);
  }, lead * 60000);
}

setInterval(() => {
  const now=new Date(), hhmm=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  appData.schedules.filter(s=>s.active).forEach(async sched => {
    let run = (sched.freq==='Daily'&&sched.time===hhmm)||(sched.freq==='Hourly'&&now.getMinutes()===0);
    if (!run||!sched.serverId) return;
    log(sched.serverId,'warn',`[Scheduler] ${sched.label}`);
    if (sched.action==='restart' || sched.action==='stop') runScheduledShutdown(sched.serverId, sched.action, sched.warnMinutes);
  });
}, 60000);

// ── Live player list via RCON (Palworld) ────────────────────────────────────
// Poll a Palworld server's online players (name + Steam ID) so the dashboard
// shows the list and count without console parsing (which Palworld doesn't emit).
async function pollPalworldPlayers(s) {
  if (!s || s.game !== 'Palworld' || !serverProcesses[s.id] || !s.rconPassword) return;
  const res = await rconCommand('127.0.0.1', s.rconPort || 25575, s.rconPassword, 'ShowPlayers');
  if (res === null) return;
  // CSV: header line "name,playeruid,steamid" then one row per player.
  const rows = res.split('\n').map(l => l.trim()).filter(Boolean);
  const players = rows.slice(1).map(r => {
    const c = r.split(',');
    return { name: (c[0] || '').trim(), steamId: (c[2] || '').trim() };
  }).filter(p => p.name && p.name.toLowerCase() !== 'name');
  s.players = players;
  emit('players-updated', { serverId: s.id, players });
}

setInterval(() => { for (const s of appData.servers) pollPalworldPlayers(s); }, 20000);

// ── Utility ───────────────────────────────────────────────────────────────────
function findExe(dir, name) {
  if (!name) return null;
  const direct = path.join(dir, name);
  if (fs.existsSync(direct)) return direct;
  // First try one-level-deep (fast path for most games)
  try {
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      if(e.isDirectory()){const n=path.join(dir,e.name,name); if(fs.existsSync(n)) return n;}
    }
  } catch(e){}
  // Deep search for nested layouts (e.g. Palworld: PalServer/Binaries/Win64/PalServer-Win64-Shipping-Cmd.exe)
  try { return findFileRecursive(dir, name, 5); } catch(e) {}
  return null;
}

function classifyLine(t) {
  const l=t.toLowerCase();
  if (l.includes('error')||l.includes('fatal')||l.includes('exception')) return 'error';
  if (l.includes('warn'))  return 'warn';
  if (l.includes('done')||l.includes('ready')||l.includes('started')||l.includes('success')) return 'success';
  if (l.includes('info')||l.startsWith('[')) return 'info';
  return 'normal';
}

// Parse player join/leave/list events from console output
function parsePlayerEvent(serverId, line) {
  const server = appData.servers.find(s => s.id === serverId);
  if (!server) return;
  if (!server.players) server.players = [];

  // Minecraft join: "PlayerName joined the game"
  const joinMatch = line.match(/^([A-Za-z0-9_]+) joined the game/i) ||
                    line.match(/\[Server thread\/INFO\].*?: ([A-Za-z0-9_]+) joined the game/i) ||
                    line.match(/INFO\]: ([A-Za-z0-9_]+) joined the game/i);
  if (joinMatch) {
    const name = joinMatch[1];
    if (!server.players.includes(name)) {
      server.players.push(name);
      notify('playerJoin', {
        title: `➕ ${name} joined ${server.name}`,
        body: `${name} joined the game. ${server.players.length} online.`,
      });
    }
    emit('players-updated', { serverId, players: server.players });
    return;
  }

  // Minecraft leave: "PlayerName left the game"
  const leaveMatch = line.match(/^([A-Za-z0-9_]+) left the game/i) ||
                     line.match(/INFO\]: ([A-Za-z0-9_]+) left the game/i);
  if (leaveMatch) {
    const name = leaveMatch[1];
    const wasOnline = server.players.includes(name);
    server.players = server.players.filter(p => p !== name);
    if (wasOnline) {
      notify('playerLeave', {
        title: `➖ ${name} left ${server.name}`,
        body: `${name} left the game. ${server.players.length} online.`,
      });
    }
    emit('players-updated', { serverId, players: server.players });
    return;
  }

  // Minecraft /list response: "There are X of a max of Y players online: name1, name2"
  const listMatch = line.match(/players online: (.+)$/i);
  if (listMatch && listMatch[1].trim() !== '') {
    const names = listMatch[1].split(',').map(n => n.trim()).filter(Boolean);
    server.players = names;
    emit('players-updated', { serverId, players: server.players });
  }
}

// Player list is maintained via join/leave console parsing (no polling needed)

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const attempt = (u, redirects = 0) => {
      if (redirects > 10) return reject(new Error('Too many redirects'));
      const proto = u.startsWith('https') ? https : http;
      const opts  = { headers: { 'User-Agent': 'Omnex/1.0', 'Accept': '*/*' } };
      const req = proto.get(u, opts, res => {
        // Follow all redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume(); // drain response
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u).href;
          return attempt(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const file  = fs.createWriteStream(dest);
        const total = parseInt(res.headers['content-length'] || '0');
        let done = 0;
        res.on('data', chunk => {
          done += chunk.length;
          if (total && onProgress) onProgress(Math.round((done / total) * 100));
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
    };
    attempt(url);
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const opts  = { headers:{ 'User-Agent':'Omnex/1.0' } };
    proto.get(url, opts, res => {
      if ([301,302].includes(res.statusCode)) return fetchJSON(res.headers.location).then(resolve).catch(reject);
      let data='';
      res.on('data',d=>data+=d);
      res.on('end',()=>{ try{resolve(JSON.parse(data));}catch(e){reject(e);} });
    }).on('error', reject);
  });
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell',['-Command',`Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`]);
    ps.on('close', code => code===0 ? resolve() : reject(new Error(`Extract failed (${code})`)));
    ps.on('error', reject);
  });
}
