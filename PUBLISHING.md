# Publishing Omnex

Step-by-step guide to publish releases of Omnex from your local machine
using GitHub for both source hosting (private) and release distribution.

---

## One-time setup

### 1. Create the GitHub repository

1. Go to https://github.com/new
2. **Owner:** KOBRA1325
3. **Repository name:** `omnex`
4. **Visibility:** ✅ **Private** (source stays closed; releases can still be
   downloaded publicly by anyone with the release URL)
5. Do **NOT** initialize with a README, .gitignore, or license — we already
   have those.
6. Click "Create repository".

### 2. Install Git (if not already installed)

Download from https://git-scm.com/download/win and install with defaults.

Verify in a new Command Prompt:
```
git --version
```

### 3. Push the code from your Omnex folder

Open a Command Prompt in your Omnex folder (Shift + right-click → "Open in
Terminal" or "Open command window here"). Run these commands, one at a time:

```
git init
git branch -M main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/KOBRA1325/omnex.git
git push -u origin main
```

The first push will prompt for GitHub credentials. Use a **Personal Access
Token** as the password (not your GitHub account password — GitHub doesn't
accept those anymore).

**How to make a Personal Access Token:**
1. Go to https://github.com/settings/tokens
2. Click "Generate new token" → "Generate new token (classic)"
3. **Note:** "Omnex CLI"
4. **Expiration:** 90 days (or "No expiration" if you prefer)
5. **Scopes:** check `repo` (all sub-boxes will select automatically)
6. Click "Generate token"
7. **Copy the token immediately** — you won't see it again
8. When git prompts for a password, paste the token

Windows will save the credential for future pushes.

---

## Publishing a release

Every time you want to publish a new version:

### 1. Update the version number

Edit `package.json`:
```json
"version": "1.0.1",
```

### 2. Commit and push the change

```
git add package.json
git commit -m "Release v1.0.1"
git push
```

### 3. Tag the release

```
git tag v1.0.1
git push --tags
```

The `git push --tags` triggers the **GitHub Actions workflow**, which will:
- Spin up a Windows build server on GitHub's cloud
- Run `npm install`
- Build `Omnex Setup 1.0.1.exe` with electron-builder
- Create a GitHub Release named `v1.0.1`
- Upload the installer as an attachment

Watch the progress at: https://github.com/KOBRA1325/omnex/actions

The build takes ~5-8 minutes. When it finishes, the release will appear at:
https://github.com/KOBRA1325/omnex/releases

### 4. Share the download

The installer URL will be:
```
https://github.com/KOBRA1325/omnex/releases/latest/download/Omnex.Setup.1.0.1.exe
```

Or you can just link to the releases page:
```
https://github.com/KOBRA1325/omnex/releases/latest
```

Even though the source repo is private, **release download links work for
anyone with the URL**. You don't need to make the repo public.

---

## Common tasks

### Building locally (no GitHub, no release)

Just to test on your PC:
```
npm run build
```
Output goes to `dist\Omnex Setup 1.0.0.exe`.

### Un-doing a bad release

1. Delete the release on GitHub (Releases page → click release → Delete)
2. Delete the tag locally:  `git tag -d v1.0.1`
3. Delete the tag on GitHub: `git push origin :refs/tags/v1.0.1`
4. Fix your code, commit, re-tag, re-push

### Checking what changed since last release

```
git log --oneline v1.0.0..HEAD
```

---

## Auto-update

Omnex has a built-in "Check for Updates" button in Settings → About.
It queries the GitHub Releases API and, if a newer version exists,
prompts the user to download it.

Users see the SmartScreen "unrecognized publisher" warning on first
install (Omnex isn't code-signed yet). This is normal for unsigned apps.
Add a note on your download page:

> Windows may show a security warning. Click **More info → Run anyway** to
> install. This warning appears because Omnex isn't code-signed yet.

---

## Troubleshooting

### "Permission denied" when pushing
Your Personal Access Token expired or has the wrong scopes. Make a new one
with `repo` scope and try again.

### GitHub Actions build failing
Go to the failed run at https://github.com/KOBRA1325/omnex/actions, click
the failed job, and look at the log. Usually it's an npm install issue or
a Windows-specific quirk. Send me the error and I can help debug.

### "electron-builder can't publish because credentials are missing"
The workflow file uses `secrets.GITHUB_TOKEN` which is provided
automatically by GitHub Actions — nothing for you to configure. If you see
this error locally when running `npm run release`, that's expected — that
command is for CI only. Use `npm run build` locally.
