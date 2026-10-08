# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

**담임의 노트 (Homeroom Teacher's Notes)** — a Korean classroom management PWA for Mac. This directory holds only the **pre-built distribution**, not source code. There is no build step, no package.json, no test suite, no linter. It is a git repository (remote `merona33/classmanager`); pushing `main` deploys `app/` to GitHub Pages via `.github/workflows/pages.yml`.

Besides `app/`, the root contains `firestore.rules` (security rules to paste into the Firebase console), `.github/workflows/pages.yml` (deploys only `app/` to GitHub Pages), `.gitignore` (keeps `*.xlsx`, which may hold real student names, out of git), `사용법.txt` (end-user Korean install/usage guide, including the `.command` launcher flow and troubleshooting) and `7반_명렬표.xlsx` (sample class roster for the Excel upload feature).

## Running the app

```bash
python3 -m http.server 8765 --directory app
```

Then open `http://localhost:8765`. A service worker requires `http://localhost` or HTTPS, so opening `index.html` via `file://` will not work. The end-user launcher `담임의노트_실행.command` (referenced in `사용법.txt`, not present in this directory) does the same thing and auto-increments the port (8766, 8767, …) if 8765 is busy.

## App structure

```
app/
  index.html              # Entry; loads config.js + sync.js (classic scripts), then the module bundle; registers sw.js
  config.js               # Firebase apiKey + projectId (empty = sync disabled, plain localStorage)
  sync.js                 # Optional multi-computer sync: login overlay, pull on start, debounced push, status badge
  sw.js                   # Service worker (cache name `classmanager-v13`)
  manifest.webmanifest    # PWA manifest (lang ko, standalone)
  icon*.png, apple-touch-icon.png
  assets/
    index-<hash>.js       # Single minified React bundle (~690 KB, includes the SheetJS xlsx library)
    index-<hash>.css
```

## Key architectural facts

- **Grades screen** (`성적 관리`, component `FO` in the bundle): per period and subject it stores `{score, std, percentile, grade}` under `grades:<classId>` → `{mock|internal}[studentId][period][subject]`. Input columns and the template are ordered 원점수, 표준점수, 백분위, 등급. The 학생별 요약 view (component `ap`) also renders `CmGrowth`, a hand-written SVG trend chart (per subject plus 평균, switchable between 등급/백분위/표준점수/원점수, grade axis inverted) under each of the mock and internal tables; note the compiled CSS only contains Tailwind classes the original source used, so new UI must use inline styles for any spacing/utility not already in `index-*.css`. Excel upload maps columns by header text (`<과목>_원점수` etc.), so old 3-column templates still import; a column absent from the file leaves existing values untouched.
- **Five screens**, defined by a tab list in the bundle: 학급 관리 (class), 자리 배치 (seating), 성적 관리 (grades), 마음 관계 (relations), 상담 내역 (counsel). Each has Excel download/upload buttons, which are the only backup/transfer mechanism between computers or browsers.
- **Persistence is `localStorage` only**, accessed through a small async wrapper (`Et.get/set/del`, JSON-serialized, errors swallowed). Keys are namespaced per class id: `app:meta` (class list and metadata), `students:<classId>`, `seating:<classId>`, `grades:<classId>`, `relations:<classId>`, `counsel:<classId>`; UI preferences live in `cm-fonts` and `cm-style`. Without sync, data is per browser and per origin (Chrome vs. Safari, or a different port, sees separate data); with sync enabled see below.
- **Multi-computer sync (optional)**: when `config.js` has a Firebase `apiKey` and `projectId`, `sync.js` shows an email/password login screen and mirrors the `students:/seating:/grades:/relations:/counsel:` keys to Firestore documents `users/{uid}/kv/{key with ':' → '~'}` (fields `value` = the raw JSON string, `updatedAt` = ms). It talks to the Identity Toolkit, securetoken and Firestore REST APIs with plain `fetch` (no SDK); endpoints can be overridden in `config.js` (`identityUrl`, `tokenUrl`, `firestoreUrl`) to point at a mock for testing. `Et.get` in the bundle awaits `window.cmSync.ready`; `Et.set/del` call `cmSync.touch/remove`. `localStorage` stays the working copy; unsent keys are tracked in `cmsync:meta.dirty` and retried (offline-safe). Conflicts are last-write-wins per key. `app:meta` and `cm-*` stay device-local. Remote changes seen while the app is open only raise a "reload" banner (not applied live, because the React state would be stale). Logout wipes the synced keys from that browser.
- **Offline behavior**: `sw.js` precaches only the `CORE` list (`./`, `index.html`, manifest, two icons) at install. Hashed files under `assets/` are cached lazily on first successful same-origin GET (cache-first, falling back to cached `index.html` on network failure). Cross-origin requests (the Firebase APIs) bypass the service worker.

## Modifying the app

The original source is not available, so changes are made by editing the minified bundle in `app/assets/` directly. Use targeted greps (for example for a Korean UI label or a storage key) rather than reading the file, since it is a few very long lines.

If you edit or rename any file the browser may already have cached, bump the `CACHE` string in `app/sw.js`. Because fetch is cache-first and `index.html` is precached, clients will otherwise keep serving stale files. If you rename the hashed bundle files, also update the references in `index.html`.
