import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoogleHealthClient } from "./api.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerSleepTools } from "./tools/sleep.js";

const INSTRUCTIONS = `Sleep and recovery data from the user's Fitbit or Pixel Watch, via the Google Health API.
Dates are the user's local calendar dates. Nightly metrics (HRV, sleeping and resting heart rate, SpO2, breathing rate, skin temperature) belong to the date the user woke up.
Data only reaches Google after the watch syncs with the Fitbit app, and some metrics are computed a while after waking, so this morning's values may be missing at first.
HRV is RMSSD in milliseconds, as shown in the Fitbit app.`;

export function createMcpServer(client: GoogleHealthClient): McpServer {
  const server = new McpServer({ name: "google-health", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  registerRecoveryTools(server, client);
  registerSleepTools(server, client);
  return server;
}
