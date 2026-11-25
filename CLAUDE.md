# TDC Voice Charting — notes for agents

Read the shared plan first: **MULLET156/TDC-Office-Plan** (README, PLAN, CONTRACT, DESIGN, SITE-OUTLINE, STATUS) and the kickoff `prompts/5-voice-charting.md`. Follow CONTRACT.md exactly; propose changes as an issue there titled `Contract change: ...` and wait for Ryan.

Module id `voice`, port 3103. **The only module that writes to Open Dental, so safety comes first.**

## Rules
- Node.js 20+ built-ins only. No npm dependencies.
- Pull `main` and check open PRs and branches first. Work on a short branch, open a PR, and **merge it yourself** when CI is green on Windows and Linux and your checks pass (Ryan, 2026-11-16). Still: contract changes need Ryan's OK; **changes that write to Open Dental are tested on PatNum 8133 before merging**; `main` deploys to Hostinger, so check `/health` and the pages right after merging and revert at once if something broke.
- No patient data in code, tests, issues, logs or screenshots, not even from the demo database. Tests use made-up data (`test/helpers.js`).
- Never print or commit secrets. `.env` and `data/` are git-ignored.
- Open Dental only through the gateway with this module's key, using `vendor/opendental-core/` (never edit it; `node scripts/sync-core.js <version>`). No hand-written Open Dental calls. Need a report? Open `Report request: <name>` in opendental-claude and build against fake data meanwhile. Only the Connector agent changes opendental-claude.
- Every page follows DESIGN.md with the Dashboard's `/shared/tdc.css` and `shell.js`. `public/voice.css` is layout only. No inline scripts.
- README and PR descriptions in plain language, Windows first, with "How to test".
- Update only the Voice Charting row in TDC-Office-Plan/STATUS.md, by PR there.

## Safety design (keep it)
- Claude gets **reading** tools only (`lib/drafting.js` `claudeTools`), always pinned to the picked patient. Write tools live in `lib/od.js` `WRITE_TOOLS` and are used only by `lib/writer.js` after Confirm.
- Confirm: doctor, hygienist, owner. Assistants draft. Design stage + demo database: writes only to `WRITE_PATNUMS` (default 8133); fake demo gateway: any made-up patient.
- Every write is read back. Progress is saved per line so retries never write twice. Nothing is signed.
- The dictation is never stored or logged. Drafts live in `data/drafts.json` until Confirm/Discard (pruned after `DRAFT_HOURS`). History holds PatNum, codes, ProcNums, who dictated/confirmed — no note text, no names.
- Never the browser Web Speech API. A later Whisper mic (127.0.0.1:3110) is another text source into the same box; don't build it until Ryan asks.

## Map
- `server.js` start-up and settings. `lib/app.js` routes, stage guard, tiles. `lib/pages.js` HTML.
- `lib/drafting.js` Claude prompt, tools and draft clean-up. `lib/claude.js` Messages API with fetch. `lib/writer.js` Confirm.
- `lib/od.js` gateway client + core tools. `lib/store.js` the module's own records. `lib/tdc-verify.js` copied from the Dashboard's hello module.
- `test/` — `node --test`, fake gateway and fake Claude in `test/helpers.js`.
