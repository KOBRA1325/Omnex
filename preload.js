const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  windowDragStart: (offsetX, offsetY) => ipcRenderer.send('window-drag-start', {offsetX, offsetY}),
  windowDragMove:  (screenX, screenY) => ipcRenderer.send('window-drag-move', {screenX, screenY}),
  windowDragEnd:   () => ipcRenderer.send('window-drag-end'),
  windowResize:    (x, y, width, height) => ipcRenderer.send('window-resize', {x, y, width, height}),
  onWindowState:   (cb) => ipcRenderer.on('window-state', (_, d) => cb(d)),
  windowMinimize:  () => ipcRenderer.send('window-minimize'),
  windowMaximize:  () => ipcRenderer.send('window-maximize'),
  windowClose:     () => ipcRenderer.send('window-close'),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
  openReleasePage: (url) => ipcRenderer.send('open-release-page', url),

  getServers:    ()       => ipcRenderer.invoke('get-servers'),
  getSchedules:  ()       => ipcRenderer.invoke('get-schedules'),
  getAppVersion: ()       => ipcRenderer.invoke('get-app-version'),
  removeServer:  (id)     => ipcRenderer.invoke('remove-server', id),
  installServer: (config) => ipcRenderer.invoke('install-server', config),
  updateServer:  (id)     => ipcRenderer.invoke('update-server', id),

  startServer:  (id)       => ipcRenderer.invoke('start-server', id),
  stopServer:   (id)       => ipcRenderer.invoke('stop-server',  id),
  sendCommand:  (id, cmd)  => ipcRenderer.invoke('send-command', {id, command:cmd}),
  getStats:          ()    => ipcRenderer.invoke('get-stats'),
  getServerBundle:   (id)  => ipcRenderer.invoke('get-server-bundle', id),
  setServerField:    (id, key, value) => ipcRenderer.invoke('set-server-field', {id, key, value}),
  renameServer:      (id, newName)    => ipcRenderer.invoke('rename-server', {id, newName}),
  addFirewallRule:   (id, ports)      => ipcRenderer.invoke('add-firewall-rule', {id, ports}),
  readAppFile:       (filename)       => ipcRenderer.invoke('read-app-file', filename),
  openExternal:      (url)            => ipcRenderer.invoke('open-external', url),
  checkForUpdates:   ()               => ipcRenderer.invoke('check-for-updates'),

  saveSchedule:   (s)  => ipcRenderer.invoke('save-schedule', s),
  toggleSchedule: (id) => ipcRenderer.invoke('toggle-schedule', id),
  deleteSchedule: (id) => ipcRenderer.invoke('delete-schedule', id),

  getMinecraftVersions: () => ipcRenderer.invoke('get-minecraft-versions'),
  getPaperVersions:     () => ipcRenderer.invoke('get-paper-versions'),
  getFabricVersions:    () => ipcRenderer.invoke('get-fabric-versions'),
  checkJava:            (opts) => ipcRenderer.invoke('check-java', opts),
  readServerConfig:    (id)                   => ipcRenderer.invoke('read-server-config', id),
  writeServerConfig:   (id, props)               => ipcRenderer.invoke('write-server-config', { id, props }),
  writeSteamConfig:    (id, props, configPath)    => ipcRenderer.invoke('write-steam-config', { id, props, configPath }),
  getNetworkInfo:      (port)                     => ipcRenderer.invoke('get-network-info', port),

  onConsoleLine:     (cb) => ipcRenderer.on('console-line',      (_, d) => cb(d)),
  onServerStopped:   (cb) => ipcRenderer.on('server-stopped',    (_, d) => cb(d)),
  onServerAdded:     (cb) => ipcRenderer.on('server-added',      (_, d) => cb(d)),
  onServerStatus:    (cb) => ipcRenderer.on('server-status',     (_, d) => cb(d)),
  onInstallComplete: (cb) => ipcRenderer.on('install-complete',  (_, d) => cb(d)),
  onInstallError:    (cb) => ipcRenderer.on('install-error',     (_, d) => cb(d)),
  onInstallNeedsAuth:(cb) => ipcRenderer.on('install-needs-auth', (_, d) => cb(d)),
  onSteamQrCode:     (cb) => ipcRenderer.on('steam-qr-code', (_, d) => cb(d)),
  onAppUpdate:       (cb) => ipcRenderer.on('app-update-available',(_, d) => cb(d)),

  // Backup system
  getBackups:           (id)              => ipcRenderer.invoke('get-backups', id),
  createBackup:         (id, label)       => ipcRenderer.invoke('create-backup', { id, label }),
  restoreBackup:        (serverId, backupId) => ipcRenderer.invoke('restore-backup', { serverId, backupId }),
  deleteBackup:         (serverId, backupId) => ipcRenderer.invoke('delete-backup', { serverId, backupId }),
  getBackupSettings:    (id)              => ipcRenderer.invoke('get-backup-settings', id),
  saveBackupSettings:   (id, settings)    => ipcRenderer.invoke('save-backup-settings', { id, settings }),
  steamPreauth: (username, password) => ipcRenderer.invoke('steam-preauth', { username, password }),

  // Arma 3 Workshop
  getSteamCreds:       ()                           => ipcRenderer.invoke('get-steam-creds'),
  saveSteamUsername:   (username)  => ipcRenderer.invoke('save-steam-username', username),
  saveSteamPassword:   (password)  => ipcRenderer.invoke('save-steam-password', password),
  saveSteamGuardCode:  (code)      => ipcRenderer.invoke('save-steam-guard-code', code),
  saveSteamCredsAll:   (u,p,g)     => ipcRenderer.invoke('save-steam-creds-all', {username:u,password:p,steamGuardCode:g}),
  testSteamLogin:      (u,p,g)     => ipcRenderer.invoke('test-steam-login', {username:u,password:p,steamGuardCode:g}),
  steamDirectLogin:    (u,p,g)     => ipcRenderer.invoke('steam-direct-login', {username:u,password:p,guardCode:g}),
  steamCheckToken:     (u)         => ipcRenderer.invoke('steam-check-token', u),
  steamClearTokens:    (u)         => ipcRenderer.invoke('steam-clear-tokens', u),
  steamSubmitGuardCode:(u,c,t)     => ipcRenderer.invoke('steam-submit-guard-code', {username:u, code:c, codeType:t}),
  steamCancelLogin:    (u)         => ipcRenderer.invoke('steam-cancel-login', u),
  steamcmdAuth:        (u,p,g)     => ipcRenderer.invoke('steamcmd-auth', {username:u,password:p,steamGuardCode:g}),
  parseArma3Preset:    (html)       => ipcRenderer.invoke('parse-arma3-preset', html),
  checkArma3ModUpdates:(sid)        => ipcRenderer.invoke('check-arma3-mod-updates', {serverId:sid}),
  getArma3Mods:        (sid)        => ipcRenderer.invoke('get-arma3-mods', {serverId:sid}),
  saveArma3Config:     (sid,cfg)    => ipcRenderer.invoke('save-arma3-config', {serverId:sid, config:cfg}),
  loadArma3Config:     (sid)        => ipcRenderer.invoke('load-arma3-config', {serverId:sid}),
  getAntistasiMods:    ()                           => ipcRenderer.invoke('get-antistasi-mods'),
  installArma3Mods:    (opts)                       => ipcRenderer.invoke('install-arma3-mods', opts),
  getArma3Mods:        (serverId)                   => ipcRenderer.invoke('get-arma3-mods', serverId),

  // Tray
  trayRebuild: () => ipcRenderer.send('tray-rebuild'),

  // Server import
  importServer: (config) => ipcRenderer.invoke('import-server', config),
  browseFolder: ()       => ipcRenderer.invoke('browse-folder'),

  // Templates
  getTemplates:    ()                  => ipcRenderer.invoke('get-templates'),
  saveTemplate:    (serverId, name)    => ipcRenderer.invoke('save-template', { serverId, name }),
  deleteTemplate:  (id)                => ipcRenderer.invoke('delete-template', id),

  // Remote access
  startRemoteAccess: (port) => ipcRenderer.invoke('start-remote-access', port),
  stopRemoteAccess:  ()     => ipcRenderer.invoke('stop-remote-access'),
  getRemoteStatus:   ()     => ipcRenderer.invoke('get-remote-status'),

  // Settings
  getSettings:       ()         => ipcRenderer.invoke('get-settings'),
  saveSettings:      (settings) => ipcRenderer.invoke('save-settings', settings),
  onSettingsChanged: (cb)       => ipcRenderer.on('settings-changed', (_, d) => cb(d)),

  // Log browser
  getLogFiles:       (id)       => ipcRenderer.invoke('get-log-files', id),
  readLogFile:       (filePath) => ipcRenderer.invoke('read-log-file', filePath),
  openLogFolder:     (id)       => ipcRenderer.invoke('open-log-folder', id),
  openServerFolder:  (id)       => ipcRenderer.invoke('open-server-folder', id),

  // Mod manager
  searchModrinth:        (opts)   => ipcRenderer.invoke('search-modrinth', opts),
  getModrinthVersions:   (opts)   => ipcRenderer.invoke('get-modrinth-versions', opts),
  installMod:            (opts)   => ipcRenderer.invoke('install-mod', opts),
  getInstalledMods:      (id)     => ipcRenderer.invoke('get-installed-mods', id),
  deleteMod:             (serverId, modPath) => ipcRenderer.invoke('delete-mod', { serverId, modPath }),

  // Auto-restart
  getAutoRestart:    (id)          => ipcRenderer.invoke('get-autorestart', id),
  saveAutoRestart:   (id, settings)=> ipcRenderer.invoke('save-autorestart', { id, settings }),

  // Notes
  saveNotes:         (id, notes)            => ipcRenderer.invoke('save-notes', { id, notes }),

  // Players
  getPlayers:        (id)                   => ipcRenderer.invoke('get-players', id),
  playerAction:      (serverId, action, player) => ipcRenderer.invoke('player-action', { serverId, action, player }),
  sendPlayerCommand: (serverId, command)    => ipcRenderer.invoke('send-player-command', { serverId, command }),
  onPlayersUpdated:  (cb) => ipcRenderer.on('players-updated', (_, d) => cb(d)),

  onBackupCreated:      (cb) => ipcRenderer.on('backup-created',       (_, d) => cb(d)),
  onConsoleProgress:    (cb) => ipcRenderer.on('console-progress',     (_, d) => cb(d)),
  onServerCrashed:      (cb) => ipcRenderer.on('server-crashed',       (_, d) => cb(d)),
  onServerConfigChanged:(cb) => ipcRenderer.on('server-config-changed',(_, d) => cb(d)),

  // Storage manager
  getStorageInfo:  ()   => ipcRenderer.invoke('get-storage-info'),
  cleanTempFiles:  ()   => ipcRenderer.invoke('clean-temp-files'),
  cleanOrphans:    ()   => ipcRenderer.invoke('clean-orphans'),
  cleanJava:       (id) => ipcRenderer.invoke('clean-java', id),
  cleanSteamCmd:   ()   => ipcRenderer.invoke('clean-steamcmd'),
  openDataFolder:  ()   => ipcRenderer.invoke('open-data-folder'),

  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),
});
