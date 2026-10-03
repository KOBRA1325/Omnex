# Tests

```bash
npm test                 # every suite
npm test -- neoforge     # only suites whose filename matches
node tests/arma-reforger.test.js   # one suite, while working on it
```

Plain Node, no framework or dependencies. Each suite is a standalone script that
prints its assertions and exits non-zero on failure; `tests/run.js` runs them in
separate processes and prints a summary.

## How they reach the code

`main.js` and `preload.js` require Electron, so they cannot be `require`d from
Node. Instead `tests/helpers/source.js` reads the shipped file and extracts the
function under test by signature:

```js
const { source, grab, makeCheck, report } = require('./helpers/source');
const SRC = source('main.js');
const fn = new Function('return ' + grab(SRC, 'function neoforgePrefixFor('))();
```

The point is that suites exercise the **real shipped source**, so they fail if the
production code changes — not a copy that quietly drifts. The trade-off is that
renaming a function breaks its suite; `grab` throws loudly rather than silently
matching nothing, so that shows up as a failure rather than a false pass.

Two things to know when adding a suite:

- **`grab` skips strings, comments and regex literals** when counting braces. It
  has to: `armaCfgDepth`'s body is literally `if (ch === '{') depth++;`, and
  `patchArmaCfg` contains `replace(/"/g, '')`. Both defeat a naive counter.
- **End with `report(state)`.** It fails a suite that ran *zero* assertions. That
  guard exists because an editing mistake once left three suites gutted but still
  exiting 0, and the runner reported them as passing.

## Suites

| File | Covers |
|---|---|
| `arma3-config.test.js` | The `key = value;` parser and writer (class blocks, `motd[]` and comments must survive a write), the generated seed `server.cfg`, and launch args |
| `arma3-missions.test.js` | Mission discovery from `mpmissions/` and from inside mods, the `class Missions` writer, and the typed-template guard |
| `arma3-modpack.test.js` | The Antistasi pack's Workshop ids, the server/client split, `.bikey` collection, and `-mod=` construction |
| `arma3-keys.test.js` | The signature-key audit's four states, re-sync fixing only the fixable one, and pack mods that never downloaded |
| `steam-auth.test.js` | SteamCMD output classification for both the Settings login and the install path, including the mobile-approval timeout |
| `arma-reforger.test.js` | Nested-JSON config get/set and type coercion, the generated `server.json`, launch args, scenario-id parsing and the write guard |
| `minecraft-neoforge.test.js` | NeoForge ↔ Minecraft version mapping (both the `1.21.1` and `26.3` schemes), version-list derivation, and the mod-search empty state that names the responsible filter |
| `minecraft-loader-detect.test.js` | Detecting vanilla/paper/fabric/quilt/forge/neoforge from an install folder, and that NeoForge is tested before Forge |
| `minecraft-launch-target.test.js` | Choosing the run script over a jar for Forge/NeoForge, not picking the vanilla jar sitting beside it, and repairing an already-broken `execPath` at start |

Most assertions here exist because the thing they check actually broke once. The
comments say which, so a failure tells you what regressed rather than only that
something did.

Tests are not packaged into the installer: `build.files` in `package.json` is an
allowlist and does not include `tests/`.
