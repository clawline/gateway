import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayConfigStore, ensureRelayConfigShape } from "../lib/relay-config-store.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(scriptDir, "..");
const sourcePath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : process.env.RELAY_CONFIG_PATH || resolve(baseDir, "data", "relay-config.json");

async function main() {
  const relayStore = createRelayConfigStore({ baseDir });
  if (relayStore.kind !== "supabase") {
    throw new Error(
      "Supabase storage is not configured. Set RELAY_SUPABASE_URL and RELAY_SUPABASE_SERVICE_ROLE_KEY before running migration.",
    );
  }

  const raw = await readFile(sourcePath, "utf8");
  const relayConfig = ensureRelayConfigShape(JSON.parse(raw));
  const channelCount = Object.keys(relayConfig.channels).length;
  const userCount = Object.values(relayConfig.channels).reduce((count, channel) => count + channel.users.length, 0);

  await relayStore.replaceConfig(relayConfig);

  console.log(`[relay] migrated ${channelCount} channel(s) and ${userCount} user(s) from ${sourcePath}`);
}

main().catch((error) => {
  console.error("[relay] migration failed:", error);
  process.exitCode = 1;
});
