# opendental-core 0.13.0

Copied from [MULLET156/opendental-claude](https://github.com/MULLET156/opendental-claude) `core/` by `scripts/sync-core.js`.

**Don't edit these files.** To update: `node scripts/sync-core.js <version>`. For changes, ask the Connector agent (open an issue in MULLET156/opendental-claude).

Use it like:

```js
const { createClient } = require("./vendor/opendental-core/odclient");
const { checkStage } = require("./vendor/opendental-core/gateway-client");
const od = createClient({ gatewayUrl: process.env.GATEWAY_URL, gatewayKey: process.env.GATEWAY_KEY });
await checkStage(od, process.env.TDC_STAGE); // refuses to start in design unless the gateway is fake
const { rows } = await od.runReport("daysheet", { date: "2026-11-16" });
```
