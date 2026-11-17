import { loadConfig } from "../config.js";
import { MemoryConnector } from "../connectors/memory.js";
import { ConnectorRegistry } from "../connectors/registry.js";
import { Store } from "../db/database.js";
import { FeishuNotifier } from "../notifications/feishu.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const store = new Store(config.databasePath);
const connectors = new ConnectorRegistry([new MemoryConnector()]);
const notifier = new FeishuNotifier(
  config.feishuWebhookUrl,
  config.feishuSigningSecret,
);
const server = await buildServer({ store, config, connectors, notifier });

const shutdown = async () => {
  await server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await server.app.listen({ host: config.host, port: config.port });
