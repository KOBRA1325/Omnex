// main.js and preload.js require Electron, so they cannot simply be required
// from plain Node. These tests instead read the shipped source and extract the
// individual functions under test, which means they always exercise the real
// code rather than a copy that can drift.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Read a repo file with line endings normalised. The working tree is CRLF under
// core.autocrlf, while every anchor in these tests is written with LF.
function source(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n');
}

// Pull out a brace-balanced block starting at `sig`, e.g. 'function foo(' or
// "ipcMain.handle('x'". Throws rather than returning a partial match, so a
// renamed function fails the suite loudly instead of silently testing nothing.
function grab(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error('not found in source: ' + sig);
  let depth = 0;
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error('no block body for: ' + sig);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}

// Collects pass/fail so each suite can report a single summary line.
function makeCheck() {
  const state = { failures: 0, total: 0 };
  const check = (label, actual, expected) => {
    state.total++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  pass  ' + label); return true; }
    state.failures++;
    console.log('  FAIL  ' + label);
    console.log('        got:      ' + JSON.stringify(actual));
    console.log('        expected: ' + JSON.stringify(expected));
    return false;
  };
  return { check, state };
}

// Every suite ends with this. A suite that asserts nothing is treated as a
// failure: an editing mistake once left three suites gutted but still exiting 0,
// and the runner happily reported them as passing.
function report(state) {
  if (state.total === 0) {
    console.log('  FAIL  suite ran no assertions');
    process.exit(1);
  }
  console.log(state.failures === 0
    ? `  ALL PASS (${state.total} assertions)`
    : `  ${state.failures} of ${state.total} FAILED`);
  process.exit(state.failures ? 1 : 0);
}

module.exports = { ROOT, source, grab, makeCheck, report };
