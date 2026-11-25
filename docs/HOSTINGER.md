# Putting Voice Charting on Hostinger (design stage)

In the design stage this module runs on your Hostinger account and reads Open Dental's **demo database** through the office gateway and its secure tunnel. Confirm writes only to the test patient (PatNum 8133). Every merge to `main` on GitHub redeploys it.

## One-time setup

1. **Make the module's gateway key.** On the computer with the gateway, in the opendental-claude folder: `node gateway/cli.js new-key voice --preset voice`. Follow what it prints to add the key to the gateway. Keep the key itself for step 4. (Until the TrueNAS gateway is up, you can use the demo gateway on Hostinger with fake data: use its address and the `DEMO_KEY_VOICE` key you set there.)
2. In **hPanel** → **Websites** → **Add Website** → **Node.js web app** → **Import Git repository**. Choose **MULLET156/TDC-Voice-Charting**, branch **main**.
3. Build settings: Framework **Other**, Node **22** (20 or newer works), Build command **empty**, Entry file **server.js**.
4. **Environment variables:**

   | Name | Value |
   |---|---|
   | `TDC_STAGE` | `design` |
   | `HOST` | `0.0.0.0` |
   | `MODULE_SECRET` | from step 6 (put anything for now, then replace) |
   | `GATEWAY_URL` | the gateway's tunnel address, `https://...` |
   | `GATEWAY_KEY` | the key from step 1 |
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `WRITE_PATNUMS` | `8133` |
   | `DATA_DIR` | `~/tdc-voice-data` (outside the app folder, so drafts and history survive deploys) |
   | `TZ` | `America/Los_Angeles` |

   Don't set `PORT`; Hostinger sets it.
5. **Deploy**, then open `https://<the app's address>/health`. You should see `{"ok":true,"version":"0.1.0","contract":1}`. Every other address answers **Unauthorized**, which is correct: only the Dashboard can open its pages.
6. In the **Dashboard** → **Settings → Modules → Add a module**: id `voice`, name `Voice Charting`, address = the app's `https://` address, Secret empty, **Add module**. Copy the secret it shows, paste it into the Hostinger variable `MODULE_SECRET`, and redeploy.
7. Open **Voice Charting** in the Dashboard. If it says **paused**, the gateway isn't answering or isn't in the design stage (check its `/health`).

## Before real patients

Everything that handles patient data moves to the office server before Open Dental is switched to the real database (PLAN.md, "Two stages"), and the Anthropic and Wispr Flow BAAs must be in place.
