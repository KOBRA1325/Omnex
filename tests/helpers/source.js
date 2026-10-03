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
//
// Braces inside strings and comments are skipped. That is not a nicety:
// armaCfgDepth's body is literally `if (ch === '{') depth++;`, and a naive
// counter walks straight past the real end of the function.
function grab(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error('not found in source: ' + sig);
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error('no block body for: ' + sig);

  let depth = 0;
  let quote = null;        // ' " or ` while inside a string
  let comment = null;      // 'line' or 'block'
  let prev = '';           // last meaningful character, to tell regex from division
  for (; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (comment === 'line') { if (c === '\n') comment = null; continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = null; i++; } continue; }
    if (quote) {
      if (c === '\\') { i++; continue; }           // escaped char
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue; }
    // A regex literal, not division: patterns like replace(/"/g, '') contain
    // quote characters that would otherwise look like the start of a string.
    if (c === '/' && '(,=:[!&|?{};+-*%~^'.includes(prev)) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        const r = src[i];
        if (r === '\\') { i++; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        else if (r === '\n') break;                // not a regex after all
      }
      prev = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
    if (!/\s/.test(c)) prev = c;
  }
  throw new Error('unbalanced braces while reading: ' + sig);
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
