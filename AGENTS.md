# Repository Guidelines

## Project Structure & Module Organization

This is a local-first TypeScript service using SQLite, Fastify, and a Codex worker.

- `src/app/`: Fastify API, Zod schemas, and control-job scheduler.
- `src/services/`: event, task, approval, lease, execution, and audit orchestration.
- `src/domain/`: state machines, policy, and structured-result contracts.
- `src/db/`: SQLite schema, migrations, integrity checks, and backups.
- `src/connectors/`, `src/dingtalk/`, `src/notifications/`: external adapters.
- `src/worker/`: Worker API client, task workspace, and Codex/scripted runners.
- `tests/`, `scripts/`, `docs/`: tests, demonstrations, and design records.

Keep `domain` independent of infrastructure. The Worker must not import database or approval-authorization code. Only the control plane writes SQLite.

## Build, Test, and Development Commands

```bash
npm install                 # Install dependencies
npm run migrate             # Apply SQLite migrations
npm run app                 # Start the Fastify control plane
npm run worker              # Start the configured Worker
npm run dingtalk:bridge     # Start the DingTalk card bridge
npm run typecheck           # Run strict TypeScript checks
npm test                    # Run all node:test suites
npm run build               # Emit compiled output to dist/
npm run demo                # Run the deterministic end-to-end demo
npm run backup              # Back up the configured SQLite database
```

Copy `.env.example` to `.env` and replace placeholder tokens before starting services. `WORKER_CODEX_MODE=codex` uses non-interactive `codex exec` with full permissions and approvals disabled; use `scripted` only for deterministic testing.

## Coding Style & Naming Conventions

Use two-space indentation, TypeScript ESM, and `.js` extensions in relative imports. Prefer `camelCase` for values/functions, `PascalCase` for classes/types, and `snake_case` only for database columns. Validate external input with Zod, parameterize SQL, and keep transactions short and explicit. No separate linter is configured; `npm run typecheck` is mandatory.

## Testing Guidelines

Use Node’s `node:test` runner through `tsx`. Name tests as behavior statements, such as `replayed events create one task`. Add regression tests for fixes. Use temporary SQLite databases and the fake DWS executable; never depend on a developer account or live writes.

## Commit & Pull Request Guidelines

Recent history uses prefixes such as `docs：add ...` and `code：add ...`. Keep commits focused. Pull requests should explain behavior, architecture impact, linked issues, environment or migration changes, and verification commands. Add screenshots only for visible UI changes.

## Security & Runtime Notes

Never commit `.env`, credentials, or `data/`. Preserve approval digests, one-time leases, idempotency, and audit records. Do not add shell or unrestricted connector execution to the Worker. Update `docs/` when architecture, operations, or protocol contracts change.
