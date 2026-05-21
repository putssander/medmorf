# Medmorf — Agent Instructions

These rules apply to **every AI coding agent** (GitHub Copilot, Claude, Cursor, Aider, etc.) making changes in this repo. Read this file before editing.

## 1. Keep `README.md` in sync — non-negotiable

The README is the canonical reference for users, contributors, and other agents. **Any change that affects what the README documents must update the README in the same change.**

You **must update `README.md`** whenever you do any of the following:

- Add, remove, rename, or relocate any file in `src/`, `styles/`, `assets/brand/`, `server/`, or `tests/`
- Change the top-level folder structure
- Add, remove, or replace a runtime dependency (CDN URL, model ID, library version)
- Change the supported file formats (`.xlsx`, `.docx`, `.pdf`, DICOM, audio …)
- Add or remove a tab / feature pillar (Translate, Anonymize, Summarize, STT, DICOM, Storage, …)
- Change the live deployment URL or hosting setup
- Change anything in the privacy / healthcare-safety posture
- Bump the service-worker cache version (`CACHE_NAME` in `sw.js`) — note it in the runtime architecture section if a section references the version
- Change the brand (palette, fonts, logo, favicon set)
- Change the local-dev instructions (port, command, requirements)

Specifically, keep these README sections accurate:

- **🚀 Live Site** — current public URL
- **✨ What Medmorf does** — feature pillars table
- **🔒 Privacy & healthcare safety** — links to privacy docs
- **📝 File Structure** — must match the actual directory tree
- **🏗️ Runtime Architecture** — model IDs, library versions, runtime split rationale
- **🛠️ Technical Details / Model Information** — model versions and sizes
- **🎨 Brand** — pointer to `docs/brand/medmorf-brand-guide.md`

If you're unsure whether a change affects the README, **err on the side of updating it.** A small inaccuracy compounds quickly.

## 2. Keep this file in sync

If you add a new top-level folder, a new agent-relevant convention, or a new constraint (e.g. "do not edit `src/foo.js` directly"), add it here.

## 3. Repo conventions

- **No bundler.** This is a vanilla-JS PWA loaded via `<script type="module">` and an `importmap` in `index.html`. Do not introduce webpack/vite/rollup unless explicitly asked.
- **All client-side JS lives in `src/`** as a flat directory. Inter-module imports are sibling-relative (`./foo.js`). Don't subdivide `src/` without updating every import statement.
- **`index.html`, `sw.js`, `manifest.webmanifest`** must stay at the repo root (host + service-worker scope requirement).
- **CSS is layered:**
  - `styles/styles.css` — legacy component styles. Avoid editing; prefer overrides.
  - `styles/brand.css` — brand layer. Loads after `styles.css` and retokens via CSS variables. Add new component styles here.
  - Tailwind utilities can be authored directly in HTML; brand tokens are exposed via the Tailwind config in `index.html` (`bg-mm-gradient`, `text-clinical`, `rounded-mm-lg`, etc.).
- **Service worker:**
  - `CACHE_NAME` versioning: bump `medmorf-app-vN` whenever the app shell changes so users get a new SW.
  - `APP_SHELL` paths must match the real file paths after any reorg.
  - The activate handler only deletes caches matching `medmorf-app-*` — model-weight caches (WebLLM, Transformers.js) survive cache busts. Don't broaden the deletion filter.
- **Brand assets** live in `assets/brand/`. Reference SVGs from there in `index.html` `<head>`, `manifest.webmanifest`, and `sw.js` APP_SHELL. The brand guide is at `docs/brand/medmorf-brand-guide.md`.
- **Privacy posture is load-bearing.** Do not introduce analytics, tracking, third-party telemetry, or unconditional outbound network calls. Models are loaded from public CDNs; that's the only egress.
- **Test fixtures** live in `tests/`. Don't move them to the repo root.
- **`server/deduce_server.py`** is an optional Python service, not part of the client app. Keep it in `server/`.

## 4. Cache-busting

Most JS/CSS `<script>` and `<link>` tags use `?v=YYYY-MM-DD-tag-N`. When you ship a meaningful change, update the version suffix on the affected references and bump `window.MEDMORF_BUILD_ID` in `index.html`.

## 5. Operational safety

- Do not commit secrets, API keys, model files, or large binary fixtures.
- Do not enable any code path that uploads user input to a remote server. The app must remain 100% client-side.
- Do not delete user-facing privacy / safety documentation without explicit user approval.

## 6. When in doubt

Update the README and this file before opening a PR. If you're an interactive agent and the user hasn't asked about the README, update it anyway and mention it briefly in your final message.
