// ── Steam Direct Authentication (like FASTER uses BytexDigital.Steam) ─────────
// This bypasses SteamCMD's broken 2FA flow by talking directly to Steam's auth API
// using the steam-session library (Doctor McKay's library, used in many Steam tools)

const path = require('path');
const fs = require('fs');

let LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType;
try {
  const session = require('steam-session');
  LoginSession            = session.LoginSession;
  EAuthTokenPlatformType  = session.EAuthTokenPlatformType;
  EAuthSessionGuardType   = session.EAuthSessionGuardType;
} catch(e) {
  console.warn('steam-session not installed — falling back to SteamCMD-only mode');
}

const USER_DATA = require('electron').app.getPath('userData');
const STEAM_TOKENS_FILE = path.join(USER_DATA, 'steam_tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(STEAM_TOKENS_FILE)) return JSON.parse(fs.readFileSync(STEAM_TOKENS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(STEAM_TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch(e) {}
}

function hasValidToken(username) {
  if (!username) return false;
  const tokens = loadTokens();
  return !!tokens[username]?.refreshToken;
}

function getRefreshToken(username) {
  return loadTokens()[username]?.refreshToken || null;
}

/**
 * Start a Steam login. Returns an object with status and guidance.
 * Possible outcomes:
 *   - { ok:true, refreshToken } — login complete, token cached
 *   - { ok:false, needsGuard:'DeviceCode' } — needs 5-char mobile code
 *   - { ok:false, needsGuard:'DeviceConfirmation', pending:true } — mobile app approval needed (polling)
 *   - { ok:false, needsGuard:'EmailCode' } — email code needed
 *   - { ok:false, error } — login failed
 *
 * If session is provided, it's a continuation. Otherwise creates a new session.
 */
async function steamLogin({ username, password, guardCode = null, emit = () => {} }) {
  if (!LoginSession) {
    return { ok: false, error: 'steam-session library not installed. Run: npm install' };
  }

  return new Promise((resolve) => {
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    let resolved = false;
    const finish = (result) => { if (!resolved) { resolved = true; resolve(result); } };

    // Authenticated successfully - save the refresh token
    session.on('authenticated', async () => {
      pendingSessions.delete(username);
      const refreshToken = session.refreshToken;
      const tokens = loadTokens();
      tokens[username] = {
        refreshToken,
        accountName: session.accountName,
        steamId: session.steamID?.toString(),
        savedAt: Date.now(),
      };
      saveTokens(tokens);
      emit('Steam authentication successful! Token saved for future use.');
      finish({ ok: true, refreshToken, accountName: session.accountName });
    });

    session.on('timeout', () => {
      emit('Login attempt timed out');
      finish({ ok: false, error: 'Login timed out' });
    });

    session.on('error', (err) => {
      emit(`Login error: ${err.message}`);
      finish({ ok: false, error: err.message });
    });

    // Start the login
    session.startWithCredentials({
      accountName: username,
      password: password,
      steamGuardCode: guardCode || undefined,
    }).then(async (result) => {
      // If action required, check what type of guard
      if (result.actionRequired) {
        const actions = result.validActions || [];
        const hasDeviceCode = actions.some(a => a.type === EAuthSessionGuardType.DeviceCode);
        const hasDeviceConf = actions.some(a => a.type === EAuthSessionGuardType.DeviceConfirmation);
        const hasEmailCode  = actions.some(a => a.type === EAuthSessionGuardType.EmailCode);

        if (hasDeviceConf) {
          // Mobile app approval - polling starts automatically
          emit('📱 Approve the login in your Steam Mobile app...');
          // Keep session alive - it polls automatically
          pendingSessions.set(username, { session, resolve: finish });
          return;
        } else if (hasDeviceCode) {
          // Need 5-character code from mobile app
          if (guardCode) {
            emit('Steam Guard code was rejected. Get a fresh code and try again.');
            finish({ ok: false, error: 'Invalid Steam Guard code', needsGuard: 'DeviceCode' });
          } else {
            emit('Steam Guard code required (5 characters from mobile app)');
            // Keep session alive so user can submit code
            pendingSessions.set(username, { session, resolve: finish });
            finish({ ok: false, needsGuard: 'DeviceCode', pending: true });
          }
          return;
        } else if (hasEmailCode) {
          emit('📧 Steam Guard email code sent - check your inbox');
          // Keep session alive so user can submit code without triggering another email
          pendingSessions.set(username, { session, resolve: finish });
          finish({ ok: false, needsGuard: 'EmailCode', pending: true });
          return;
        }
      }
      // No action required - waiting for 'authenticated' event
    }).catch(err => {
      emit(`Login failed: ${err.message}`);
      finish({ ok: false, error: err.message });
    });
  });
}

/**
 * Get a fresh access token using a saved refresh token (no login prompt!)
 * This is the magic - once we have a refresh token, we never need Steam Guard again.
 */
async function refreshAccessToken(username) {
  if (!LoginSession) return null;
  const refreshToken = getRefreshToken(username);
  if (!refreshToken) return null;

  try {
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    session.refreshToken = refreshToken;
    await session.refreshAccessToken();
    return session.accessToken;
  } catch(err) {
    console.error('Refresh token failed:', err.message);
    return null;
  }
}

/**
 * Clear saved tokens for a user (when they want to disconnect)
 */
function clearTokens(username) {
  const tokens = loadTokens();
  delete tokens[username];
  saveTokens(tokens);
}


// Store pending sessions so we can submit guard codes to them later
const pendingSessions = new Map(); // username -> { session, resolve }

/**
 * Submit a Steam Guard code to a pending login session.
 * This avoids creating a new login session (which would trigger another email).
 */
async function submitGuardCode(username, code, codeType = 'EmailCode') {
  const pending = pendingSessions.get(username);
  if (!pending) {
    return { ok: false, error: 'No pending login session. Click Save & Connect first.' };
  }
  try {
    const guardType = codeType === 'EmailCode'
      ? EAuthSessionGuardType.EmailCode
      : EAuthSessionGuardType.DeviceCode;
    await pending.session.submitSteamGuardCode(code);
    // Success will be reported via the 'authenticated' event handler
    return { ok: true, pending: true };
  } catch(err) {
    return { ok: false, error: err.message };
  }
}

function clearPendingSession(username) {
  const p = pendingSessions.get(username);
  if (p) {
    try { p.session.cancelLoginAttempt(); } catch(e) {}
    pendingSessions.delete(username);
  }
}

module.exports = {
  steamLogin,
  submitGuardCode,
  clearPendingSession,
  hasValidToken,
  getRefreshToken,
  refreshAccessToken,
  clearTokens,
  loadTokens,
};
