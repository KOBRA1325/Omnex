# Omnex Dev Workflow

## Fastest Testing — Run Without Installing

1. Extract the zip anywhere (e.g. Desktop\Omnex)
2. Double-click **DEV.bat** (auto-elevates to admin)
3. First time only: it installs dependencies (~1 min)
4. Omnex runs instantly with DevTools open

After that, every time you run DEV.bat it launches in 2-3 seconds.

## Live Reload

- **Ctrl+R** — Reload the renderer (instant HTML/CSS/JS updates, no restart needed!)
- **F12** — Toggle DevTools
- **Close + DEV.bat again** — Apply main.js or preload.js changes

## Workflow

Old way (slow):
1. Extract zip → 2. Run START.bat → 3. Wait for npm install → 4. Wait for electron-builder → 5. Run installer → 6. Test → 7. Repeat for every change (5+ minutes per cycle)

New way (fast):
1. Extract zip once → 2. Run DEV.bat → 3. Test
4. For renderer changes: replace files in `renderer/` folder → press Ctrl+R in app
5. For main.js changes: replace file → close + DEV.bat (10 seconds)

## Patch Updates (smallest possible downloads)

When only specific files change, I'll send patches as small zips containing just the changed files. Drop them into your Omnex folder, overwrite when prompted, and reload with Ctrl+R or restart.

## File map

- `main.js` — Electron main process (needs restart on change)
- `preload.js` — IPC bridge (needs restart on change)
- `renderer/index.html` — Main UI markup (Ctrl+R)
- `renderer/app.js` — Frontend JS (Ctrl+R)
- `renderer/style.css` — Styling (Ctrl+R)
- `package.json` — Dependencies/build config (needs npm install)

## Building the Installer

Only do this when you want to package up a release:
- Run START.bat — this builds the .exe installer in `dist/`
- Distribute the `dist/Omnex Setup 1.0.0.exe` for end users
