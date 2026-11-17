import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

export interface DatabaseOptions {
  readonly?: boolean;
  requireMigrated?: boolean;
}

export class Store {
  readonly db: Database.Database;
  readonly path: string;

  constructor(databasePath: string, options: DatabaseOptions = {}) {
    this.path =
      databasePath === ":memory:" ? databasePath : resolve(databasePath);
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new Database(this.path, {
      readonly: options.readonly ?? false,
      timeout: 5_000,
    });
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("temp_store = MEMORY");
    if (!options.readonly) {
      this.db.pragma("journal_mode = WAL");
    }
    const version = this.userVersion();
    if ((options.requireMigrated ?? true) && version !== SCHEMA_VERSION) {
      this.close();
      throw new Error(
        `Database schema is version ${version}, expected ${SCHEMA_VERSION}. Run \"npm run migrate\" first.`,
      );
    }
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  immediateTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  userVersion(): number {
    const row = this.db.pragma("user_version", { simple: true });
    return Number(row);
  }

  integrityCheck(): string {
    return String(this.db.pragma("integrity_check", { simple: true }));
  }

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}

export function migrateDatabase(databasePath: string): Store {
  const store = new Store(databasePath, {
    requireMigrated: false,
  });
  const current = store.userVersion();
  if (current === SCHEMA_VERSION) {
    return store;
  }
  if (current !== 0) {
    store.close();
    throw new Error(
      `No migration path from schema version ${current} to ${SCHEMA_VERSION}`,
    );
  }
  const schemaPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "schema.sql",
  );
  if (!existsSync(schemaPath)) {
    store.close();
    throw new Error(`Missing schema file: ${schemaPath}`);
  }
  const schema = readFileSync(schemaPath, "utf8");
  store.db.exec(schema);
  if (store.userVersion() !== SCHEMA_VERSION) {
    store.close();
    throw new Error("Migration completed but schema version is incorrect");
  }
  return store;
}

export function assertIntegrity(store: Store): void {
  const result = store.integrityCheck();
  if (result !== "ok") {
    throw new Error(`SQLite integrity check failed: ${result}`);
  }
}
