import { loadDingTalkBridgeConfig } from "../config.js";
import {
  HttpDingTalkCallbackClient,
  DingTalkCardBridge,
} from "./bridge.js";
import { DingTalkDwsClient } from "./dws.js";

const config = loadDingTalkBridgeConfig();
const dws = new DingTalkDwsClient({
  command: config.dwsCommand,
  catalogUrl:
    process.env.DINGTALK_CARD_CATALOG ??
    "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json",
  approverOpenId: config.expectedOpenId,
});
const callback = new HttpDingTalkCallbackClient(
  config.apiBaseUrl,
  config.bridgeToken,
);
const logger = {
  info(input: unknown, message?: string) {
    console.info(JSON.stringify({ level: "info", input, message }));
  },
  warn(input: unknown, message?: string) {
    console.warn(JSON.stringify({ level: "warn", input, message }));
  },
  error(input: unknown, message?: string) {
    console.error(JSON.stringify({ level: "error", input, message }));
  },
};
const bridge = new DingTalkCardBridge(config, dws, callback, logger);

process.on("SIGINT", () => bridge.stop());
process.on("SIGTERM", () => bridge.stop());

await bridge.start();
