import { assertIntegrity, migrateDatabase } from "./database.js";

const databasePath = process.env.DATABASE_PATH ?? "./data/assistant.db";
const store = migrateDatabase(databasePath);
assertIntegrity(store);
console.log(
  JSON.stringify({
    migrated: true,
    databasePath: store.path,
    schemaVersion: store.userVersion(),
    integrity: "ok",
  }),
);
store.close();
