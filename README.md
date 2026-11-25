# TDC Voice Charting

Dictate a treatment plan or a clinical note, check Claude's draft, then tap **Confirm** to write it into Open Dental. Part of the TDC Office suite (the plan is in [TDC-Office-Plan](https://github.com/MULLET156/TDC-Office-Plan)).

**How it works for staff**

1. Open **Voice Charting** from the Dashboard and find the patient.
2. Choose **Treatment plan** or **Note**.
3. Tap the big box and dictate with **Wispr Flow** (or just type).
4. Tap **Draft**. Claude turns it into a draft in 10–30 seconds.
5. Check it. For a plan, each line shows the code, tooth, surfaces and priority, and can be changed or removed. For a note, the text can be edited, and you choose which of today's completed procedures it covers (or make it an addendum).
6. A doctor, hygienist or the owner taps **Confirm**. The module writes it to Open Dental, reads it back, and shows you what Open Dental now has, with fees.

Nothing is ever signed. Sign notes and plans in Open Dental as usual.

## Safety

- **Only Confirm writes.** Drafting only reads. Claude gets reading tools only (patient, chart, treatment plans, procedure codes, priorities), and only for the patient you picked. It can never write.
- **Who can Confirm:** doctor, hygienist, owner. Assistants can make and edit drafts; they wait in **Waiting for Confirm**.
- **Read-back:** every line is read back from Open Dental after writing. If anything doesn't match, the line says "Check in Open Dental".
- **No double writes:** if Open Dental stops part-way, the lines already written turn green and are never written again when you Confirm the rest.
- **Design stage test patient:** while the suite runs on Hostinger with Open Dental's demo database, Confirm only writes to **PatNum 8133** (Ryan A. Millet). Other patients can be drafted but not confirmed.
- **Stage check:** every 5 minutes the module asks the gateway which stage it's in. If it isn't the same as `TDC_STAGE`, patient pages stop ("Voice Charting is paused").
- **The dictation isn't kept.** It goes to Claude and is dropped. Only the draft is kept, and only until Confirm or Discard (drafts nobody confirms are deleted after 3 days). History keeps who dictated, who confirmed, the patient number and codes, never the note text.
- **No browser speech recognition.** Chrome's built-in one sends audio to Google without a BAA, so it's never used. Spell-check is off in the dictation box for the same reason.

## Wispr Flow

Wispr Flow types into whatever box has focus, so there's nothing to connect: the dictation box is selected when the page opens. Typing works too.

- Before real patients: sign Wispr Flow's **HIPAA BAA** (it locks Privacy Mode on). Android tablets need a team account with the admin-signed BAA.
- **Add these words to Wispr Flow's Dictionary** so they come out right:

  MOD · MO · DO · OL · DL · BWX · FMX · PA · Pano · CBCT · SRP · prophy · perio · RCT · endo · pulpotomy · buildup · onlay · veneer · Ti-base · abutment · osteotomy · CEREC · Cercon · KATANA · zirconia · e.max · Blue Sky Bio · lidocaine · articaine · Septocaine · carpule · epi · Gluma · RMGI · Fuji · Vitrebond

  Add any other implant brands you use. The same list is on the module's **Settings** page.

Claude already understands dictation as people say it: "crown on thirty", "MOD composite on three", "bitewings", "phase two", tooth numbers as words, surfaces as letters. Anything it keeps getting wrong goes in **Settings → Office words**.

## How to test on your Windows computer (fake data)

You need **Node.js 20 or newer** (type `node -v` in a terminal; get it from nodejs.org). Three things run side by side, each in its own window.

1. **The demo gateway (fake patients).** Download [opendental-claude](https://github.com/MULLET156/opendental-claude) (Code → Download ZIP → Extract All) and double-click **start-demo.cmd**. Leave the window open.
2. **The Dashboard.** In your TDC-Dental-Dashboard folder, double-click **start.cmd** and log in.
   Go to **Settings → Modules → Add a module**: id `voice`, name `Voice Charting`, address `http://127.0.0.1:3103`, leave Secret empty, **Add module**. Copy the secret it shows.
3. **This module.** Download this repository the same way. In its folder, copy `.env.example` to `.env` and open `.env` in Notepad:
   - `MODULE_SECRET=` paste the secret from step 2
   - `GATEWAY_KEY=odg_test_voice_key_0003` (the demo gateway's test key; fake data only)
   - `ANTHROPIC_API_KEY=` your Anthropic key
   Save, then double-click **start.cmd**. It should say `Gateway stage OK (demo gateway with fake data)`.
4. In the Dashboard, open **Voice Charting**:
   - Type `Apple` and tap **Find**, then **Choose** next to Dana Applewood.
   - Leave **Treatment plan** selected, click in the big box and dictate (or type): *"Crown on thirty, MOD composite on three, phase two. Four bitewings."*
   - Tap **Draft**. Check the three lines: D2740 #30, D2393 #3 MOD, D0274, priority 2.
   - Tap **Confirm and write to Open Dental**. You'll see each line with **Read back** and its fee.
5. Try a note: **New dictation**, pick a patient with procedures completed today, choose **Note**, dictate *"Two carp lido with epi, tolerated well"*, Draft, then Confirm. It shows **Group note … Unsigned**.
6. Try an assistant: in the Dashboard add a staff member with only the **assistant** role, log in as them, and make a draft. There's no Confirm button; the draft waits under **Waiting for Confirm** for a doctor.
7. On the Dashboard home page you'll see the **My drafts waiting** and **Unsigned notes** tiles.

The demo gateway forgets everything when you close it.

## Put it on Hostinger (design stage)

See [docs/HOSTINGER.md](docs/HOSTINGER.md). Short version: a Node.js app from this repo's `main` branch, entry file `server.js`, with the settings below. Every merge to `main` redeploys it.

## Settings (.env)

| Name | What |
|---|---|
| `TDC_STAGE` | `design` (Hostinger, demo database) or `live` (office server) |
| `PORT` / `HOST` | Office server: `3103` and `127.0.0.1`. Hostinger: leave `PORT` out, `HOST=0.0.0.0` |
| `MODULE_SECRET` | From Dashboard → Settings → Modules |
| `GATEWAY_URL` / `GATEWAY_KEY` | The Open Dental gateway and this module's own key (`node gateway/cli.js new-key voice`) |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `WRITE_PATNUMS` | Design stage: the only patients Confirm writes to (default `8133`) |
| `DATA_DIR` | Where drafts, history and settings are kept (Hostinger: `~/tdc-voice-data`) |
| `DRAFT_HOURS` | Unconfirmed drafts are deleted after this many hours (default 72) |
| `TZ` | `America/Los_Angeles` |

Never put these values in email, chat or GitHub.

## Later (not built yet)

A built-in microphone button using **Whisper on the office server** (`127.0.0.1:3110`) for devices without Wispr Flow. The page is ready for a second way to fill the box; it'll be built when you ask.

## For developers

`npm test` runs the tests (made-up data only). No npm dependencies. Open Dental code is the shared `core/` from opendental-claude in `vendor/opendental-core/` (don't edit; update with `node scripts/sync-core.js <version>`). See [CLAUDE.md](CLAUDE.md).
