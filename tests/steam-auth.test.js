// Arma 3 is the only game needing a Steam login, so SteamCMD's output has to be
// classified correctly. Both paths here once reported a SUCCESSFUL login as a
// failure, because a broad includes('two-factor') ran before the success check —
// and both told mobile-authenticator users to check an email that never arrives.
const { source, grab, makeCheck, report } = require('./helpers/source');
const { check, state } = makeCheck();

const SRC = source('main.js');

// Both handlers decide everything inside their child process 'close' callback,
// so lift that out and drive it with representative SteamCMD output.
function closeHandler(afterIndex) {
  const cs = SRC.indexOf("    proc.on('close', code => {", afterIndex);
  const end = '\n    });\n';
  const ce = SRC.indexOf(end, cs);
  let body = SRC.slice(cs, ce + end.length)
    .replace("    proc.on('close', code => {", '')
    .replace(/\n {4}\}\);\n$/, '');
  return body;
}

// ── Settings → Connections (steamcmd-auth) ──────────────────────────────────
const authBody = closeHandler(SRC.indexOf("ipcMain.handle('steamcmd-auth'"));
const classifyAuth = new Function('output', 'emit', 'fs', 'scriptPath',
  'return new Promise((resolve) => {' + authBody + '});');
const runAuth = (out) => classifyAuth(out, () => {}, { unlinkSync() {} }, 'x');

(async () => {
  check('a plain success is a success',
    (await runAuth("Logging in user 'x' to Steam Public...OK\nWaiting for user info...OK\n")).ok, true);

  // The regression: output that merely mentions two-factor alongside a real login.
  const mixed = await runAuth(
    "Two-factor code: \nLogging in user 'x' to Steam Public...OK\nLogged in OK\nWaiting for user info...OK\n");
  check('success wins over a two-factor mention', mixed.ok, true);
  check('and it is not reported as needing a code', !!mixed.needsCode, false);

  // Verbatim from a real emailed-Steam-Guard session.
  const email = await runAuth(
    'This computer has not been authenticated for your account using Steam Guard.\n' +
    'Please check your email for the message from Steam, and use\nERROR (Account Logon Denied)\n');
  check('emailed guard needs a code', email.needsCode, true);
  check('emailed guard is not flagged mobile', email.mobile, false);
  check('emailed guard says email', /email/i.test(email.error), true);

  const mobile = await runAuth('Steam Guard Mobile Authenticator\nTwo-factor code: \nFAILED\n');
  check('mobile guard needs a code', mobile.needsCode, true);
  check('mobile guard is flagged mobile', mobile.mobile, true);
  check('mobile guard does NOT say email', /email/i.test(mobile.error), false);
  check('mobile guard names the app', /mobile authenticator/i.test(mobile.error), true);

  const mismatch = await runAuth('Two-factor code mismatch\nFAILED login\n');
  check('a rejected code is reported as rejected', mismatch.expired, true);
  check('and says codes expire', /expire|fresh/i.test(mismatch.error), true);

  check('invalid password classifies', (await runAuth('FAILED login with result code Invalid Password\n')).ok, false);
  check('invalid password is named', /password/i.test((await runAuth('FAILED login with result code Invalid Password\n')).error), true);
  check('rate limit is named', /rate limit/i.test((await runAuth('FAILED login with result code Rate Limit Exceeded\n')).error), true);

  // ── install path (installViaSteamCmdAuth) ─────────────────────────────────
  const installBody = closeHandler(SRC.indexOf('function installViaSteamCmdAuth'));
  const classifyInstall = new Function('code', 'output', 'serverId', 'log', 'emit', 'loadSteamCreds', 'saveSteamCreds',
    'return new Promise((resolve, reject) => {' + installBody + '});');
  const runInstall = (code, out) => classifyInstall(
    code, out, 'srv', () => {}, () => {}, () => ({ username: 'u', password: 'p', steamGuardCode: '' }), () => {}
  ).then(() => ({ ok: true }), e => ({ ok: false, error: e.message }));

  // A mobile-approval prompt only reaches us in the flush at process exit, long
  // after SteamCMD gave up waiting — so it must be named, not left as "exit 5".
  const TIMEOUT_OUTPUT = [
    'Logging in using username/password.',
    "Logging in user 'x' [U:1:1] to Steam Public...Retrying...",
    'This account is protected by a Steam Guard mobile authenticator.',
    'Please confirm the login in the Steam Mobile app on your phone.',
    'Waiting for confirmation...',
    'Wait for confirmation timed out.Timed out waiting for confirmation.',
    'ERROR (Timeout)',
  ].join('\n');
  const timedOut = await runInstall(5, TIMEOUT_OUTPUT);
  check('the confirmation timeout is classified', timedOut.ok, false);
  check('it explains the approval timed out', /confirmation timed out/i.test(timedOut.error), true);
  check('it points at the visible-window login', /Steam window|Connections/i.test(timedOut.error), true);
  check('it is not a bare exit code', /exited \d/.test(timedOut.error), false);
  check('it does not claim an expired typed code', /expired|fresh code/i.test(timedOut.error), false);

  check('exit 0 succeeds', (await runInstall(0, 'Success! App fully installed.\n')).ok, true);
  check('exit 7 succeeds', (await runInstall(7, 'anything\n')).ok, true);
  check('a genuinely mismatched code is named',
    /expired|fresh code/i.test((await runInstall(5, 'Two-factor code mismatch\n')).error), true);
  check('invalid password is named',
    /password/i.test((await runInstall(5, 'FAILED login with result code Invalid Password\n')).error), true);
  check('rate limit is named',
    /rate limit/i.test((await runInstall(5, 'FAILED with result code Rate Limit Exceeded\n')).error), true);
  check('an unclassified failure still rejects',
    /exited 5/.test((await runInstall(5, 'something else went wrong\n')).error), true);

  // The install path also falls back to the saved account rather than demanding
  // credentials the Workshop dialog already has.
  check('install reuses the saved Steam account', SRC.includes('const saved = loadSteamCreds();'), true);

  report(state);
})();
