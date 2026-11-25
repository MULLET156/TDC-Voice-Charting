'use strict';
// TDC Voice Charting: starts the module. Settings come from .env (see .env.example).
//   npm start   (or double-click start.cmd on Windows)
process.env.TZ = process.env.TZ || 'America/Los_Angeles'; // the office's day, for "today"

const path = require('node:path');
const { loadEnv } = require('./lib/env');
loadEnv(path.join(__dirname, '.env'));

const { createApp } = require('./lib/app');
const { createOd } = require('./lib/od');
const { createClaude } = require('./lib/claude');
const { createStore } = require('./lib/store');

function fail(msg) {
  console.error(`Voice Charting can't start: ${msg}`);
  process.exit(1);
}

const env = process.env;
const stage = (env.TDC_STAGE || '').trim();
if (stage !== 'design' && stage !== 'live') fail('TDC_STAGE must be "design" or "live". Copy .env.example to .env and fill it in.');
const port = Number(env.PORT || 3103);
const host = env.HOST || '127.0.0.1';
// CONTRACT §1: in the live stage modules listen on this computer only.
if (stage === 'live' && !['127.0.0.1', 'localhost', '::1'].includes(host)) fail('In the live stage HOST must be 127.0.0.1 (the Dashboard passes requests through).');
if (!env.MODULE_SECRET || !/^[0-9a-fA-F]{64,}$/.test(env.MODULE_SECRET)) fail('MODULE_SECRET is missing or too short. Paste the secret from Dashboard → Settings → Modules.');
if (!env.GATEWAY_KEY) fail('GATEWAY_KEY is missing (this module\'s own key for the Open Dental gateway).');
const writePatNums = String(env.WRITE_PATNUMS || '8133').split(/[\s,]+/).filter(Boolean).map(Number);
if (!writePatNums.length || writePatNums.some((n) => !Number.isInteger(n) || n <= 0)) fail('WRITE_PATNUMS must be patient numbers, e.g. 8133.');
if (!env.ANTHROPIC_API_KEY) console.warn('Note: ANTHROPIC_API_KEY is not set, so Draft will show an error until it is.');

let od;
try {
  od = createOd({ url: env.GATEWAY_URL || 'http://127.0.0.1:8787', key: env.GATEWAY_KEY });
} catch (e) { fail(e.message); }

const store = createStore({ dir: path.resolve(__dirname, (env.DATA_DIR || 'data').replace(/^~(?=$|[\\/])/, require('node:os').homedir())), draftHours: Number(env.DRAFT_HOURS || 72) });
const claude = createClaude({ apiKey: env.ANTHROPIC_API_KEY });

let app;
try {
  app = createApp({ secret: env.MODULE_SECRET, stage, od, claude, store, writePatNums });
} catch (e) { fail(e.message); }

app.server.listen(port, host, async () => {
  console.log(`Voice Charting listening on http://${host}:${port}/  (stage: ${stage})`);
  await app.start();
  console.log(app.state.paused ? `Paused: ${app.state.paused}` : `Gateway stage OK${app.state.gatewayFake ? ' (demo gateway with fake data)' : ''}.`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.stop(); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
