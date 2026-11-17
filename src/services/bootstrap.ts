import { POLICY_VERSION } from "../domain/policy.js";
import { nowIso, sha256 } from "../lib/canonical.js";
import type { Store } from "../db/database.js";

export const LOCAL_USER_ID = "user_local";
export const LOCAL_ASSISTANT_ID = "assistant_local";
export const LOCAL_TODO_ACCOUNT_ID = "acct_todo_local";
export const LOCAL_MESSAGE_ACCOUNT_ID = "acct_message_local";

export function bootstrapLocalInstallation(store: Store): void {
  const now = nowIso();
  store.transaction(() => {
    store.db
      .prepare(
        `INSERT OR IGNORE INTO users (id, timezone, kill_switch, created_at)
         VALUES (?, ?, 0, ?)`,
      )
      .run(LOCAL_USER_ID, "Asia/Shanghai", now);
    store.db
      .prepare(
        `INSERT OR IGNORE INTO assistants
          (id, user_id, display_name, profile_ref, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        LOCAL_ASSISTANT_ID,
        LOCAL_USER_ID,
        "Personal Assistant",
        "local://profile/default",
        now,
      );
    const insertAccount = store.db.prepare(
      `INSERT OR IGNORE INTO source_accounts
        (id, user_id, connector_id, account_ref, scopes_json, secret_ref,
         device_id, status, created_at)
       VALUES (?, ?, 'memory', ?, ?, ?, NULL, 'active', ?)`,
    );
    insertAccount.run(
      LOCAL_TODO_ACCOUNT_ID,
      LOCAL_USER_ID,
      "todo",
      JSON.stringify(["todo.write"]),
      "keychain://personal-super-agent/todo",
      now,
    );
    insertAccount.run(
      LOCAL_MESSAGE_ACCOUNT_ID,
      LOCAL_USER_ID,
      "message",
      JSON.stringify(["message.send"]),
      "keychain://personal-super-agent/message",
      now,
    );
    store.db
      .prepare(
        `INSERT OR IGNORE INTO rule_versions
          (version, source_ref, content_sha256, effective_at, retired_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        POLICY_VERSION,
        "src/domain/policy.ts",
        sha256(POLICY_VERSION),
        now,
        now,
      );
  });
}
