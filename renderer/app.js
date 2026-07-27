// ── Omnex App.js ─────────────────────────────────────────────────────────────



// ── Window dragging via IPC (no CSS drag regions) ─────────────────────────────
(function setupWindowResize() {
  function init() {
    const handles = document.querySelectorAll('.resize-handle');
    if (!handles.length) { setTimeout(init, 100); return; }

    handles.forEach(handle => {
      handle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = handle.dataset.dir;

        // Capture initial window screen position + size
        const startScreenX = e.screenX;
        const startScreenY = e.screenY;
        const startWinX = window.screenX;
        const startWinY = window.screenY;
        const startWinW = window.outerWidth;
        const startWinH = window.outerHeight;

        // Throttle IPC to animation frame
        let pending = null;
        const doResize = () => {
          if (!pending) return;
          const { screenX, screenY } = pending;
          pending = null;
          const dx = screenX - startScreenX;
          const dy = screenY - startScreenY;
          let x = startWinX, y = startWinY, w = startWinW, h = startWinH;
          if (dir.includes('e')) w = startWinW + dx;
          if (dir.includes('s')) h = startWinH + dy;
          if (dir.includes('w')) { x = startWinX + dx; w = startWinW - dx; }
          if (dir.includes('n')) { y = startWinY + dy; h = startWinH - dy; }
          try { window.nexus.windowResize(x, y, w, h); } catch(err){}
        };

        const onMove = (ev) => {
          pending = { screenX: ev.screenX, screenY: ev.screenY };
          requestAnimationFrame(doResize);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// Hide resize handles when window is maximized (can't resize a maximized window)
try {
  window.nexus.onWindowState?.(({ maximized }) => {
    document.body.classList.toggle('maximized', !!maximized);
  });
} catch(e) {}

// ── Window dragging via IPC (no CSS drag regions) ─────────────────────────────
(function setupWindowDrag() {
  function init() {
    const dragArea = document.querySelector('.titlebar-drag');
    if (!dragArea) {
      setTimeout(init, 100);
      return;
    }
    dragArea.style.cursor = 'default';
    dragArea.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      // Don't drag if clicking on an actual interactive element inside
      const tag = e.target.tagName;
      if (['INPUT','BUTTON','SELECT','TEXTAREA','A'].includes(tag)) return;
      e.preventDefault();
      const rect = dragArea.getBoundingClientRect();
      const offsetX = e.screenX - window.screenX;
      const offsetY = e.screenY - window.screenY;
      try { window.nexus.windowDragStart(offsetX, offsetY); } catch(err){}

      const onMove = (ev) => {
        try { window.nexus.windowDragMove(ev.screenX, ev.screenY); } catch(err){}
      };
      const onUp = () => {
        try { window.nexus.windowDragEnd(); } catch(err){}
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    // Double-click titlebar to toggle maximize/restore (standard OS behavior)
    dragArea.addEventListener('dblclick', e => {
      const tag = e.target.tagName;
      if (['INPUT','BUTTON','SELECT','TEXTAREA','A'].includes(tag)) return;
      try { window.nexus.windowMaximize(); } catch(err){}
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


// ── Modal system ──────────────────────────────────────────────────────────────
function showModal(id) {
  const m = document.getElementById(id);
  if (!m) { console.error('Modal not found:', id); return; }
  if (m.parentNode !== document.body) document.body.appendChild(m);
  // Fix all interactive elements inside
  m.querySelectorAll('input, select, textarea, button, label').forEach(el => {
    el.style.webkitAppRegion = 'no-drag';
    el.style.pointerEvents   = 'all';
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      el.style.userSelect         = 'text';
      el.style.webkitUserSelect   = 'text';
      el.style.cursor             = 'text';
    }
  });
  m.style.display = 'flex';
  m.classList.add('open');
  // Fix inputs and focus
  setTimeout(() => {
    const first = m.querySelector('input:not([disabled]):not([readonly])');
    if (first) first.focus();
  }, 150);
}
function hideModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.style.display = 'none';
  m.classList.remove('open');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      m.style.display = 'none'; m.classList.remove('open');
    });
    closeConsoleSearch();
    closeMoreMenu();
    if (typeof hideServerContextMenu === 'function') hideServerContextMenu();
  }
});

// ── Games list ────────────────────────────────────────────────────────────────
const GAMES = [
  { name:'Minecraft',       port:'25565', icon:'', fallback:'⛏️' },
  { name:'CS2',             port:'27015', icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/730/capsule_sm_120.jpg',     fallback:'🔫' },
  { name:'Valheim',         port:'2456',  icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/892970/capsule_sm_120.jpg',  fallback:'⚔️' },
  { name:'Rust',            port:'28015', icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/252490/capsule_sm_120.jpg',  fallback:'🏕️' },
  { name:'Satisfactory',    port:'15777', icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/526870/capsule_sm_120.jpg',  fallback:'🏭' },
  { name:'Project Zomboid', port:'16261', icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/108600/capsule_sm_120.jpg',  fallback:'🧟' },
  { name:'Ark: Survival',   port:'7777',  icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/346110/capsule_sm_120.jpg',  fallback:'🦕' },
  { name:'V Rising',        port:'9876',  icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/1604030/capsule_sm_120.jpg', fallback:'🧛' },
  { name:'Terraria',        port:'7777',  icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/capsule_sm_120.jpg',  fallback:'🌳' },
  { name:'7 Days to Die',   port:'26900', icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/251570/capsule_sm_120.jpg',  fallback:'💀' },
  { name:'Palworld',        port:'8211',  icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/1623730/capsule_sm_120.jpg', fallback:'🐾' },
  { name:'Enshrouded',      port:'15636', icon:'https://cdn.cloudflare.steamstatic.com/steam/apps/1203620/capsule_sm_120.jpg', fallback:'🌫️' },
];

// ── State ─────────────────────────────────────────────────────────────────────
let servers   = [], schedules = [], activeId = null, uptimeSec = 0;
let statsInterval = null, uptimeInterval = null, appSettings = {}, currentView = 'dashboard';
let __manualUpdateCheck = false, appVersionStr = '';
let selectedGame = GAMES[0], selectedMcType = 'vanilla', addModalMode = 'install';
let importGameSel = GAMES[0], currentTheme = 'dark', _cachedBundle = null;
let MAX_CONSOLE_LINES = 500, _consoleBuf = [], _consoleRaf = null;
const chartData = { cpu: new Array(60).fill(0), ram: new Array(60).fill(0) };
let workshopSelectedMods = [], workshopServerId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getActive() { return servers.find(s => s.id === activeId) || null; }
function escapeHtml(t) { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function formatBytes(b) {
  if (b < 1024) return b+' B'; if (b < 1048576) return (b/1024).toFixed(1)+' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(2)+' GB';
}
function formatUptime(s) {
  if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}
function showToast(icon, msg) {
  const t = document.getElementById('toast'); if (!t) return;
  t.innerHTML = `<span>${icon}</span> ${escapeHtml(msg)}`;
  t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000);
}
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('📋', `Copied: ${text}`)).catch(() => showToast('❌', 'Copy failed'));
}

// ── Console ───────────────────────────────────────────────────────────────────
function appendLog(type, text, ts) {
  const time = ts || new Date().toLocaleTimeString('en-US', { hour12: false });
  text.split('\n').filter(l => l.trim()).forEach(l => _consoleBuf.push({ type, text: l, time }));
  if (!_consoleRaf) _consoleRaf = requestAnimationFrame(_flushConsole);
}
function _flushConsole() {
  _consoleRaf = null; if (!_consoleBuf.length) return;
  const out = document.getElementById('consoleOutput'); if (!out) { _consoleBuf = []; return; }
  const wasAtBottom = out.scrollHeight - out.scrollTop < out.clientHeight + 80;
  const frag = document.createDocumentFragment();
  _consoleBuf.forEach(({ type, text, time }) => {
    const row = document.createElement('div'); row.className = 'log-line';
    row.innerHTML = `<span class="log-ts">${time}</span><span class="log-${type}">${escapeHtml(text)}</span>`;
    frag.appendChild(row);
  });
  _consoleBuf = []; out.appendChild(frag);
  const all = out.querySelectorAll('.log-line:not(.progress-line)');
  if (all.length > MAX_CONSOLE_LINES) for (let i = 0; i < all.length - MAX_CONSOLE_LINES; i++) all[i].remove();
  if (wasAtBottom) out.scrollTop = out.scrollHeight;
}
function clearConsole() {
  const out = document.getElementById('consoleOutput'); if (out) out.innerHTML = '';
  appendLog('dim', 'Console cleared.');
}

// ── Console search ────────────────────────────────────────────────────────────
let searchMatches = [], searchIdx = 0;
function toggleConsoleSearch() {
  const wrap = document.getElementById('consoleSearchWrap');
  const inp  = document.getElementById('consoleSearchInput');
  if (!wrap) return;
  const isOpen = wrap.style.display !== 'none';
  if (isOpen) closeConsoleSearch();
  else { wrap.style.display = 'flex'; inp && inp.focus(); }
}
function closeConsoleSearch() {
  const wrap = document.getElementById('consoleSearchWrap'); if (!wrap) return;
  wrap.style.display = 'none';
  const inp = document.getElementById('consoleSearchInput'); if (inp) inp.value = '';
  const cnt = document.getElementById('consoleSearchCount'); if (cnt) cnt.textContent = '';
  document.querySelectorAll('.log-line.search-match').forEach(el => el.classList.remove('search-match','search-current'));
  searchMatches = [];
}
function searchConsole(query) {
  document.querySelectorAll('.log-line.search-match').forEach(el => el.classList.remove('search-match','search-current'));
  searchMatches = []; searchIdx = 0;
  if (!query.trim()) { const cnt = document.getElementById('consoleSearchCount'); if(cnt) cnt.textContent=''; return; }
  const out = document.getElementById('consoleOutput'); if (!out) return;
  const lower = query.toLowerCase();
  out.querySelectorAll('.log-line').forEach(line => {
    if (line.textContent.toLowerCase().includes(lower)) { line.classList.add('search-match'); searchMatches.push(line); }
  });
  const cnt = document.getElementById('consoleSearchCount');
  if (!searchMatches.length) { if(cnt) { cnt.textContent='No results'; cnt.style.color='var(--red)'; } return; }
  if(cnt) { cnt.style.color='var(--text-dim)'; }
  scrollToMatch(0);
}
function scrollToMatch(idx) {
  if (!searchMatches.length) return;
  searchIdx = (idx + searchMatches.length) % searchMatches.length;
  searchMatches.forEach(el => el.classList.remove('search-current'));
  searchMatches[searchIdx].classList.add('search-current');
  searchMatches[searchIdx].scrollIntoView({ block:'center', behavior:'smooth' });
  const cnt = document.getElementById('consoleSearchCount');
  if(cnt) cnt.textContent = `${searchIdx+1} / ${searchMatches.length}`;
}
function searchConsoleKey(e) {
  if (e.key === 'Enter') e.shiftKey ? scrollToMatch(searchIdx-1) : scrollToMatch(searchIdx+1);
  if (e.key === 'Escape') closeConsoleSearch();
}
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    // If config modal is open, focus its search instead of console search
    const configModal = document.getElementById('configModal');
    if (configModal && configModal.classList.contains('open')) {
      e.preventDefault();
      const search = document.getElementById('configModalSearch');
      if (search) { search.focus(); search.select(); }
      return;
    }
    e.preventDefault();
    toggleConsoleSearch();
  }
});

// ── Theme ─────────────────────────────────────────────────────────────────────
function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme); localStorage.setItem('omnexTheme', currentTheme);
  const btn = document.getElementById('themeToggleBtn'); if(btn) btn.textContent = currentTheme==='dark'?'🌙':'☀️';
}
function applyTheme(theme) {
  const r = document.documentElement;
  if (theme === 'light') {
    r.style.setProperty('--bg','#f0f2f5'); r.style.setProperty('--surface','#ffffff');
    r.style.setProperty('--panel','#f8f9fb'); r.style.setProperty('--border','#e1e4e8');
    r.style.setProperty('--text','#24292e'); r.style.setProperty('--text-dim','#6a737d');
    r.style.setProperty('--text-bright','#1a1f24'); r.style.setProperty('--accent','#0066cc');
    r.style.setProperty('--green','#28a745'); r.style.setProperty('--red','#dc3545'); r.style.setProperty('--yellow','#e6a817');
  } else {
    r.style.setProperty('--bg','#0a0c10'); r.style.setProperty('--surface','#0f1218');
    r.style.setProperty('--panel','#141820'); r.style.setProperty('--border','#1e2535');
    r.style.setProperty('--text','#c8d4e8'); r.style.setProperty('--text-dim','#5a6a80');
    r.style.setProperty('--text-bright','#e8f0ff'); r.style.setProperty('--accent','#00e5ff');
    r.style.setProperty('--green','#39ff6e'); r.style.setProperty('--red','#ff3b5c'); r.style.setProperty('--yellow','#ffd700');
  }
  currentTheme = theme;
}

// ── More menu ─────────────────────────────────────────────────────────────────
function toggleMoreMenu() {
  const menu = document.getElementById('moreMenu'); if(!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}
function closeMoreMenu() {
  const menu = document.getElementById('moreMenu'); if(menu) menu.style.display = 'none';
}
document.addEventListener('click', e => {
  const wrap = document.getElementById('moreMenuWrap');
  if (wrap && !wrap.contains(e.target)) closeMoreMenu();
});

// ── Collapsible cards ─────────────────────────────────────────────────────────
function toggleCard(cardId) {
  const card = document.getElementById(cardId); if (!card) return;
  const body = card.querySelector('.card-body-collapsible') || card.querySelector('.card-body');
  const chevron = card.querySelector('.card-chevron'); if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  if (chevron) chevron.textContent = isOpen ? '▸' : '▾';
}

// ── View switching ────────────────────────────────────────────────────────────
function showView(view) {
  currentView = view;
  const dash = document.getElementById('dashboardView');
  const main = document.getElementById('mainView');
  const label = document.getElementById('serverListLabel');
  if (dash) dash.style.display = view === 'dashboard' ? 'flex' : 'none';
  if (main) main.style.display = view === 'servers' ? 'flex' : 'none';
  if (label) label.style.display = view === 'servers' ? '' : 'none';
  const navDash = document.getElementById('navDashboard');
  const navServ = document.getElementById('navServers');
  if (navDash) navDash.classList.toggle('active', view === 'dashboard');
  if (navServ) navServ.classList.toggle('active', view === 'servers');
  if (view === 'dashboard') renderDashboard();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const grid     = document.getElementById('dashboardGrid');
  const subtitle = document.getElementById('dashSubtitle');
  const onboarding = document.getElementById('onboardingPrompt');
  const online  = servers.filter(s => s.status === 'online').length;
  const total   = servers.length;
  const crashed = servers.filter(s => s.status === 'crashed').length;
  if (subtitle) subtitle.textContent = total === 0 ? 'No servers configured'
    : `${online} of ${total} server${total!==1?'s':''} online${crashed?` · ${crashed} crashed`:''}`;
  if (total === 0) {
    if (grid) grid.style.display = 'none';
    if (onboarding) onboarding.style.display = 'flex';
    return;
  }
  if (grid) grid.style.display = '';
  if (onboarding) onboarding.style.display = 'none';
  if (!grid) return;
  grid.innerHTML = servers.map(s => {
    const isOnline = s.status === 'online', isCrashed = s.status === 'crashed';
    const statusColor = isOnline ? 'var(--green)' : isCrashed ? 'var(--red)' : 'var(--text-dim)';
    const statusLabel = isOnline ? 'ONLINE' : isCrashed ? 'CRASHED' : (s.status||'OFFLINE').toUpperCase();
    const g = GAMES.find(g => g.name === s.game);
    const players = s.players?.length || 0;
    return `<div class="dash-card" onclick="openServerDash('${s.id}')">
      ${g ? `<div class="dash-card-banner">${g.icon ? `<img src="${g.icon}" alt="${s.game}" onerror="this.style.display='none'">` : `<span style="font-size:48px">${g.fallback||'🎮'}</span>`}
        <div class="dash-card-banner-overlay"></div>
        <div class="dash-card-banner-status"><div class="dash-status-dot" style="background:${statusColor};box-shadow:0 0 8px ${statusColor}"></div>
        <span style="font-size:10px;color:${statusColor};font-family:'Share Tech Mono',monospace;letter-spacing:1px">${statusLabel}</span></div></div>` : ''}
      <div class="dash-card-header">
        <div class="dash-card-info">
          <div class="dash-card-name">${escapeHtml(s.name)}</div>
          <div class="dash-card-game">${s.game}${s.mcVersion?` ${s.mcVersion}`:''}${s.mcType&&s.mcType!=='vanilla'?` · ${s.mcType}`:''}</div>
        </div>
      </div>
      <div class="dash-card-stats">
        <div class="dash-stat"><div class="dash-stat-label">Port</div><div class="dash-stat-value">${s.port}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Players</div><div class="dash-stat-value" style="color:${isOnline?'var(--green)':'var(--text-dim)'}">${isOnline?players:'—'}</div></div>
        <div class="dash-stat"><div class="dash-stat-label">Status</div><div class="dash-stat-value" style="color:${statusColor}">${statusLabel}</div></div>
      </div>
      <div class="dash-card-actions">
        ${isOnline
          ? `<button class="dash-btn dash-btn-stop"    onclick="dashAction(event,'stop','${s.id}')">⏹ Stop</button>
             <button class="dash-btn dash-btn-restart" onclick="dashAction(event,'restart','${s.id}')">🔄 Restart</button>`
          : `<button class="dash-btn dash-btn-start"   onclick="dashAction(event,'start','${s.id}')">▶ Start</button>`}
        <button class="dash-btn dash-btn-logs" onclick="openLogsForServer(event,'${s.id}')">📋 Logs</button>
      </div>
    </div>`;
  }).join('');
}
function openServerDash(id) { showView('servers'); selectServer(id); }
async function dashAction(e, action, id) {
  e.stopPropagation();
  const prev = activeId; activeId = id;
  await serverAction(action); activeId = prev;
  setTimeout(renderDashboard, 500);
}
setInterval(() => { if (currentView === 'dashboard') renderDashboard(); }, 5000);

// ── Welcome screen ────────────────────────────────────────────────────────────
async function checkFirstRun() {
  try {
    const ver = await window.nexus.getAppVersion();
    const el = document.getElementById('welcomeVersion'); if(el) el.textContent = `v${ver}`;
  } catch(e) {}
  // Show welcome on every launch unless the user has opted out permanently
  const permanentlyDismissed = localStorage.getItem('welcomeDontShow') === '1';
  if (!permanentlyDismissed) {
    const wv = document.getElementById('welcomeView'); if(wv) wv.style.display = 'flex';
  }
}
function dismissWelcome() {
  // If checkbox is checked, remember to skip the welcome from now on
  const cb = document.getElementById('welcomeDontShow');
  if (cb && cb.checked) {
    localStorage.setItem('welcomeDontShow', '1');
  }
  const wv = document.getElementById('welcomeView'); if(wv) wv.style.display = 'none';
  showView('dashboard');
}
function resetWelcomeScreen() {
  localStorage.removeItem('welcomeDontShow');
  // Also clear the old key from earlier versions
  localStorage.removeItem('welcomeDismissed');
  showToast('👋', 'Welcome screen will show on next launch');
}

async function openLicenseInfo() {
  try {
    const text = await window.nexus.readAppFile('LICENSE');
    showTextModal('Omnex License Agreement', text || 'License file not found.');
  } catch(e) { showToast('❌', 'Could not open LICENSE'); }
}
async function openThirdPartyInfo() {
  try {
    const text = await window.nexus.readAppFile('THIRD_PARTY_NOTICES.md');
    showTextModal('Third-Party Notices', text || 'Third-party notices not found.');
  } catch(e) { showToast('❌', 'Could not open notices'); }
}
async function checkForUpdates() {
  showToast('⬆️', 'Checking for updates...');
  __manualUpdateCheck = true;
  try {
    const r = await window.nexus.updaterCheck();
    // Auto mode: results arrive asynchronously via handleUpdateStatus events.
    if (r?.mode === 'manual') {
      __manualUpdateCheck = false;
      if (r.updateAvailable) {
        showUpdateBanner(r.latest, r.url);
        showToast('🎉', `Version ${r.latest} is available — use the banner to download.`);
      } else if (r.ok) {
        showToast('✅', `You are on the latest version (${r.current})`);
      } else {
        showToast('❌', r.error || 'Update check failed');
      }
    }
  } catch(e) { __manualUpdateCheck = false; showToast('❌', e.message); }
}
async function reportBug() {
  let ver = '';
  try { ver = await window.nexus.getAppVersion(); } catch(e) {}
  const body = [
    '**Describe the bug**',
    '',
    '',
    '**Steps to reproduce**',
    '1. ',
    '2. ',
    '',
    '**What you expected to happen**',
    '',
    '',
    '---',
    `Omnex version: ${ver ? 'v' + ver : '(unknown)'}`,
    'Windows version: ',
    'Game / server type (if relevant): ',
  ].join('\n');
  const url = 'https://github.com/KOBRA1325/Omnex/issues/new'
    + '?labels=bug'
    + '&title=' + encodeURIComponent('[Bug] ')
    + '&body='  + encodeURIComponent(body);
  window.nexus.openExternal(url);
  showToast('🐞', 'Opening bug report in your browser…');
}
function showTextModal(title, text) {
  const existing = document.getElementById('textInfoModal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'textInfoModal';
  overlay.className = 'modal-overlay open';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal modal-wide modal-tall" style="width:min(680px, 92vw)">
      <div class="modal-title">
        <span>${escapeHtml(title)}</span>
        <button class="btn-modal-cancel" onclick="closeTextModal()">✕ Close</button>
      </div>
      <div style="padding:14px 20px; overflow-y:auto; flex:1; font-family:'Share Tech Mono',monospace; font-size:11px; line-height:1.7; color:var(--text); white-space:pre-wrap">${escapeHtml(text)}</div>
      <div class="modal-actions">
        <button class="btn-modal-cancel" onclick="closeTextModal()">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeTextModal() {
  const m = document.getElementById('textInfoModal');
  if (m) m.remove();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('serverList'); if (!list) return;
  list.innerHTML = servers.map(s => {
    const isOnline = s.status === 'online', isCrashed = s.status === 'crashed';
    const statusClass = isOnline ? 'online' : isCrashed ? 'crashed' : '';
    const g = GAMES.find(g => g.name === s.game);
    return `<div class="server-item ${s.id===activeId?'active':''}" onclick="selectServer('${s.id}')" oncontextmenu="showServerContextMenu(event, '${s.id}')">
      <div class="server-item-icon">
        ${g ? (g.icon ? `<img src="${g.icon}" alt="${s.game}" onerror="this.style.display='none';this.nextSibling.style.display='flex'"><span class="server-fallback" style="display:none">${g.fallback}</span>` : `<span>${g.fallback||s.game[0]}</span>`) : `<span>${s.game[0]}</span>`}
      </div>
      <div class="server-item-info">
        <div class="server-item-name">${escapeHtml(s.name)}</div>
        <div class="server-item-meta">${s.game} · ${s.port}</div>
      </div>
      <div class="server-status-dot ${statusClass}"></div>
    </div>`;
  }).join('') || '<div class="empty-msg-sm">No servers yet.</div>';
}

// ── Server selection ──────────────────────────────────────────────────────────
// ── Server context menu (right-click in sidebar) ─────────────────────────────
function showServerContextMenu(event, serverId) {
  event.preventDefault();
  event.stopPropagation();
  hideServerContextMenu(); // remove any open menu first

  const s = servers.find(sv => sv.id === serverId);
  if (!s) return;

  const menu = document.createElement('div');
  menu.id = 'serverContextMenu';
  menu.className = 'server-context-menu';
  menu.innerHTML = `
    <div class="scm-item" onclick="ctxSelectServer('${serverId}')">
      <span class="scm-icon">👁</span>Select
    </div>
    <div class="scm-item" onclick="ctxBrowseLocalFiles('${serverId}')">
      <span class="scm-icon">📁</span>Browse local files
    </div>
    <div class="scm-item" onclick="ctxOpenLogFolder('${serverId}')">
      <span class="scm-icon">📄</span>Open logs folder
    </div>
    <div class="scm-divider"></div>
    <div class="scm-item" onclick="ctxRenameServer('${serverId}')">
      <span class="scm-icon">✏️</span>Rename server
    </div>
    <div class="scm-item scm-danger" onclick="ctxRemoveServer('${serverId}')">
      <span class="scm-icon">🗑</span>Remove server
    </div>
  `;
  document.body.appendChild(menu);

  // Position at cursor, clamp to viewport
  const rect = { w: 200, h: menu.offsetHeight || 160 };
  const x = Math.min(event.clientX, window.innerWidth - rect.w - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.h - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // Dismiss on click-away or Escape
  setTimeout(() => {
    document.addEventListener('click', hideServerContextMenu, { once: true });
    document.addEventListener('contextmenu', hideServerContextMenu, { once: true });
  }, 0);
}
function hideServerContextMenu() {
  const m = document.getElementById('serverContextMenu');
  if (m) m.remove();
}
function ctxSelectServer(id) {
  hideServerContextMenu();
  selectServer(id);
}
async function ctxBrowseLocalFiles(id) {
  hideServerContextMenu();
  try {
    const r = await window.nexus.openServerFolder(id);
    if (!r?.ok) showToast('❌', r?.error || 'Could not open folder');
  } catch(e) {
    showToast('❌', e.message);
  }
}
async function ctxOpenLogFolder(id) {
  hideServerContextMenu();
  try { await window.nexus.openLogFolder(id); }
  catch(e) { showToast('❌', e.message); }
}
async function ctxRenameServer(id) {
  hideServerContextMenu();
  const s = servers.find(sv => sv.id === id);
  if (!s) return;
  // Simple inline prompt using our own modal since Electron blocks window.prompt
  showRenameModal(s);
}
function showRenameModal(server) {
  const existing = document.getElementById('renameModal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'renameModal';
  overlay.className = 'modal-overlay open';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="width:min(440px, 90vw)">
      <div class="modal-title">
        <span>✏️ &nbsp;Rename <span>Server</span></span>
      </div>
      <div style="padding:14px 16px 4px">
        <div style="color:var(--text-dim); font-size:11px; margin-bottom:8px">Current name</div>
        <div style="font-family:'Share Tech Mono',monospace; color:var(--text-bright); margin-bottom:14px; padding:8px 10px; background:var(--surface); border-radius:4px; font-size:12px">${escapeHtml(server.name)}</div>
        <div style="color:var(--text-dim); font-size:11px; margin-bottom:6px">New name</div>
        <input type="text" id="renameServerInput" class="form-input" placeholder="Enter new server name"
          value="${escapeHtml(server.name)}"
          style="width:100%; font-size:13px; pointer-events:auto"
          onkeydown="if(event.key==='Enter'){event.preventDefault();confirmRename('${server.id}');}else if(event.key==='Escape'){cancelRename();}">
        <div style="color:var(--text-dim); font-size:10px; margin-top:6px; line-height:1.5">
          The install folder will keep its current path. Only the display name and game-side ServerName update.
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-modal-cancel" onclick="cancelRename()">Cancel</button>
        <button class="btn-modal-save" onclick="confirmRename('${server.id}')">💾 Rename</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => {
    const inp = document.getElementById('renameServerInput');
    if (inp) { inp.focus(); inp.select(); }
  }, 50);
}
function cancelRename() {
  const m = document.getElementById('renameModal');
  if (m) m.remove();
}
async function confirmRename(id) {
  const inp = document.getElementById('renameServerInput');
  if (!inp) return;
  const newName = inp.value.trim();
  if (!newName) { showToast('⚠️', 'Name cannot be empty'); return; }
  if (newName.length > 60) { showToast('⚠️', 'Name too long (max 60 chars)'); return; }
  const s = servers.find(sv => sv.id === id);
  if (!s) return;
  if (newName === s.name) { cancelRename(); return; }
  try {
    const r = await window.nexus.renameServer(id, newName);
    if (r?.ok) {
      s.name = newName;
      cancelRename();
      renderSidebar();
      if (activeId === id) renderHeader();
      showToast('✅', `Renamed to "${newName}". Restart the server for the in-game name to update.`);
    } else {
      showToast('❌', r?.error || 'Rename failed');
    }
  } catch(e) {
    showToast('❌', e.message);
  }
}

async function ctxRemoveServer(id) {
  hideServerContextMenu();
  const s = servers.find(sv => sv.id === id);
  if (!s) return;
  if (!confirm(`Remove "${s.name}"? This will not delete the install files.`)) return;
  try {
    await window.nexus.removeServer(id);
    servers = servers.filter(sv => sv.id !== id);
    if (activeId === id) activeId = null;
    renderSidebar();
    if (servers.length === 0) showView('dashboard');
    else if (!activeId) selectServer(servers[0].id);
    showToast('🗑', 'Server removed');
  } catch(e) {
    showToast('❌', e.message);
  }
}

async function selectServer(id) {
  if (!id) return;
  activeId = id; uptimeSec = 0;
  clearInterval(statsInterval); clearInterval(uptimeInterval);
  renderSidebar(); renderHeader();
  appendLog('dim', '─'.repeat(55));
  const s = servers.find(sv => sv.id === id);
  if (s) {
    appendLog('info', `Selected: ${s.name} [${s.game}] · Port ${s.port}`);
    if (s.game === 'Minecraft') checkJavaStatus(s.id);
  }
  try {
    const bundle = await window.nexus.getServerBundle(id);
    if (bundle?.ok) {
      if (bundle.schedules) schedules = bundle.schedules;
      renderSchedules();
      renderBackupCardWithData(s, bundle.backups||[], bundle.backupSettings||{});
      renderNotesFromBundle(bundle);
      renderPlayerList(bundle.players||[]);
    } else {
      renderSchedules(); renderBackupCard(); renderNotes(); renderPlayerList([]);
    }
  } catch(e) {
    renderSchedules(); renderBackupCard(); renderNotes(); renderPlayerList([]);
  }
  renderConfigCard(); renderNetworkCard();
  startStatsPolling();
  if (s?.status === 'online') startUptimeCounter();
}


// ── Console status badge ──────────────────────────────────────────────────────
function updateConsoleBadge() {
  const badge = document.getElementById('liveBadge');
  if (!badge) return;
  const s = getActive();
  // Clear all status classes
  badge.classList.remove('installing','updating','offline','crashed');
  if (!s) {
    badge.classList.add('offline');
    badge.innerHTML = '<div class="live-dot"></div> IDLE';
    return;
  }
  switch (s.status) {
    case 'installing':
      badge.classList.add('installing');
      badge.innerHTML = '<div class="live-dot"></div> INSTALLING';
      break;
    case 'updating':
      badge.classList.add('updating');
      badge.innerHTML = '<div class="live-dot"></div> UPDATING';
      break;
    case 'starting':
      badge.classList.add('updating');
      badge.innerHTML = '<div class="live-dot"></div> STARTING';
      break;
    case 'online':
      badge.innerHTML = '<div class="live-dot"></div> LIVE';
      break;
    case 'crashed':
      badge.classList.add('crashed');
      badge.innerHTML = '<div class="live-dot"></div> CRASHED';
      break;
    case 'error':
      badge.classList.add('crashed');
      badge.innerHTML = '<div class="live-dot"></div> ERROR';
      break;
    default:
      badge.classList.add('offline');
      badge.innerHTML = '<div class="live-dot"></div> OFFLINE';
  }
}

// ── Header ────────────────────────────────────────────────────────────────────
function renderHeader() {
  const s = getActive();
  const hdrName   = document.getElementById('hdrName');
  const hdrMeta   = document.getElementById('hdrMeta');
  const hdrStatus = document.getElementById('hdrStatus');
  if (!hdrName) return;
  if (!s) {
    hdrName.textContent = 'No server selected'; hdrMeta.textContent = ''; if(hdrStatus) hdrStatus.textContent='';
    ['btnStart','btnStop','btnRestart','btnUpdate','btnSchedule','btnBackup','btnMore','btnRemove'].forEach(id => {
      const el = document.getElementById(id); if(el) el.disabled = true;
    });
    updateConsoleBadge();
    return;
  }
  const isOnline = s.status === 'online';
  const isBusy = ['installing','updating','starting'].includes(s.status);
  const isInstalled = !!s.execPath; // Has been installed (executable found)
  const canStart = isInstalled && !isOnline && !isBusy;
  hdrName.textContent = s.name;
  hdrMeta.textContent = `${s.port}  ${s.game}${s.mcVersion?' v'+s.mcVersion:''}${s.mcType&&s.mcType!=='vanilla'?' '+s.mcType:''}`;
  if (hdrStatus) {
    const statusLabel = (s.status||'offline').toUpperCase();
    const statusColor = isOnline ? 'var(--green)' : s.status==='crashed' ? 'var(--red)' : 'var(--text-dim)';
    hdrStatus.innerHTML = `<span style="color:${statusColor}">● ${statusLabel}</span>`;
  }
  const btnStart   = document.getElementById('btnStart');
  const btnStop    = document.getElementById('btnStop');
  const btnRestart = document.getElementById('btnRestart');
  const btnUpdate  = document.getElementById('btnUpdate');
  const btnConfig  = document.getElementById('btnConfig');
  const btnSched   = document.getElementById('btnSchedule');
  const btnBackup  = document.getElementById('btnBackup');
  const btnMore    = document.getElementById('btnMore');
  const btnLogs    = document.getElementById('btnLogs');
  const btnMods    = document.getElementById('btnMods');
  const btnWS      = document.getElementById('btnWorkshop');
  const btnRemove = document.getElementById('btnRemove');
  if(btnStart) {
    btnStart.disabled = !canStart;
    btnStart.title = !isInstalled ? 'Server not yet installed' : isBusy ? 'Server is busy' : isOnline ? 'Already running' : 'Start server';
  }
  if(btnStop)    btnStop.disabled    = !isOnline || isBusy;
  if(btnRestart) btnRestart.disabled = !isOnline || isBusy;
  if(btnUpdate)  btnUpdate.disabled  = isBusy;
  if(btnConfig)  btnConfig.disabled  = !s.installDir;
  if(btnSched)   btnSched.disabled   = false;
  if(btnBackup)  btnBackup.disabled  = isBusy;
  if(btnMore)    btnMore.disabled    = false;
  if(btnLogs)    btnLogs.disabled    = false;
  if(btnMods)    btnMods.disabled    = !['paper','fabric','forge'].includes(s.mcType);
  if(btnWS) btnWS.style.display = 'none';
  if(btnRemove) btnRemove.disabled = isBusy;
  updateConsoleBadge();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function startStatsPolling() {
  clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    const s = getActive(); if (!s || s.status !== 'online') return;
    try { const stats = await window.nexus.getStats(); renderStats(stats); } catch(e) {}
  }, 2000);
}
function startUptimeCounter() {
  clearInterval(uptimeInterval);
  uptimeInterval = setInterval(() => {
    uptimeSec++;
    const el = document.getElementById('statUptime'); if(el) el.textContent = formatUptime(uptimeSec);
  }, 1000);
}
function renderStats(stats) {
  const cpu = document.getElementById('statCpu');
  const ram = document.getElementById('statRam');
  const bar_cpu = document.getElementById('barCpu');
  const bar_ram = document.getElementById('barRam');
  if (!stats) {
    if(cpu) cpu.textContent='—'; if(ram) ram.textContent='—';
    if(bar_cpu) bar_cpu.style.width='0%'; if(bar_ram) bar_ram.style.width='0%';
    clearChartData(); return;
  }
  if(cpu) cpu.textContent = stats.systemCpu+'%';
  if(ram) ram.textContent = stats.systemRam+'%';
  if(bar_cpu) bar_cpu.style.width = stats.systemCpu+'%';
  if(bar_ram) bar_ram.style.width = stats.systemRam+'%';
  pushChartData(stats.systemCpu||0, stats.systemRam||0);
}
function pushChartData(cpu, ram) {
  chartData.cpu.push(cpu); chartData.ram.push(ram);
  if (chartData.cpu.length > 60) { chartData.cpu.shift(); chartData.ram.shift(); }
  drawChart();
}
function clearChartData() { chartData.cpu.fill(0); chartData.ram.fill(0); drawChart(); }
function drawChart() {
  const canvas = document.getElementById('statsChart'); if (!canvas || !canvas.offsetWidth) return;
  const ctx = canvas.getContext('2d'), W = canvas.offsetWidth, H = canvas.offsetHeight;
  canvas.width = W; canvas.height = H; ctx.clearRect(0,0,W,H);
  ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=1;
  [25,50,75].forEach(p => { const y=H-(p/100)*H; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); });
  const drawLine = (data, color, glow) => {
    if (data.every(v=>v===0)) return;
    const step = W/(60-1); ctx.beginPath();
    data.forEach((v,i) => { const x=i*step, y=H-(v/100)*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.shadowBlur=6; ctx.shadowColor=glow; ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.stroke(); ctx.shadowBlur=0;
    ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath();
    const grad=ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,color.replace(')',',.18)').replace('rgb','rgba'));
    grad.addColorStop(1,color.replace(')',',.00)').replace('rgb','rgba'));
    ctx.fillStyle=grad; ctx.fill();
  };
  drawLine(chartData.cpu,'rgb(0,229,255)','#00e5ff');
  drawLine(chartData.ram,'rgb(57,255,110)','#39ff6e');
  ctx.font='9px Share Tech Mono,monospace'; ctx.fillStyle='rgba(0,229,255,0.7)'; ctx.fillText('CPU',4,11);
  ctx.fillStyle='rgba(57,255,110,0.7)'; ctx.fillText('RAM',30,11);
}

// ── Server actions ────────────────────────────────────────────────────────────
async function serverAction(action) {
  const s = getActive(); if (!s) return;
  try {
    if (action === 'start') {
      await window.nexus.startServer(s.id);
      s.status = 'online'; renderHeader(); renderSidebar();
      startStatsPolling(); startUptimeCounter();
      if(currentView==='dashboard') renderDashboard();
      try { window.nexus.trayRebuild(); } catch(e) {}
    } else if (action === 'stop') {
      await window.nexus.stopServer(s.id);
    } else if (action === 'restart') {
      await window.nexus.stopServer(s.id);
      setTimeout(() => window.nexus.startServer(s.id), 2000);
    }
  } catch(err) { showToast('❌', err.message); }
}
async function updateCurrentServer() {
  const s = getActive(); if (!s) return;
  await window.nexus.updateServer(s.id);
  showToast('🔄', 'Update started...');
}
async function sendCommand() {
  const s = getActive(); if (!s || s.status !== 'online') return;
  const inp = document.getElementById('cmdInput'); if (!inp) return;
  const cmd = inp.value.trim(); if (!cmd) return;
  appendLog('cmd', `> ${cmd}`);
  await window.nexus.sendCommand(s.id, cmd);
  inp.value = '';
}
async function removeCurrentServer() {
  const s = getActive(); if (!s) return;
  if (!confirm(`Remove "${s.name}"? This cannot be undone.`)) return;
  const removedName = s.name;
  clearInterval(statsInterval); clearInterval(uptimeInterval);
  await window.nexus.removeServer(s.id);
  servers = await window.nexus.getServers();
  activeId = null;
  const out = document.getElementById('consoleOutput'); if(out) out.innerHTML='';
  const hdrName = document.getElementById('hdrName'); if(hdrName) hdrName.textContent='No server selected';
  const hdrMeta = document.getElementById('hdrMeta'); if(hdrMeta) hdrMeta.textContent='';
  ['btnStart','btnStop','btnRestart','btnUpdate','btnSchedule','btnBackup','btnMore'].forEach(id => {
    const el = document.getElementById(id); if(el) el.disabled=true;
  });
  renderStats(null); renderPlayerList([]); renderSidebar();
  showView('dashboard'); renderDashboard();
  showToast('🗑️', `${removedName} removed`);
}

// ── Add Server Modal ──────────────────────────────────────────────────────────
function openAddModal() {
  selectedGame = GAMES[0]; selectedMcType = 'vanilla'; addModalMode = 'install';
  renderGameGrid();
  const nameInput = document.getElementById('newSrvName');
  const portInput = document.getElementById('newSrvPort');
  if (!nameInput || !portInput) { showModal('addModal'); return; }
  nameInput.disabled = false; nameInput.style.opacity='1'; nameInput.style.pointerEvents='auto';
  nameInput.value = ''; portInput.value = GAMES[0].port;
  updateInstallInfo(); updateInstallBtn(); updateMcVisibility();
  showModal('addModal');
  setTimeout(() => { nameInput.focus(); }, 150);
  setTimeout(() => { try { switchAddTab('install'); } catch(e){} }, 50);
  setTimeout(() => { try { loadTemplatesForModal(); } catch(e){} }, 50);
}
function closeAddModal() { hideModal('addModal'); }

function renderGameGrid() {
  const grid = document.getElementById('gameGrid'); if (!grid) return;
  grid.innerHTML = GAMES.map((g, i) => `
    <div class="game-option ${g.name===selectedGame.name?'selected':''}" onclick="pickGame(${i})">
      <div class="game-img-wrap">
        ${g.icon ? `<img src="${g.icon}" alt="${g.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : `<span style="display:flex; align-items:center; justify-content:center; height:100%; font-size:32px">${g.fallback||'🎮'}</span>`}
        <span class="game-fallback" style="display:none">${g.fallback}</span>
      </div>
      <span class="name">${g.name}</span>
    </div>`).join('');
}
function pickGame(i) {
  selectedGame = GAMES[i]; renderGameGrid();
  const portInput = document.getElementById('newSrvPort');
  if(portInput) portInput.value = selectedGame.port;
  updateInstallInfo(); updateInstallBtn(); updateMcVisibility();
}
function updateInstallBtn() {
  const btn = document.getElementById('btnInstall'); if(!btn) return;
  btn.textContent = addModalMode === 'import' ? '📂 Import Server' : '⬇ Install Server';
  btn.style.borderColor=''; btn.style.color=''; btn.style.background='';
}
function updateMcVisibility() {
  const mc = document.getElementById('mcOptions'); if(!mc) return;
  mc.style.display = selectedGame.name === 'Minecraft' ? '' : 'none';
}
function pickMcType(type) {
  selectedMcType = type;
  document.querySelectorAll('.mc-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type===type));
  updateInstallInfo();
}
function updateInstallInfo() {
  const g = selectedGame;
  const steamGames = ['CS2','Valheim','Rust','Satisfactory','Project Zomboid','Ark: Survival','V Rising','Terraria','7 Days to Die','Palworld','Enshrouded'];
  const isSteam = steamGames.includes(g.name);
  const existing = servers.filter(s => s.game === g.name);
  const countNote = existing.length > 0 ? ` You already have ${existing.length} ${g.name} server${existing.length>1?'s':''} — this will create a new one.` : '';  const el = document.getElementById('installInfoText'); if(!el) return;
  el.textContent = (isSteam
    ? `Omnex will download SteamCMD and install the ${g.name} dedicated server. No Steam account required.`
    : `Omnex will download the latest ${g.name} server JAR and configure it automatically.`) + countNote;
  document.getElementById('installInfo').style.borderColor='';
  document.getElementById('installInfo').style.background='';
}
function addModalAction() { addModalMode === 'install' ? installServer() : doImportServer(); }
async function installServer() {
  const nameInput = document.getElementById('newSrvName');
  const portInput = document.getElementById('newSrvPort');
  if (!nameInput || !portInput) return;
  const name = nameInput.value.trim() || `${selectedGame.name} Server`;
  const port = portInput.value.trim() || selectedGame.port;
  const btn  = document.getElementById('btnInstall'); if(btn) { btn.disabled=true; btn.textContent='Installing...'; }  // Note: If Steam Guard times out, the user needs to approve in their Steam Mobile app
  // within 30 seconds of the install starting
  let mcVersion = 'latest';
  if (selectedGame.name === 'Minecraft') {
    try {
      const verEl = document.getElementById('mcVersionSelect');
      if (verEl) mcVersion = verEl.value || 'latest';
    } catch(e) {}
  }
  // Close modal immediately - install runs in background
  closeAddModal();
  showToast('⬇️', `Installing ${name}... watch the console`);
  try {
    const result = await window.nexus.installServer({ name, port, game: selectedGame.name, icon: selectedGame.icon, fallback: selectedGame.fallback, mcType: selectedMcType, mcVersion });
    if (!result.ok) showToast('❌', result.error||'Install failed');
  } catch(err) { showToast('❌', err.message); }
  if(btn){btn.disabled=false; btn.textContent='⬇ Install Server';}
}

// ── Import Server ─────────────────────────────────────────────────────────────
function switchAddTab(mode) {
  addModalMode = mode;
  const ip = document.getElementById('installPanel'), ep = document.getElementById('importPanel');
  if(ip) ip.style.display = mode==='install'?'':'none';
  if(ep) ep.style.display = mode==='import'?'':'none';
  const ti = document.getElementById('tabInstall'), te = document.getElementById('tabImport');
  if(ti) ti.classList.toggle('active', mode==='install');
  if(te) te.classList.toggle('active', mode==='import');
  updateInstallBtn();
  if(mode==='import') renderImportGameGrid();
}
function renderImportGameGrid() {
  const grid = document.getElementById('importGameGridInner'); if(!grid) return;
  grid.innerHTML = GAMES.map((g,i) => `
    <div class="game-option ${g.name===importGameSel.name?'selected':''}" onclick="pickImportGame(${i})">
      <div class="game-img-wrap">${g.icon ? `<img src="${g.icon}" alt="${g.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : `<span style="display:flex; align-items:center; justify-content:center; height:100%; font-size:32px">${g.fallback||'🎮'}</span>`}
        <span class="game-fallback" style="display:none">${g.fallback}</span></div>
      <span class="name">${g.name}</span>
    </div>`).join('');
}
function pickImportGame(i) {
  importGameSel = GAMES[i];
  const p = document.getElementById('importPort'); if(p) p.value = importGameSel.port;
  renderImportGameGrid();
}
async function browseImportFolder() {
  const folder = await window.nexus.browseFolder(); if(!folder) return;
  const p = document.getElementById('importPath'); if(p) p.value = folder;
  const name = document.getElementById('importName');
  if(name && !name.value) name.value = folder.split(/[\\/]/).pop();
}
async function doImportServer() {
  const importPath = document.getElementById('importPath')?.value.trim();
  const name = document.getElementById('importName')?.value.trim() || `${importGameSel.name} Server`;
  const port = document.getElementById('importPort')?.value.trim() || importGameSel.port;
  if (!importPath) { showToast('⚠️','Select a server folder first'); return; }
  const btn = document.getElementById('btnInstall'); if(btn){btn.disabled=true;btn.textContent='Importing...';}
  closeAddModal();
  const result = await window.nexus.importServer({ name, port, game:importGameSel.name, icon:importGameSel.icon, fallback:importGameSel.fallback, importDir:importPath });
  if(btn){btn.disabled=false;btn.textContent='📂 Import Server';}
  if (result.ok) {
    servers.push({...result.server, status:'offline'});
    renderSidebar(); selectServer(result.server.id);
    showToast('✅', `${name} imported`);
  } else showToast('❌', result.error||'Import failed');
}

// ── Templates ─────────────────────────────────────────────────────────────────
async function loadTemplatesForModal() {
  try {
    const templates = await window.nexus.getTemplates();
    const row  = document.getElementById('templatesRow');
    const list = document.getElementById('templateList');
    if (!row || !list) return;
    if (!templates.length) { row.style.display='none'; return; }
    row.style.display='block';
    list.innerHTML = templates.map(t => `
      <div class="template-item" onclick="applyTemplate('${t.id}')">
        <span class="template-name">${escapeHtml(t.name)}</span>
        <span class="template-meta">${t.game}${t.mcVersion?` ${t.mcVersion}`:''}</span>
        <button class="btn-storage-action btn-warn" style="margin-left:auto" onclick="deleteTemplate(event,'${t.id}')">✕</button>
      </div>`).join('');
  } catch(e) {}
}
async function applyTemplate(id) {
  try {
    const templates = await window.nexus.getTemplates();
    const t = templates.find(t => t.id === id); if(!t) return;
    const gi = GAMES.findIndex(g => g.name === t.game); if(gi>=0) pickGame(gi);
    const n = document.getElementById('newSrvName'); if(n) n.value = t.name;
    const p = document.getElementById('newSrvPort'); if(p) p.value = t.port||'';
    if(t.mcType) selectedMcType = t.mcType;
    showToast('📋', `Template applied: ${t.name}`);
  } catch(e) {}
}
async function deleteTemplate(e, id) {
  e.stopPropagation();
  try { await window.nexus.deleteTemplate(id); loadTemplatesForModal(); showToast('🗑️','Template deleted'); } catch(err){}
}
async function saveAsTemplate() {
  const s = getActive(); if(!s) return; closeMoreMenu();
  const name = prompt('Template name:', `${s.name} Template`); if(!name) return;
  const result = await window.nexus.saveTemplate(s.id, name);
  if(result.ok) showToast('📋',`Template "${name}" saved`);
}

// ── Schedules ─────────────────────────────────────────────────────────────────
function openScheduleModal() {
  const el = document.getElementById('schedAction'); if(el) el.value='restart';
  const ef = document.getElementById('schedFreq'); if(ef) ef.value='Daily';
  const et = document.getElementById('schedTime'); if(et) et.value='03:00';
  onSchedActionChange();
  showModal('schedModal');
}
function closeScheduleModal() { hideModal('schedModal'); }
function onSchedActionChange() {
  const action = document.getElementById('schedAction')?.value;
  const opts = document.getElementById('schedBackupOptions');
  if(opts) opts.style.display = action==='backup' ? 'block' : 'none';
  const warn = document.getElementById('schedWarnOptions');
  if(warn) warn.style.display = (action==='restart'||action==='stop') ? 'block' : 'none';
}
async function saveSchedule() {
  const action     = document.getElementById('schedAction')?.value||'restart';
  const freq       = document.getElementById('schedFreq')?.value||'Daily';
  const time       = document.getElementById('schedTime')?.value||'03:00';
  const backupKeep = parseInt(document.getElementById('schedBackupKeep')?.value||'5');
  const warnMinutes = (document.getElementById('schedWarnMinutes')?.value||'')
    .split(',').map(n=>parseInt(n.trim(),10)).filter(n=>Number.isFinite(n)&&n>0);
  const labels     = {restart:'Restart',stop:'Stop',start:'Start',backup:'Backup'};
  const freqLabel  = {Daily:'Daily',Hourly:'Hourly',Weekly:'Weekly','6hours':'Every 6h'};
  schedules = await window.nexus.saveSchedule({
    action, freq, time, backupKeep: action==='backup'?backupKeep:undefined,
    warnMinutes: (action==='restart'||action==='stop') ? warnMinutes : undefined,
    label:`${freqLabel[freq]||freq} ${labels[action]}`, serverId:activeId, active:true,
  });
  renderSchedules(); closeScheduleModal(); showToast('⏰','Scheduled task saved');
}
function renderSchedules() {
  const container = document.getElementById('scheduleList'); if(!container) return;
  const filtered = schedules.filter(s => !s.serverId || s.serverId===activeId);
  if (!filtered.length) { container.innerHTML='<div class="empty-msg-sm">No tasks scheduled.</div>'; return; }
  const icons = {restart:'🔄',stop:'⏹',start:'▶',backup:'💾'};
  container.innerHTML = filtered.map(s => {
    const keepTxt = s.action==='backup'&&s.backupKeep>0 ? ` · keep ${s.backupKeep}` : '';
    const warnTxt = (s.warnMinutes&&s.warnMinutes.length) ? ` · warn ${s.warnMinutes.join('/')}m` : '';
    return `<div class="sched-item">
      <div class="sched-icon ${s.action}">${icons[s.action]||'⏰'}</div>
      <div class="sched-info"><div class="sched-name">${escapeHtml(s.label)}</div><div class="sched-time">${s.freq} · ${s.time}${keepTxt}${warnTxt}</div></div>
      <div style="display:flex;gap:5px;align-items:center">
        <button class="sched-toggle ${s.active?'on':''}" onclick="toggleSchedule('${s.id}')"></button>
        <button class="sched-delete" onclick="deleteSchedule('${s.id}')" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');
}
async function toggleSchedule(id) {
  schedules = await window.nexus.toggleSchedule(id); renderSchedules();
}
async function deleteSchedule(id) {
  schedules = await window.nexus.deleteSchedule(id); renderSchedules(); showToast('🗑️','Schedule removed');
}

// ── Backups ───────────────────────────────────────────────────────────────────
async function renderBackupCard() {
  const body  = document.getElementById('backupCardBody');
  const badge = document.getElementById('backupAutoBadge');
  if (!body) return;
  const s = getActive();
  if (!s) { body.innerHTML='<div class="empty-msg-sm">Select a server.</div>'; return; }
  try {
    const [backups, settings] = await Promise.all([window.nexus.getBackups(s.id), window.nexus.getBackupSettings(s.id)]);
    if(badge) badge.style.display = settings.enabled ? 'inline-flex' : 'none';
    renderBackupCardWithData(s, backups, settings);
  } catch(e) { body.innerHTML='<div class="empty-msg-sm">Could not load backups.</div>'; }
}
function renderBackupCardWithData(s, backups, settings) {
  const body = document.getElementById('backupCardBody'); if(!body||!s) return;
  const badge = document.getElementById('backupAutoBadge');
  if(badge) badge.style.display = settings?.enabled ? 'inline-flex' : 'none';
  let html = `<div class="backup-settings">
    <div class="backup-settings-row">
      <span class="backup-settings-label">Auto Backup</span>
      <button class="cfg-bool-btn ${settings?.enabled?'on':''}" onclick="toggleAutoBackup(this)" data-id="${s.id}">
        <span class="cfg-bool-track"><span class="cfg-bool-thumb"></span></span>
        <span class="cfg-bool-val">${settings?.enabled?'ON':'OFF'}</span>
      </button>
    </div>
    ${settings?.enabled?`<div class="backup-settings-row"><span class="backup-settings-label">Frequency</span>
      <select class="config-input" style="flex:1" onchange="saveBackupFreq(this.value)">
        <option value="hourly" ${settings.interval==='hourly'?'selected':''}>Every Hour</option>
        <option value="6hours" ${settings.interval==='6hours'?'selected':''}>Every 6 Hours</option>
        <option value="daily" ${settings.interval==='daily'?'selected':''}>Daily</option>
      </select></div>`:''}
  </div>`;
  if (!backups.length) { html+='<div class="empty-msg-sm" style="margin-top:8px">No backups yet.</div>'; }
  else {
    html+='<div class="backup-list">';
    for (const b of backups) {
      const date=new Date(b.created).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      html+=`<div class="backup-item">
        <div class="backup-item-info">
          <div class="backup-item-label">${b.trigger!=='manual'?'<span class="backup-tag-auto">AUTO</span>':''} ${escapeHtml(b.label)}</div>
          <div class="backup-item-meta">${date} · ${formatBytes(b.size)}</div>
        </div>
        <div class="backup-item-actions">
          <button class="btn-storage-action" onclick="restoreBackup('${s.id}','${b.id}',this)">↩</button>
          <button class="btn-storage-action btn-warn" onclick="deleteBackup('${s.id}','${b.id}',this)">🗑</button>
        </div>
      </div>`;
    }
    html+='</div>';
  }
  html+=`<button class="add-sched-btn" style="margin-top:8px" onclick="createManualBackup()">+ Manual Backup</button>`;
  body.innerHTML = html;
}
async function createManualBackup() {
  const s = getActive(); if(!s) return;
  showToast('💾','Creating backup...');
  try { await window.nexus.createBackup(s.id,'Manual Backup'); renderBackupCard(); showToast('✅','Backup created'); }
  catch(e) { showToast('❌',e.message); }
}
async function toggleAutoBackup(btn) {
  const id = btn.dataset.id; if(!id) return;
  const settings = await window.nexus.getBackupSettings(id);
  settings.enabled = !settings.enabled;
  await window.nexus.saveBackupSettings(id, settings);
  btn.classList.toggle('on', settings.enabled);
  btn.querySelector('.cfg-bool-val').textContent = settings.enabled?'ON':'OFF';
  const badge = document.getElementById('backupAutoBadge');
  if(badge) badge.style.display = settings.enabled ? 'inline-flex' : 'none';
}
async function saveBackupFreq(val) {
  const s = getActive(); if(!s) return;
  const settings = await window.nexus.getBackupSettings(s.id);
  settings.interval = val; await window.nexus.saveBackupSettings(s.id, settings);
  showToast('💾','Auto backup frequency saved');
}
async function restoreBackup(serverId, backupId, btn) {
  if (!confirm('Restore this backup? Current server files will be replaced.')) return;
  btn.disabled=true; showToast('↩','Restoring backup...');
  try { await window.nexus.restoreBackup(serverId, backupId); showToast('✅','Backup restored'); renderBackupCard(); }
  catch(e) { showToast('❌',e.message); btn.disabled=false; }
}
async function deleteBackup(serverId, backupId, btn) {
  if (!confirm('Delete this backup?')) return;
  btn.disabled=true;
  try { await window.nexus.deleteBackup(serverId, backupId); renderBackupCard(); showToast('🗑️','Backup deleted'); }
  catch(e) { showToast('❌',e.message); btn.disabled=false; }
}
function renderNotesFromBundle(bundle) {
  const ta = document.getElementById('serverNotes'); if(ta) ta.value = bundle.notes||'';
}

// ── Server Notes ──────────────────────────────────────────────────────────────
function renderNotes() {
  const s = getActive(); const ta = document.getElementById('serverNotes'); if(!ta) return;
  ta.value = s?.notes||''; ta.disabled = !s;
}
async function saveNotes() {
  const s = getActive(); if(!s) return;
  try { await window.nexus.saveNotes(s.id, document.getElementById('serverNotes').value); } catch(e){}
}

// ── Players ───────────────────────────────────────────────────────────────────
function renderPlayerList(players) {
  const list  = document.getElementById('playerList');
  const count = document.getElementById('playerCount');
  if (!list) return;
  if (!players) players = [];
  if(count) count.textContent = players.length>0 ? `${players.length} online` : '';
  if (!players.length) { list.innerHTML='<div class="empty-msg-sm" style="padding:12px">No players online</div>'; return; }
  list.innerHTML = players.map(name => `
    <div class="player-item">
      <div class="player-avatar">👤</div>
      <div class="player-name">${escapeHtml(name)}</div>
      <div class="player-actions">
        <button class="btn-player-action" onclick="playerAction('op','${name}')" title="Op">⭐</button>
        <button class="btn-player-action" onclick="playerAction('deop','${name}')" title="Deop">☆</button>
        <button class="btn-player-action btn-kick" onclick="playerAction('kick','${name}')" title="Kick">⚡</button>
        <button class="btn-player-action btn-ban"  onclick="playerAction('ban','${name}')"  title="Ban">🚫</button>
      </div>
    </div>`).join('');
  const statEl = document.getElementById('statPlayers'); if(statEl) statEl.textContent = String(players.length);
}
async function playerAction(action, player) {
  const s = getActive(); if(!s) return;
  if ((action==='ban'||action==='kick') && !confirm(`${action==='ban'?'Ban':'Kick'} ${player}?`)) return;
  const result = await window.nexus.playerAction(s.id, action, player);
  if(result.ok) showToast(action==='ban'?'🚫':action==='kick'?'⚡':'⭐', `${action}: ${player}`);
  else showToast('❌', result.error);
}

// ── Config Card ───────────────────────────────────────────────────────────────
// ── Config Modal (dedicated popup for editing all server settings) ────────────
async function openConfigModal() {
  const s = getActive();
  if (!s) { showToast('⚠️', 'Select a server first'); return; }

  // Set title + subtitle with server context
  const title = document.getElementById('configModalTitle');
  const subtitle = document.getElementById('configModalSubtitle');
  const body = document.getElementById('configModalBody');
  const saveBtn = document.getElementById('configModalSaveBtn');
  if (title) title.textContent = `${s.name} · Settings`;
  if (subtitle) subtitle.textContent = `${s.game} · Port ${s.port} · ${s.installDir || 'Not installed'}`;
  if (body) body.innerHTML = '<div class="empty-msg-sm" style="padding:24px">Loading config...</div>';
  if (saveBtn) saveBtn.style.display = 'none'; // shown once we know the config type

  // Reset any prior search state
  const search = document.getElementById('configModalSearch');
  if (search) search.value = '';
  const clr = document.getElementById('configModalSearchClear');
  if (clr) clr.style.display = 'none';

  showModal('configModal');

  // Render the actual config into the modal body (reusing existing renderers)
  try {
    const result = await window.nexus.readServerConfig(s.id);
    const arHtml = ''; // Skip auto-restart section in modal - lives in main dashboard already
    if (result.ok && result.type === 'minecraft') {
      renderMinecraftConfig(body, result.props, arHtml, 'advanced');
      if (saveBtn) { saveBtn.style.display = ''; saveBtn.onclick = () => saveServerConfig(); }
    } else if (result.ok && result.type === 'steam' && result.defs) {
      renderSteamConfig(body, result, arHtml, s, 'advanced');
      if (saveBtn) { saveBtn.style.display = ''; saveBtn.onclick = () => saveSteamConfig(result.configPath); }
    } else {
      body.innerHTML = `<div class="empty-msg-sm" style="text-align:left;color:var(--text-dim);font-size:12px;line-height:1.7;padding:24px">
        <div style="color:var(--yellow); margin-bottom:12px; font-size:13px">⚠ Config editing not yet supported for ${s.game}</div>
        <div>Edit configuration files directly at:</div>
        <div style="color:var(--accent); font-family:monospace; font-size:11px; word-break:break-all; margin-top:8px; padding:8px; background:rgba(0,229,255,0.05); border-radius:4px">${s.installDir||'Not installed'}</div>
        <button class="btn-modal-save" style="margin-top:14px" onclick="window.nexus.openServerFolder('${s.id}'); closeConfigModal();">📁 Browse local files</button>
      </div>`;
    }
  } catch(e) {
    body.innerHTML = `<div class="empty-msg-sm" style="color:var(--red);padding:24px">Error loading config: ${escapeHtml(e.message)}</div>`;
  }
}
function closeConfigModal() {
  hideModal('configModal');
  // Reset search state so next open is fresh
  const search = document.getElementById('configModalSearch');
  if (search) search.value = '';
  const clr = document.getElementById('configModalSearchClear');
  if (clr) clr.style.display = 'none';
}
function saveConfigModal() {
  // Delegated by openConfigModal (assigned onclick above)
  const btn = document.getElementById('configModalSaveBtn');
  if (btn && btn.onclick && btn.onclick !== saveConfigModal) btn.onclick();
}

// Live-filter the config rows in the modal by user's query
function filterConfigModal(query) {
  const body = document.getElementById('configModalBody');
  const clr = document.getElementById('configModalSearchClear');
  if (!body) return;
  const q = (query || '').trim().toLowerCase();
  if (clr) clr.style.display = q ? '' : 'none';

  const rows = body.querySelectorAll('.config-row');
  const groups = body.querySelectorAll('.config-group');

  if (!q) {
    // Show everything
    rows.forEach(r => { r.style.display = ''; });
    groups.forEach(g => { g.style.display = ''; });
    // Remove any "no results" message
    const noRes = body.querySelector('.config-no-results');
    if (noRes) noRes.remove();
    return;
  }

  let visibleCount = 0;
  // Filter individual rows by their label text and description
  rows.forEach(row => {
    const label = row.querySelector('.config-label');
    const text = (label?.textContent || '').toLowerCase();
    const matches = text.includes(q);
    row.style.display = matches ? '' : 'none';
    if (matches) visibleCount++;
  });

  // Hide entire groups where nothing matches
  groups.forEach(group => {
    const visibleRows = group.querySelectorAll('.config-row:not([style*="display: none"])');
    group.style.display = visibleRows.length > 0 ? '' : 'none';
  });

  // Show / remove "no results" message
  let noRes = body.querySelector('.config-no-results');
  if (visibleCount === 0) {
    if (!noRes) {
      noRes = document.createElement('div');
      noRes.className = 'config-no-results empty-msg-sm';
      noRes.style.cssText = 'padding:24px; text-align:center; color:var(--text-dim); font-size:13px';
      noRes.innerHTML = `No settings match "<span style="color:var(--text)">${escapeHtml(q)}</span>"`;
      body.appendChild(noRes);
    } else {
      noRes.innerHTML = `No settings match "<span style="color:var(--text)">${escapeHtml(q)}</span>"`;
    }
  } else if (noRes) {
    noRes.remove();
  }
}

function clearConfigModalSearch() {
  const search = document.getElementById('configModalSearch');
  if (search) { search.value = ''; search.focus(); }
  filterConfigModal('');
}

async function renderConfigCard() {
  const card = document.getElementById('configCard'); if(!card) return;
  const s = getActive();
  if (!s) { card.innerHTML='<div class="empty-msg-sm">Select a server to configure.</div>'; return; }
  const arHtml = await renderAutoRestartSection();
  try {
    const result = await window.nexus.readServerConfig(s.id);
    if (result.ok && result.type === 'minecraft') {
      renderMinecraftConfig(card, result.props, arHtml, 'basic'); return;
    }
    if (result.ok && result.type === 'steam' && result.defs) {
      renderSteamConfig(card, result, arHtml, s, 'basic'); return;
    }
  } catch(e) {}
  let fallback = `<div class="empty-msg-sm" style="text-align:left;color:var(--text-dim);font-size:11px;line-height:1.6;margin-bottom:10px">
    Config editing not yet supported for ${s.game}.<br>Edit files directly in:<br>
    <span style="color:var(--accent);font-family:monospace;font-size:10px;word-break:break-all">${s.installDir||'Not installed'}</span>
  </div>`;
  if (false) fallback += await renderArma3ModSection(s);
  card.innerHTML = fallback + arHtml;
}

function renderMinecraftConfig(card, props, arHtml, scope) {
  scope = scope || 'full'; // 'basic' for sidebar, 'full' for modal, 'advanced' for modal (non-basic)
  const basicKeys = new Set(['motd','server-port','max-players']);
  const allGroups = [
    { label:'🌍 World', keys:['level-name','level-seed','gamemode','difficulty','max-players','spawn-protection'] },
    { label:'⚙️ Server', keys:['server-port','server-ip','white-list','enable-whitelist','online-mode','motd'] },
    { label:'🔧 Performance', keys:['view-distance','simulation-distance','max-tick-time'] },
  ];
  // Filter groups + keys by scope
  const groups = allGroups.map(g => ({
    label: g.label,
    keys: g.keys.filter(k => scope === 'full' ? true : scope === 'basic' ? basicKeys.has(k) : !basicKeys.has(k))
  })).filter(g => g.keys.length > 0);

  let html = '<div class="config-groups">';
  for (const g of groups) {
    html += `<div class="config-group"><div class="config-group-label">${g.label}</div>`;
    for (const key of g.keys) {
      const val = props[key]??''; const isBool = val==='true'||val==='false';
      html += `<div class="config-row"><div class="config-label">${key}</div>`;
      if (isBool) html += `<button class="cfg-bool-btn ${val==='true'?'on':''}" onclick="toggleMinecraftProp('${key}',this)"><span class="cfg-bool-track"><span class="cfg-bool-thumb"></span></span><span class="cfg-bool-val">${val}</span></button>`;
      else html += `<input class="config-input" value="${escapeHtml(val)}" onchange="updateMcProp('${key}',this.value)">`;
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += arHtml;
  if (scope === 'basic') {
    html += `<button class="btn-save-config" style="margin-top:10px; background:transparent; border:1px solid var(--border); color:var(--text-dim); font-size:11px" onclick="openConfigModal()">⚙️ More Settings...</button>`;
  } else {
    html += `<button class="btn-save-config" style="margin-top:10px" onclick="saveServerConfig()">💾 Save server.properties</button>`;
  }
  card.innerHTML = html;
  window._mcProps = { ...props };
}
let _mcPropsCache = {};
function updateMcProp(key, val) { window._mcProps = window._mcProps||{}; window._mcProps[key]=val; }
function toggleMinecraftProp(key, btn) {
  window._mcProps = window._mcProps||{};
  const cur = window._mcProps[key]==='true'; window._mcProps[key]=String(!cur);
  btn.classList.toggle('on',!cur); btn.querySelector('.cfg-bool-val').textContent=String(!cur);
}
async function saveServerConfig() {
  const s = getActive(); if(!s) return;
  try { const r = await window.nexus.writeServerConfig(s.id, window._mcProps||{}); showToast(r.ok?'💾':'❌',r.ok?'Config saved!':r.error||'Save failed'); }
  catch(e) { showToast('❌',e.message); }
}
function renderSteamConfig(card, result, arHtml, s, scope) {
  scope = scope || 'full'; // 'basic' | 'advanced' | 'full'
  const props = result.props||{}, defs = result.defs;
  let html = '<div class="config-groups">';
  if (result.empty) html += `<div class="empty-msg-sm" style="color:var(--yellow);margin-bottom:8px">⚠ ${result.error}</div>`;
  for (const group of defs.props) {
    // Filter this group's props by scope
    const visibleProps = group.props.filter(def =>
      scope === 'full' ? true : scope === 'basic' ? !!def.basic : !def.basic
    );
    if (visibleProps.length === 0) continue;

    html += `<div class="config-group"><div class="config-group-label">${group.group}</div>`;
    for (const def of visibleProps) {
      const val = props[def.key]??'';
      html += `<div class="config-row"><div class="config-label">${def.label}${def.desc?`<div class="config-desc" style="font-size:10px;color:var(--text-dim);margin-top:2px;font-weight:normal">${def.desc}</div>`:''}</div>`;
      if (def.type==='serverBool') {
        // Read from server object, save directly via setServerField (not baked into game config file)
        const svVal = !!(s && s[def.key]);
        html += `<button class="cfg-bool-btn ${svVal?'on':''}" onclick="toggleServerField('${s.id}','${def.key}',this)">
          <span class="cfg-bool-track"><span class="cfg-bool-thumb"></span></span><span class="cfg-bool-val">${svVal?'ON':'OFF'}</span></button>`;
      } else if (def.type==='bool'||def.type==='bool01') {
        const checked=val==='true'||val==='1', tv=def.type==='bool01'?'1':'true', fv=def.type==='bool01'?'0':'false';
        html += `<button class="cfg-bool-btn ${checked?'on':''}" onclick="toggleSteamBool('${def.key}','${tv}','${fv}',this)">
          <span class="cfg-bool-track"><span class="cfg-bool-thumb"></span></span><span class="cfg-bool-val">${checked?tv:fv}</span></button>`;
      } else if (def.type==='select') {
        html += `<select class="config-input" onchange="updateSteamProp('${def.key}',this.value)">`;
        for (const opt of def.options) html += `<option value="${opt}" ${val===opt?'selected':''}>${opt}</option>`;
        html += '</select>';
      } else {
        html += `<input class="config-input" type="${def.type==='number'?'number':'text'}" value="${escapeHtml(String(val))}" placeholder="${def.placeholder||''}" onchange="updateSteamProp('${def.key}',this.value)">`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += arHtml;
  if (scope === 'basic') {
    html += `<button class="btn-save-config" style="margin-top:10px; background:transparent; border:1px solid var(--border); color:var(--text-dim); font-size:11px" onclick="openConfigModal()">⚙️ More Settings...</button>`;
  } else if (!result.empty) {
    html += `<button class="btn-save-config" style="margin-top:10px" onclick="saveSteamConfig('${result.configPath}')">💾 Save Config</button>`;
  }
  card.innerHTML = html;
  window._steamConfigPath  = result.configPath;
  window._steamConfigProps = { ...props };
}
function updateSteamProp(key, val) { window._steamConfigProps=window._steamConfigProps||{}; window._steamConfigProps[key]=val; }
function toggleSteamBool(key, tv, fv, btn) {
  window._steamConfigProps=window._steamConfigProps||{};
  const cur=window._steamConfigProps[key]; const next=cur===tv?fv:tv;
  window._steamConfigProps[key]=next; btn.classList.toggle('on',next===tv);
  btn.querySelector('.cfg-bool-val').textContent=next;
}
async function toggleServerField(serverId, key, btn) {
  const s = servers.find(sv => sv.id === serverId);
  if (!s) return;
  const newVal = !s[key];
  s[key] = newVal;
  btn.classList.toggle('on', newVal);
  const label = btn.querySelector('.cfg-bool-val');
  if (label) label.textContent = newVal ? 'ON' : 'OFF';
  try {
    await window.nexus.setServerField(serverId, key, newVal);
    showToast(newVal ? '✅' : '⚙️', `${key} ${newVal ? 'enabled' : 'disabled'}. Restart server to apply.`);
  } catch(e) {
    showToast('❌', e.message);
    // Revert on error
    s[key] = !newVal;
    btn.classList.toggle('on', !newVal);
    if (label) label.textContent = !newVal ? 'ON' : 'OFF';
  }
}
async function saveSteamConfig(configPath) {
  const s=getActive(); if(!s||!configPath) return;
  try { const r=await window.nexus.writeSteamConfig(s.id,window._steamConfigProps,configPath); showToast(r.ok?'💾':'❌',r.ok?'Config saved!':r.error||'Save failed'); }
  catch(e){showToast('❌',e.message);}
}
async function renderArma3ModSection(s) {
  try {
    const mods = await window.nexus.getArma3Mods(s.id);
    let html = `<div class="config-group" style="margin-top:12px"><div class="config-group-label">🪖 Workshop Mods</div>`;
    if (!mods.length) html += '<div class="empty-msg-sm" style="margin-bottom:8px">No Workshop mods installed yet.</div>';
    else {
      html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px">';
      for (const mod of mods) {
        html += `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--green);font-size:12px">✓</span>
          <div style="flex:1"><div style="font-family:'Rajdhani',sans-serif;font-weight:600;font-size:11px;color:var(--text-bright)">${escapeHtml(mod.name)}</div>
          <div style="font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--text-dim)">ID: ${mod.id}</div></div>
        </div>`;
      }
      html += '</div>';
    }
    html += `<button class="btn-save-config" onclick="openWorkshopModal()" style="background:rgba(148,103,189,0.08);border-color:rgba(148,103,189,0.5);color:#9467bd">🪖 Manage Workshop Mods</button></div>`;
    return html;
  } catch(e) { return ''; }
}

// ── Auto-restart ──────────────────────────────────────────────────────────────
let autoRestartSettings = {};
async function renderAutoRestartSection() {
  const s = getActive(); if(!s) return '';
  try {
    const ar = await window.nexus.getAutoRestart(s.id);
    autoRestartSettings = ar;
    return `<div class="config-group"><div class="config-group-label">🔁 Auto Restart</div>
      <div class="config-row"><div class="config-label">On Crash</div>
        <button class="cfg-bool-btn ${ar.enabled?'on':''}" onclick="toggleAutoRestart(this)">
          <span class="cfg-bool-track"><span class="cfg-bool-thumb"></span></span>
          <span class="cfg-bool-val">${ar.enabled?'ON':'OFF'}</span>
        </button>
      </div>
      ${ar.enabled?`
      <div class="config-row"><div class="config-label">Max Retries</div>
        <select class="config-input" onchange="saveAutoRestartField('maxRetries',parseInt(this.value))">
          <option value="1" ${ar.maxRetries===1?'selected':''}>1 time</option>
          <option value="3" ${ar.maxRetries===3?'selected':''}>3 times</option>
          <option value="5" ${ar.maxRetries===5?'selected':''}>5 times</option>
          <option value="10" ${ar.maxRetries===10?'selected':''}>10 times</option>
        </select>
      </div>
      <div class="config-row"><div class="config-label">Cooldown</div>
        <select class="config-input" onchange="saveAutoRestartField('cooldown',parseInt(this.value))">
          <option value="5"  ${ar.cooldown===5 ?'selected':''}>5 seconds</option>
          <option value="10" ${ar.cooldown===10?'selected':''}>10 seconds</option>
          <option value="30" ${ar.cooldown===30?'selected':''}>30 seconds</option>
          <option value="60" ${ar.cooldown===60?'selected':''}>1 minute</option>
        </select>
      </div>`:''}
    </div>`;
  } catch(e) { return ''; }
}
async function toggleAutoRestart(btn) {
  const s=getActive(); if(!s) return;
  autoRestartSettings.enabled = !autoRestartSettings.enabled;
  await window.nexus.saveAutoRestart(s.id, autoRestartSettings);
  btn.classList.toggle('on', autoRestartSettings.enabled);
  btn.querySelector('.cfg-bool-val').textContent = autoRestartSettings.enabled?'ON':'OFF';
  showToast(autoRestartSettings.enabled?'🔁':'🔕',`Auto-restart ${autoRestartSettings.enabled?'enabled':'disabled'}`);
  renderConfigCard();
}
async function saveAutoRestartField(field, value) {
  const s=getActive(); if(!s) return;
  autoRestartSettings[field]=value; await window.nexus.saveAutoRestart(s.id, autoRestartSettings);
  showToast('💾','Auto-restart settings saved');
}

// ── Network Card ──────────────────────────────────────────────────────────────
async function addFirewallRule(id) {
  const s = servers.find(sv => sv.id === id);
  if (!s) return;
  const extraPorts = s.game === 'Palworld' ? [27015] : [];
  const portList = [s.port, ...extraPorts];
  if (!confirm(`Open port${portList.length>1?'s':''} ${portList.join(', ')} in Windows Firewall for "${s.name}"?\n\nThis creates inbound rules (TCP + UDP). Windows may prompt for admin access.`)) return;
  showToast('🛡️', 'Adding firewall rules...');
  try {
    const r = await window.nexus.addFirewallRule(id, portList);
    if (r?.ok) {
      showToast('✅', `Firewall opened for port${portList.length>1?'s':''} ${portList.join(', ')}`);
    } else {
      showToast('❌', r?.error || 'Firewall rule failed. Try running Omnex as admin.');
    }
  } catch(e) {
    showToast('❌', e.message);
  }
}

async function renderNetworkCard() {
  const body=document.getElementById('networkCardBody'); if(!body) return;
  const s=getActive();
  if(!s){body.innerHTML='<div class="empty-msg-sm">Select a server.</div>';return;}
  body.innerHTML='<div class="empty-msg-sm">Fetching network info...</div>';
  try {
    const info = await window.nexus.getNetworkInfo(s.port);
    body.innerHTML=`
      <div class="network-row"><div class="network-label">Local IP</div>
        <div class="network-value"><span>${info.localIp}</span>
        <button class="btn-copy" onclick="copyToClipboard('${info.localIp}:${s.port}')" title="Copy">⧉</button></div>
      </div>
      <div class="network-row"><div class="network-label">Public IP</div>
        <div class="network-value"><span>${info.publicIp}</span>
        <button class="btn-copy" onclick="copyToClipboard('${info.publicIp}:${s.port}')" title="Copy">⧉</button></div>
      </div>
      <div class="network-row"><div class="network-label">Port</div><div class="network-value"><span>${s.port}</span></div></div>
      <button class="btn-firewall" onclick="addFirewallRule('${s.id}')" style="width:100%; margin-top:10px; padding:9px 12px; background:rgba(0,229,255,0.06); border:1px solid rgba(0,229,255,0.35); color:var(--accent); border-radius:6px; cursor:pointer; font-family:'Exo 2',sans-serif; font-size:12px; display:flex; align-items:center; justify-content:center; gap:8px; transition:all 0.15s">
        <span>🛡️</span> Open Port ${s.port} in Windows Firewall
      </button>
      <div class="network-hint">Give friends your <b>Public IP</b> for outside connections.<br>Use <b>Local IP</b> for same-network players.<br>The firewall button opens Port ${s.port} (TCP + UDP)${s.game==='Palworld'?' + 27015 for community listing':''}.</div>`;
  } catch(e) { body.innerHTML='<div class="empty-msg-sm">Could not fetch network info.</div>'; }
}

// ── Java check ────────────────────────────────────────────────────────────────
async function checkJavaStatus(id) {
  try {
    const result = await window.nexus.checkJava(id);
    if (!result.ok) appendLog('warn', `Java not found. Omnex will download Java 21 automatically on first start.`);
    else appendLog('dim', `Java: ${result.version||'detected'}`);
  } catch(e) {}
}

// ── Minecraft version picker ──────────────────────────────────────────────────
async function loadMcVersions() {
  const sel = document.getElementById('mcVersionSelect'); if(!sel) return;
  sel.innerHTML='<option value="latest">Loading...</option>';
  try {
    let versions = [];
    if (selectedMcType==='vanilla') versions = await window.nexus.getMinecraftVersions();
    else if (selectedMcType==='paper') versions = await window.nexus.getPaperVersions();
    else if (selectedMcType==='fabric') versions = await window.nexus.getFabricVersions();
    else { sel.innerHTML='<option value="latest">Latest</option>'; return; }
    sel.innerHTML = versions.slice(0,20).map(v=>`<option value="${v}">${v}</option>`).join('');
  } catch(e) { sel.innerHTML='<option value="latest">Latest</option>'; }
}

// ── Log Browser ───────────────────────────────────────────────────────────────
let currentLogServerId = null;
async function openLogsForServer(e, id) {
  if(e) e.stopPropagation();
  currentLogServerId=id;
  const s=servers.find(sv=>sv.id===id);
  const title=document.getElementById('logModalTitle'); if(title) title.textContent=s?escapeHtml(s.name):'Files';
  document.getElementById('logFileContent').innerHTML='<div class="empty-msg-sm">Select a log file to view.</div>';
  const inp=document.getElementById('logSearchInput'); if(inp) inp.value='';
  const files=await window.nexus.getLogFiles(id);
  const list=document.getElementById('logFileList');
  if(!files.length) {
    list.innerHTML=`<div class="empty-msg-sm">No log files found.</div><button class="add-sched-btn" style="margin-top:8px" onclick="window.nexus.openLogFolder('${id}')">📂 Open Folder</button>`;
  } else {
    list.innerHTML=files.map(f=>`
      <div class="log-file-item" onclick="loadLogFile('${f.path.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}',this)">
        <div class="log-file-name">${escapeHtml(f.name)}</div>
        <div class="log-file-meta">${formatBytes(f.size)} · ${new Date(f.modified).toLocaleDateString()}</div>
      </div>`).join('')+`<button class="add-sched-btn" style="margin-top:8px" onclick="window.nexus.openLogFolder('${id}')">📂 Open Folder</button>`;
  }
  showModal('logModal');
}
async function loadLogFile(filePath, el) {
  document.querySelectorAll('.log-file-item').forEach(i=>i.classList.remove('active')); el.classList.add('active');
  const content=document.getElementById('logFileContent');
  content.innerHTML='<div class="empty-msg-sm">Loading...</div>';
  const result=await window.nexus.readLogFile(filePath);
  if(!result.ok){content.innerHTML=`<div class="empty-msg-sm" style="color:var(--red)">${result.error}</div>`;return;}
  const lines=result.content.split('\n');
  content.innerHTML=`<div class="log-viewer-output" id="logViewerOutput">${
    lines.map(l=>`<div class="log-viewer-line ${classifyLogLine(l)}">${escapeHtml(l)}</div>`).join('')
  }</div>`;
  const out=document.getElementById('logViewerOutput'); if(out) out.scrollTop=out.scrollHeight;
}
function classifyLogLine(l){const ll=l.toLowerCase();if(ll.includes('error')||ll.includes('fatal'))return 'lv-error';if(ll.includes('warn'))return 'lv-warn';if(ll.includes('info'))return 'lv-info';return 'lv-normal';}
function filterLogContent(q){document.querySelectorAll('.log-viewer-line').forEach(l=>{l.style.display=q.trim()&&!l.textContent.toLowerCase().includes(q.toLowerCase())?'none':''});}
function closeLogModal(){hideModal('logModal');}

// ── Mod Manager (Minecraft) ───────────────────────────────────────────────────
async function openModManager(){
  const s=getActive(); if(!s) return;
  if(!['paper','fabric','forge'].includes(s.mcType)){showToast('ℹ️','Mod manager is for Paper, Fabric, and Forge');return;}
  const title=document.getElementById('modModalTitle'); if(title) title.textContent=`${s.mcType} · ${s.mcVersion||''}`;
  showModal('modModal');
  renderInstalledMods();
}
function closeModModal(){hideModal('modModal');}
async function renderInstalledMods(){
  const s=getActive(); if(!s) return;
  const list=document.getElementById('installedModList'); if(!list) return;
  try {
    const mods=await window.nexus.getInstalledMods(s.id);
    if(!mods.length){list.innerHTML='<div class="empty-msg-sm">No mods installed yet.</div>';return;}
    list.innerHTML=mods.map(m=>`<div class="mod-installed-item">
      <div class="mod-installed-name">${escapeHtml(m.name)}</div>
      <div class="mod-installed-size">${formatBytes(m.size)}</div>
      <button class="btn-storage-action btn-warn" onclick="deleteMod('${m.path.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">🗑</button>
    </div>`).join('');
  } catch(e){list.innerHTML='<div class="empty-msg-sm">Could not load mods.</div>';}
}
async function searchMods(){
  const s=getActive(); const q=document.getElementById('modSearchQuery')?.value.trim(); if(!q||!s) return;
  document.getElementById('modSearchResults').innerHTML='<div class="empty-msg-sm">Searching Modrinth...</div>';
  try {
    const result=await window.nexus.searchModrinth({query:q,loader:s.mcType,gameVersion:s.mcVersion});
    if(!result.hits?.length){document.getElementById('modSearchResults').innerHTML='<div class="empty-msg-sm">No results found.</div>';return;}
    document.getElementById('modSearchResults').innerHTML=result.hits.map(mod=>`
      <div class="mod-result-item">
        <div class="mod-result-icon">${mod.icon_url?`<img src="${mod.icon_url}" alt="">`:'📦'}</div>
        <div class="mod-result-info">
          <div class="mod-result-name">${escapeHtml(mod.title)}</div>
          <div class="mod-result-desc">${escapeHtml(mod.description?.slice(0,80)||'')}...</div>
          <div class="mod-result-meta">${mod.downloads?.toLocaleString()} downloads</div>
        </div>
        <button class="btn-storage-action" onclick="installModFromSearch('${mod.project_id}','${escapeHtml(mod.title)}')">⬇</button>
      </div>`).join('');
  } catch(e){document.getElementById('modSearchResults').innerHTML='<div class="empty-msg-sm">Search failed.</div>';}
}
async function installModFromSearch(projectId,title){
  const s=getActive(); if(!s) return;
  const result=await window.nexus.getModrinthVersions({projectId,gameVersion:s.mcVersion,loader:s.mcType});
  if(!result.versions?.length){showToast('❌',`No compatible version for ${s.mcType} ${s.mcVersion}`);return;}
  const file=result.versions[0].files?.find(f=>f.primary)||result.versions[0].files?.[0];
  if(!file){showToast('❌','No download file found');return;}
  showToast('⬇️',`Installing ${title}...`);
  const r=await window.nexus.installMod({serverId:s.id,downloadUrl:file.url,filename:file.filename});
  if(r.ok){showToast('✅',`${title} installed!`);renderInstalledMods();}else showToast('❌',r.error);
}
async function deleteMod(modPath){
  const s=getActive(); if(!s||!confirm('Delete this mod?')) return;
  await window.nexus.deleteMod(s.id,modPath); showToast('🗑️','Mod deleted'); renderInstalledMods();
}

// ── Workshop Modal (Arma 3) ───────────────────────────────────────────────────
async function openWorkshopModal(){
  const s=getActive();
  const armaServer=s?.game==='Arma 3'?s:servers.find(sv=>sv.game==='Arma 3');
  if(!armaServer){showToast('⚠️','Select an Arma 3 server first');return;}
  workshopServerId=armaServer.id;
  if(activeId!==armaServer.id) selectServer(armaServer.id);
  try {
    const creds=await window.nexus.getSteamCreds();
    const u=document.getElementById('steamUsername'); if(u&&creds.username) u.value=creds.username;
  } catch(e){}
  try {
    const mods=await window.nexus.getAntistasiMods();
    workshopSelectedMods=mods.filter(m=>m.required).map(m=>({...m}));
    renderAntistasiModList(mods);
  } catch(e){}
  renderInstalledWorkshopMods(armaServer);
  showModal('workshopModal');
}
function closeWorkshopModal(){hideModal('workshopModal');}
function renderAntistasiModList(mods){
  const list=document.getElementById('antistasiModList'); if(!list) return;
  list.innerHTML=mods.map(mod=>{
    const isSel=workshopSelectedMods.some(m=>m.id===mod.id);
    return `<div class="workshop-mod-item">
      <button class="workshop-mod-check ${isSel?'on':''}" onclick="toggleWorkshopMod('${mod.id}','${mod.name}',${mod.required},this)">${isSel?'✓':''}</button>
      <div class="workshop-mod-info">
        <div class="workshop-mod-name">${mod.name} ${mod.required?'<span class="workshop-mod-tag">Required</span>':''}</div>
        <div class="workshop-mod-id">ID: ${mod.id}</div>
      </div>
    </div>`;
  }).join('');
}
function toggleWorkshopMod(id,name,required,btn){
  const idx=workshopSelectedMods.findIndex(m=>m.id===id);
  if(idx>=0){if(required){showToast('⚠️',`${name} is required`);return;}workshopSelectedMods.splice(idx,1);btn.classList.remove('on');btn.textContent='';}
  else{workshopSelectedMods.push({id,name,required});btn.classList.add('on');btn.textContent='✓';}
  updateLaunchLine();
}
function selectAllRequiredMods(){
  const list=document.getElementById('antistasiModList'); if(!list) return;
  list.querySelectorAll('.workshop-mod-item').forEach(item=>{
    const btn=item.querySelector('.workshop-mod-check');
    const id=item.querySelector('.workshop-mod-id')?.textContent.replace('ID: ','').trim();
    const name=item.querySelector('.workshop-mod-name')?.textContent.replace('Required','').trim();
    if(id&&!workshopSelectedMods.some(m=>m.id===id)){workshopSelectedMods.push({id,name,required:false});if(btn){btn.classList.add('on');btn.textContent='✓';}}
  });
  updateLaunchLine();
}
function addCustomMod(){
  const id=document.getElementById('customModId')?.value.trim();
  const name=document.getElementById('customModName')?.value.trim()||`Mod_${id}`;
  if(!id){showToast('⚠️','Enter a Workshop mod ID');return;}
  if(workshopSelectedMods.some(m=>m.id===id)){showToast('⚠️','Mod already in list');return;}
  workshopSelectedMods.push({id,name,required:false});
  const list=document.getElementById('antistasiModList');
  if(list) list.innerHTML+=`<div class="workshop-mod-item"><button class="workshop-mod-check on" onclick="toggleWorkshopMod('${id}','${name}',false,this)">✓</button>
    <div class="workshop-mod-info"><div class="workshop-mod-name">${escapeHtml(name)} <span class="workshop-mod-tag" style="background:rgba(0,229,255,0.1);color:var(--accent)">Custom</span></div>
    <div class="workshop-mod-id">ID: ${id}</div></div></div>`;
  document.getElementById('customModId').value=''; document.getElementById('customModName').value='';
  updateLaunchLine(); showToast('✅',`Added: ${name}`);
}
function updateLaunchLine(){
  const line=document.getElementById('workshopLaunchLine'); if(!line) return;
  if(!workshopSelectedMods.length){line.textContent='No mods selected';return;}
  line.textContent=`-mod=${workshopSelectedMods.map(m=>`@${m.name.replace(/[^a-zA-Z0-9_]/g,'_')}`).join(';')}`;
}
async function renderInstalledWorkshopMods(s){
  const list=document.getElementById('installedWorkshopMods'); if(!list) return;
  try {
    const mods=await window.nexus.getArma3Mods(s.id);
    const cnt=document.getElementById('installedModCount'); if(cnt) cnt.textContent=mods.length?`${mods.length} installed`:'';
    if(!mods.length){list.innerHTML='<div class="empty-msg-sm">No Workshop mods installed yet.</div>';return;}
    list.innerHTML=mods.map(m=>`<div class="workshop-mod-item"><span style="color:var(--green);font-size:14px">✓</span>
      <div class="workshop-mod-info"><div class="workshop-mod-name">${escapeHtml(m.name)}</div><div class="workshop-mod-id">ID: ${m.id}</div></div>
    </div>`).join('');
  } catch(e){list.innerHTML='<div class="empty-msg-sm">Could not load mods.</div>';}
}

// ── Import Arma 3 Launcher HTML preset (FASTER-style feature) ────────────────
function importArma3Preset() {
  const input = document.getElementById('presetFileInput');
  if (!input) return;
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const html = ev.target.result;
      try {
        const result = await window.nexus.parseArma3Preset(html);
        if (result.ok && result.mods.length > 0) {
          // Add all mods to the custom mod list
          for (const mod of result.mods) {
            if (!workshopCustomMods.find(m => m.id === mod.id)) {
              workshopCustomMods.push(mod);
              workshopSelectedMods.push(mod);
            }
          }
          renderWorkshopMods();
          showToast('✅', `Imported ${result.mods.length} mods from preset!`);
        } else {
          showToast('❌', 'No mods found in preset file');
        }
      } catch(err) {
        showToast('❌', 'Failed to parse preset: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

async function downloadSelectedMods(){
  if(!workshopSelectedMods.length){showToast('⚠️','No mods selected');return;}
  const username=document.getElementById('steamUsername')?.value.trim();
  const password=document.getElementById('steamPassword')?.value.trim();
  if(!username||!password){showToast('⚠️','Enter Steam username and password');return;}
  await window.nexus.saveSteamUsername(username);
  const btn=document.getElementById('btnDownloadMods'); if(btn){btn.disabled=true;btn.textContent='⏳ Downloading...';}
  closeWorkshopModal();
  showToast('⬇️',`Downloading ${workshopSelectedMods.length} mods...`);
  try {
    const result=await window.nexus.installArma3Mods({serverId:workshopServerId,mods:workshopSelectedMods,username,password});
    if(result.ok) showToast('✅',`${result.results.filter(r=>r.ok).length} mods installed`);
    else showToast('❌',result.error||'Download failed');
  } catch(e){showToast('❌',e.message);}
  if(btn){btn.disabled=false;btn.textContent='⬇ Download Selected Mods';}
}

// ── Settings Modal ────────────────────────────────────────────────────────────
function openSettingsModal() {
  showModal('settingsModal');
  try { applySettingsToUI(); } catch(e) {}
  setTimeout(async () => {
    try {
      const v = await window.nexus.getAppVersion();
      const el = document.getElementById('settingsVersion');
      if (el) el.textContent = 'Omnex v' + v;
      const av = document.getElementById('aboutVersion');
      if (av) av.textContent = 'v' + v;
    } catch(e){}
    try { loadSteamConnectionStatus(); } catch(e){}
  }, 50);
}
function closeSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
  document.getElementById('settingsModal').classList.remove('open');
}
function applySettingsToUI() {
  if (!appSettings) return;
  ['notifications','notifyOnCrash','notifyOnStart','notifyOnStop','notifyOnBackup','notifyOnPlayerJoin','discordEnabled','startMinimized','minimizeToTray'].forEach(key => {
    const el=document.getElementById(`set${key[0].toUpperCase()+key.slice(1)}`); if(!el) return;
    const val=appSettings[key]||false; el.classList.toggle('on',val);
    const v=el.querySelector('.cfg-bool-val'); if(v) v.textContent=val?'ON':'OFF';
  });
  const webhookEl=document.getElementById('setDiscordWebhookUrl');
  if(webhookEl) webhookEl.value=appSettings.discordWebhookUrl||'';
  const sels={setMaxConsoleLines:'maxConsoleLines',setConsoleFontSize:'consoleFontSize',setDefaultBackupKeep:'defaultBackupKeep',setAppTextScale:'appTextScale'};
  Object.entries(sels).forEach(([id,key])=>{const el=document.getElementById(id);if(el&&appSettings[key]!==undefined)el.value=String(appSettings[key]);});
  // Apply the app text scale on load
  if (appSettings.appTextScale !== undefined) applyTextScale(appSettings.appTextScale);
}
function applyTextScale(scale) {
  const v = (scale && !isNaN(scale)) ? scale : 1;
  document.documentElement.style.setProperty('--app-text-scale', String(v));
}
async function toggleSetting(key, btn) {
  appSettings[key]=!appSettings[key]; btn.classList.toggle('on',appSettings[key]);
  const v=btn.querySelector('.cfg-bool-val'); if(v) v.textContent=appSettings[key]?'ON':'OFF';
  try { await window.nexus.saveSettings(appSettings); } catch(e){}
}
async function saveSetting(key, value) {
  appSettings[key]=value; try{await window.nexus.saveSettings(appSettings);}catch(e){}
  if(key==='consoleFontSize'){const o=document.getElementById('consoleOutput');if(o)o.style.fontSize=value+'px';}
  if(key==='maxConsoleLines') MAX_CONSOLE_LINES=value;
  showToast('⚙️','Settings saved');
}
async function saveWebhookUrl(value) {
  appSettings.discordWebhookUrl=(value||'').trim();
  try{await window.nexus.saveSettings(appSettings);}catch(e){}
  showToast('💬','Webhook saved');
}
async function testDiscordWebhook(btn) {
  const url=(document.getElementById('setDiscordWebhookUrl')?.value||'').trim();
  const result=document.getElementById('discordTestResult');
  if(!url){ if(result){result.style.display='block';result.style.color='var(--danger, #ED4245)';result.textContent='Enter a webhook URL first.';} return; }
  // Persist before testing so the URL is saved even if the user forgot to blur the field
  await saveWebhookUrl(url);
  const oldText=btn?btn.textContent:''; if(btn){btn.disabled=true;btn.textContent='Sending…';}
  try {
    const r=await window.nexus.testDiscordWebhook(url);
    if(result){
      result.style.display='block';
      result.style.color=r.ok?'var(--success, #57F287)':'var(--danger, #ED4245)';
      result.textContent=r.ok?'✅ Test message sent — check your Discord channel.':`❌ ${r.error||'Failed to send.'}`;
    }
  } catch(e) {
    if(result){result.style.display='block';result.style.color='var(--danger, #ED4245)';result.textContent='❌ '+e.message;}
  } finally { if(btn){btn.disabled=false;btn.textContent=oldText;} }
}

// ── Remote Access ─────────────────────────────────────────────────────────────
let remoteAccessActive = false;
async function toggleRemoteAccess(btn) {
  if (remoteAccessActive) {
    try{await window.nexus.stopRemoteAccess();}catch(e){}
    remoteAccessActive=false; btn.classList.remove('on'); btn.querySelector('.cfg-bool-val').textContent='OFF';
    const info=document.getElementById('remoteAccessInfo'); if(info) info.style.display='none';
    showToast('🌐','Remote access stopped');
  } else {
    try {
      const r=await window.nexus.startRemoteAccess(54321);
      if(r.ok){
        remoteAccessActive=true; btn.classList.add('on'); btn.querySelector('.cfg-bool-val').textContent='ON';
        const info=document.getElementById('remoteAccessInfo'); const url=document.getElementById('remoteAccessUrl');
        if(info) info.style.display='block'; if(url) url.textContent=r.url;
        showToast('🌐',`Remote access on ${r.url}`);
      } else showToast('❌',r.error);
    } catch(e){showToast('❌',e.message);}
  }
}



// ── Steam Guard alert banner ─────────────────────────────────────────────────
let steamGuardAlertTimer = null;
function showSteamGuardAlert() {
  const el = document.getElementById('steamGuardAlert');
  if (!el) return;
  el.style.display = 'block';
  // Auto-hide after 45 seconds
  clearTimeout(steamGuardAlertTimer);
  steamGuardAlertTimer = setTimeout(() => hideSteamGuardAlert(), 45000);
}
function hideSteamGuardAlert() {
  const el = document.getElementById('steamGuardAlert');
  if (el) el.style.display = 'none';
  clearTimeout(steamGuardAlertTimer);
}

// ── Steam QR Code ─────────────────────────────────────────────────────────────
function showSteamQrCode(url) {
  const container = document.getElementById('steamQrContainer');
  if (!container) return;

  // Use a public QR code image API - no library needed
  const encodedUrl = encodeURIComponent(url);
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodedUrl}&margin=8`;

  container.innerHTML = `<img src="${qrImageUrl}" alt="Steam QR Code" style="width:240px; height:240px; display:block" onerror="this.parentElement.innerHTML='<div style=\'padding:16px; background:#fff; color:#000; font-family:monospace; font-size:10px; word-break:break-all\'>${url}</div>'">`;

  showModal('steamQrModal');
  showToast('📱', 'Scan the QR code with Steam Mobile app!');
}

// ── Steam Connection ──────────────────────────────────────────────────────────
async function loadSteamConnectionStatus(){
  try {
    const creds=await window.nexus.getSteamCreds();
    const status=document.getElementById('steamConnectionStatus');
    const actions=document.getElementById('steamConnectionActions');
    const card=document.getElementById('steamConnectionCard');
    if(!status) return;
    if(creds.saved&&creds.username&&creds.password){
      status.textContent=`Connected as ${creds.username}`; status.style.color='var(--green)';
      if(card) card.style.borderColor='rgba(57,255,110,0.25)';
      if(actions) actions.innerHTML=`<span style="font-size:10px;color:var(--green);font-family:'Share Tech Mono',monospace">✔ CONNECTED</span>
        <button class="btn-connection-disconnect" onclick="disconnectSteam()">Disconnect</button>`;
    } else {
      status.textContent='Not connected'; status.style.color='var(--text-dim)';
      if(card) card.style.borderColor='';
      if(actions) actions.innerHTML=`<button class="btn-connection-connect" onclick="openSteamConnect()">Connect</button>`;
    }
  } catch(e){}
}
function openSteamConnect(){
  const f=document.getElementById('steamConnectForm'); if(f) f.style.display='block';
  window.nexus.getSteamCreds().then(c=>{const u=document.getElementById('settingsSteamUser');if(u&&c.username)u.value=c.username;}).catch(()=>{});
  setTimeout(()=>{document.getElementById('settingsSteamUser')?.focus();},100);
}
let pendingSteamLogin = null; // username with active login session waiting for code

function closeSteamConnect(){
  // Cancel any pending login session
  if (pendingSteamLogin) {
    try { window.nexus.steamCancelLogin(pendingSteamLogin); } catch(e){}
    pendingSteamLogin = null;
  }
  const f=document.getElementById('steamConnectForm'); if(f) f.style.display='none';
  const p=document.getElementById('settingsSteamPass'); if(p) p.value='';
}

async function saveSteamConnection(){
  const u = document.getElementById('settingsSteamUser')?.value.trim();
  const p = document.getElementById('settingsSteamPass')?.value.trim();
  const g = (document.getElementById('settingsSteamGuard')?.value.trim()||'').toUpperCase();
  if(!u||!p){showToast('⚠️','Enter both username and password');return;}

  const buttons = document.querySelectorAll('#steamConnectForm button');
  buttons.forEach(b => b.disabled = true);
  const status = document.getElementById('steamConnectionStatus');
  if (status) { status.textContent = 'Authenticating SteamCMD...'; status.style.color = 'var(--accent)'; }

  // Use SteamCMD directly - one auth, one cache, no double-prompting
  showToast('🔐', g ? 'Authenticating SteamCMD...' : 'Connecting to SteamCMD (email code will be sent if needed)');

  try {
    const result = await window.nexus.steamcmdAuth(u, p, g);

    if (result.ok) {
      await window.nexus.saveSteamCredsAll(u, p, '');
      closeSteamConnect();
      loadSteamConnectionStatus();
      showToast('✅', `Steam connected! Future installs won\'t need codes.`);
    } else if (result.needsCode) {
      // Email was sent - keep form open, wait for user to enter code
      buttons.forEach(b => b.disabled = false);
      if (status) { status.textContent = 'Check your email for Steam code'; status.style.color = 'var(--yellow)'; }
      showToast('📧', 'Check your email and enter the 5-character code here, click Save again');
      const guardField = document.getElementById('settingsSteamGuard');
      if (guardField) { guardField.focus(); }
    } else {
      buttons.forEach(b => b.disabled = false);
      loadSteamConnectionStatus();
      showToast('❌', result.error || 'Login failed');
    }
  } catch(e) {
    buttons.forEach(b => b.disabled = false);
    showToast('❌', 'Connection failed: ' + e.message);
  }
}

async function steamPreAuth() {
  const u = document.getElementById('settingsSteamUser')?.value.trim();
  const p = document.getElementById('settingsSteamPass')?.value.trim();
  if (!u) { showToast('⚠️', 'Enter your Steam username first'); return; }
  showToast('🔑', 'Opening SteamCMD — approve Steam Guard in your mobile app!');
  try {
    await window.nexus.steamPreauth(u, p || '');
  } catch(e) { showToast('❌', e.message); }
}

async function disconnectSteam(){
  if(!confirm('Disconnect Steam account?')) return;
  try{await window.nexus.saveSteamPassword('');await window.nexus.saveSteamUsername('');}catch(e){}
  loadSteamConnectionStatus(); showToast('🔌','Steam disconnected');
}

// ── Storage Manager ───────────────────────────────────────────────────────────
async function openStorageModal(){
  showModal('storageModal'); await refreshStorage();
}
function closeStorageModal(){hideModal('storageModal');}
async function refreshStorage(){
  try {
    const info=await window.nexus.getStorageInfo();
    const el=document.getElementById('storageInfo'); if(!el) return;
    el.innerHTML=`<div class="storage-row"><span>SteamCMD</span><span>${formatBytes(info.steamCmd||0)}</span></div>
      <div class="storage-row"><span>Java downloads</span><span>${formatBytes(info.java||0)}</span></div>
      <div class="storage-row"><span>Servers</span><span>${formatBytes(info.servers||0)}</span></div>
      <div class="storage-row"><span>Backups</span><span>${formatBytes(info.backups||0)}</span></div>`;
  } catch(e){}
}

// ── Update banner ─────────────────────────────────────────────────────────────
// mode: 'manual' → button opens the GitHub releases page.
// mode: 'auto'   → electron-updater downloads + installs in-app.
// state: 'available' | 'downloading' | 'downloaded'
let updateFlow = { mode:'manual', state:'available', url:null, version:'', percent:0 };

// Called by the main process's GitHub-API fallback (manual download path).
function showUpdateBanner(version, url){
  updateFlow = { mode:'manual', state:'available', url:url||null, version:version||'', percent:0 };
  renderUpdateBanner();
}
function renderUpdateBanner(){
  const b   = document.getElementById('updateBanner');
  const txt = document.getElementById('updateBannerText');
  const btn = document.getElementById('updateActionBtn');
  if (!b) return;
  const vLabel = updateFlow.version ? `v${updateFlow.version}` : 'A new version';
  if (updateFlow.state === 'downloading'){
    if (txt) txt.innerHTML = `⬇️ Downloading ${escapeHtml(vLabel)}… <b>${updateFlow.percent||0}%</b>`;
    if (btn) btn.style.display = 'none';
  } else if (updateFlow.state === 'downloaded'){
    if (txt) txt.innerHTML = `✅ ${escapeHtml(vLabel)} downloaded — restart to finish installing.`;
    if (btn){ btn.style.display=''; btn.disabled=false; btn.textContent='Restart & Install'; }
  } else { // available
    if (txt) txt.innerHTML = `🎉 Omnex <b>${escapeHtml(updateFlow.version||'')}</b> is available!`;
    if (btn){ btn.style.display=''; btn.disabled=false; btn.textContent = updateFlow.mode==='auto' ? 'Download & Install' : 'Download Update'; }
  }
  b.style.display = 'flex';
}
function dismissUpdateBanner(){
  const b = document.getElementById('updateBanner'); if (b) b.style.display='none';
}
function runningServerCount(){
  try { return servers.filter(s => s.status === 'online').length; } catch(e){ return 0; }
}
async function onUpdateAction(){
  // Manual mode: hand off to the browser.
  if (updateFlow.mode === 'manual'){
    window.nexus.openExternal(updateFlow.url || 'https://github.com/KOBRA1325/Omnex/releases/latest');
    dismissUpdateBanner();
    return;
  }
  // Auto mode, ready to install.
  if (updateFlow.state === 'downloaded'){
    const n = runningServerCount();
    if (n > 0 && !confirm(`Installing will stop ${n} running server${n>1?'s':''} and restart Omnex. Continue?`)) return;
    await window.nexus.updaterInstall();
    return;
  }
  // Auto mode, start the download.
  const btn = document.getElementById('updateActionBtn');
  if (btn){ btn.disabled = true; btn.textContent = 'Starting…'; }
  const r = await window.nexus.updaterDownload();
  if (!r || r.ok === false){
    showToast('❌', (r && r.error) || 'Download failed — opening GitHub instead.');
    updateFlow.mode = 'manual';
    renderUpdateBanner();
  }
}
// Event-driven updates from electron-updater in the main process.
function handleUpdateStatus(d){
  if (!d) return;
  switch(d.status){
    case 'available':
      updateFlow = { mode:'auto', state:'available', url:null, version:d.version||'', percent:0 };
      renderUpdateBanner();
      break;
    case 'downloading':
      updateFlow.mode = 'auto'; updateFlow.state = 'downloading'; updateFlow.percent = d.percent||0;
      renderUpdateBanner();
      break;
    case 'downloaded':
      updateFlow.mode = 'auto'; updateFlow.state = 'downloaded'; if (d.version) updateFlow.version = d.version;
      renderUpdateBanner();
      showToast('✅', `Update ${updateFlow.version?('v'+updateFlow.version):''} ready to install`);
      break;
    case 'none':
      if (__manualUpdateCheck){ showToast('✅', `You are on the latest version (v${appVersionStr||d.version||''})`); }
      break;
    case 'error':
      // Auto path failed (e.g. no latest.yml / private release) — fall back to GitHub.
      if (__manualUpdateCheck){ showToast('⚠️', 'Auto-update unavailable — checking GitHub…'); }
      window.nexus.checkForUpdates().then(r => {
        if (r?.updateAvailable) showUpdateBanner(r.latest, r.url);
        else if (__manualUpdateCheck && r?.ok) showToast('✅', `You are on the latest version (v${r.current})`);
      }).catch(()=>{});
      break;
  }
  __manualUpdateCheck = false;
}

// ── Init ──────────────────────────────────────────────────────────────────────
function startClock(){
  function tick(){const el=document.getElementById('clock');if(el)el.textContent=new Date().toLocaleTimeString('en-US',{hour12:false});}
  tick(); setInterval(tick,1000);
}
async function init(){
  const saved=localStorage.getItem('omnexTheme')||'dark';
  applyTheme(saved);
  const tb=document.getElementById('themeToggleBtn'); if(tb) tb.textContent=saved==='dark'?'🌙':'☀️';
  document.querySelectorAll('.modal-overlay').forEach(m=>{m.style.display='none';m.classList.remove('open');});
  try{appSettings=await window.nexus.getSettings();}catch(e){appSettings={};}
  applySettingsToUI();
  if(appSettings.consoleFontSize){const o=document.getElementById('consoleOutput');if(o)o.style.fontSize=appSettings.consoleFontSize+'px';}
  if(appSettings.maxConsoleLines) MAX_CONSOLE_LINES=appSettings.maxConsoleLines;
  try{appVersionStr=await window.nexus.getAppVersion();}catch(e){}
  servers=await window.nexus.getServers();
  schedules=await window.nexus.getSchedules();
  servers=servers.map(s=>({...s,status:['installing','updating','starting'].includes(s.status)?'offline':s.status}));
  wireEvents();
  startClock();
  showView('dashboard');
  if(servers.length>0) selectServer(servers[0].id);
  await checkFirstRun();
  moveModalsToBody();
  wireTitlebarButtons();
  appendLog('dim','Omnex ready. Select or add a server to begin.');
}
function wireEvents(){
  ['console-line','server-stopped','server-added','server-status','install-complete','install-error','backup-created','console-progress','server-crashed','players-updated','settings-changed','app-update','update-status'].forEach(ch=>{try{window.nexus.removeAllListeners(ch);}catch(e){}});
  window.nexus.onConsoleLine(({serverId,type,text,ts})=>{if(serverId===activeId) appendLog(type,text,ts);});
  window.nexus.onServerStatus(({serverId,status})=>{const s=servers.find(sv=>sv.id===serverId);if(s)s.status=status;if(serverId===activeId)renderHeader();renderSidebar();if(currentView==='dashboard')renderDashboard();try{window.nexus.trayRebuild();}catch(e){}});
  window.nexus.onServerStopped(({serverId})=>{const s=servers.find(sv=>sv.id===serverId);if(s)s.status='offline';if(serverId===activeId){renderHeader();clearInterval(statsInterval);clearInterval(uptimeInterval);uptimeSec=0;renderStats(null);appendLog('warn','Server stopped.');}renderSidebar();if(currentView==='dashboard')renderDashboard();try{window.nexus.trayRebuild();}catch(e){};});
  window.nexus.onServerAdded(server=>{
    servers.push({...server,status:server.status||'installing'});
    renderSidebar();
    selectServer(server.id);
    if(currentView==='dashboard') renderDashboard();
  });
  window.nexus.onInstallComplete(async ({serverId})=>{
    // Re-fetch full server data so execPath is updated
    const fresh = await window.nexus.getServers();
    const idx = servers.findIndex(sv=>sv.id===serverId);
    const newSrv = fresh.find(sv=>sv.id===serverId);
    if (newSrv && idx >= 0) servers[idx] = { ...newSrv, status: 'offline' };
    if (serverId===activeId) renderHeader();
    renderSidebar();
    if (currentView==='dashboard') renderDashboard();
    showToast('✅','Install complete! Click Start to launch.');
  });
  window.nexus.onInstallError(({serverId,error})=>{const s=servers.find(sv=>sv.id===serverId);if(s)s.status='error';if(serverId===activeId)renderHeader();showToast('❌',error||'Install failed');});
  window.nexus.onConsoleProgress(({serverId,text})=>{if(serverId!==activeId)return;const out=document.getElementById('consoleOutput');if(!out)return;let p=out.querySelector('.progress-line');if(!p){p=document.createElement('div');p.className='log-line progress-line';out.appendChild(p);}p.innerHTML=`<span class="log-ts">${new Date().toLocaleTimeString('en-US',{hour12:false})}</span><span class="log-info">${escapeHtml(text)}</span>`;out.scrollTop=out.scrollHeight;});
  window.nexus.onPlayersUpdated(({serverId,players})=>{const s=servers.find(sv=>sv.id===serverId);if(s)s.players=players;if(serverId===activeId){renderPlayerList(players);const el=document.getElementById('statPlayers');if(el)el.textContent=players.length>0?String(players.length):'0';}});
  window.nexus.onSettingsChanged(settings=>{appSettings=settings;applySettingsToUI();if(settings.consoleFontSize){const o=document.getElementById('consoleOutput');if(o)o.style.fontSize=settings.consoleFontSize+'px';}});
  window.nexus.onServerCrashed(({serverId,code})=>{const s=servers.find(sv=>sv.id===serverId);if(s)s.status='crashed';if(serverId===activeId)renderHeader();showToast('💥',`${s?.name||'Server'} crashed (code ${code})`);if(currentView==='dashboard')renderDashboard();});
  window.nexus.onAppUpdate(({latest, url})=>{ showUpdateBanner(latest, url); });
  window.nexus.onUpdateStatus(d=>handleUpdateStatus(d));
  try {
    window.nexus.onSteamQrCode(({ url }) => {
      showSteamQrCode(url);
    });
  } catch(e) {}

  // Arma 3 uses anonymous login - no auth needed for server install
}

// ── Wire titlebar buttons via JS (avoids webkit-app-region drag interference) ──
function wireTitlebarButtons() {
  const buttons = [
    { id: 'themeToggleBtn', fn: toggleTheme },
    { id: 'btnSettings',    fn: openSettingsModal },
    { id: 'btnStorage',     fn: openStorageModal },
  ];
  buttons.forEach(({ id, fn }) => {
    const el = document.getElementById(id);
    if (!el) {
 return; }
    // Remove any existing listeners by cloning
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    // Wire mousedown (fires before Electron drag detection)
    clone.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);
    // Wire click with capture
    clone.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      fn();
    }, true);
  });
}

// ── Move modals to body root (prevents overflow:hidden clipping) ──────────────
function moveModalsToBody() {
  const modalIds = ['schedModal','addModal','storageModal','logModal','modModal','settingsModal','workshopModal','configModal'];
  modalIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.parentNode !== document.body) document.body.appendChild(el);
    // Ensure all inputs/buttons inside are interactive
    el.querySelectorAll('input, select, textarea, button, label').forEach(field => {
      field.style.webkitAppRegion = 'no-drag';
      field.style.pointerEvents   = 'all';
      if (field.tagName === 'INPUT' || field.tagName === 'SELECT' || field.tagName === 'TEXTAREA') {
        field.style.userSelect = 'text';
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
