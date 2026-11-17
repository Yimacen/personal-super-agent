import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Store } from "./database.js";

const sourcePath = process.env.DATABASE_PATH ?? "./data/assistant.db";
const backupDir = resolve(process.env.BACKUP_DIR ?? "./data/backups");
const timestamp = new Date().toISOString().replaceAll(":", "-");
const destination = resolve(backupDir, `assistant-${timestamp}.db`);

mkdirSync(dirname(destination), { recursive: true });
const store = new Store(sourcePath);
const integrity = store.integrityCheck();
if (integrity !== "ok") {
  store.close();
  throw new Error(`Refusing to back up a damaged database: ${integrity}`);
}
await store.db.backup(destination);
store.close();
console.log(JSON.stringify({ backedUp: true, destination, integrity }));
