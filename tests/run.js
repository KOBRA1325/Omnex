// Runs every tests/*.test.js in its own process and reports a summary.
// Each suite is a standalone Node script that exits non-zero on failure, so an
// individual file can also be run directly while working on it:
//   node tests/arma-reforger.test.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const only = process.argv[2];                 // optional substring filter
let files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();
if (only) files = files.filter(f => f.includes(only));

if (!files.length) {
  console.error(only ? `No test files match "${only}".` : 'No test files found.');
  process.exit(1);
}

let failed = 0;
const results = [];
for (const file of files) {
  console.log('\n── ' + file + ' ' + '─'.repeat(Math.max(0, 58 - file.length)));
  const r = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ file, ok });
}

console.log('\n' + '='.repeat(62));
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.file);
console.log('='.repeat(62));
console.log(failed === 0
  ? `All ${results.length} suites passed.`
  : `${failed} of ${results.length} suites failed.`);
process.exit(failed ? 1 : 0);
