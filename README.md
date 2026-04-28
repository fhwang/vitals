# vitals

Personal health-data service: mediates access to an S3 archive, exposes HTTP + MCP.

## Requirements

- Node 24 (see `.nvmrc`)
- pnpm (via Corepack — enable with `corepack enable`)

## Setup

```sh
corepack enable
pnpm install
```

## Scripts

| Command                 | What                                           |
| ----------------------- | ---------------------------------------------- |
| `pnpm run dev`          | Start the service with watch mode              |
| `pnpm run start`        | Run `dist/index.js`                            |
| `pnpm run dev:mcp`      | Start the MCP server (stdio transport) via tsx |
| `pnpm run start:mcp`    | Run `dist/mcp/server.js`                       |
| `pnpm run test`         | Run tests                                      |
| `pnpm run typecheck`    | `tsc` (no emit)                                |
| `pnpm run lint`         | ESLint                                         |
| `pnpm run format`       | Prettier (write)                               |
| `pnpm run format:check` | Prettier (check only)                          |
| `pnpm run check`        | Format check, lint, typecheck, and test        |
| `pnpm run build`        | Emit `dist/`                                   |

## Status

HTTP scaffold plus an MCP entry point for ingestion. The HTTP service is still the scaffold documented in `docs/plans/2026-04-23-project-scaffold-design.md`.

Ingestion is reachable via MCP. The server exposes a single `ingest_record` tool that takes `path`, `kind`, `source`, and an optional `original_filename`, and archives a CCDA file into the storage backend selected by `VITALS_STORAGE_URL`. The transport is stdio — one process per session — launched by an agent harness like Claude Desktop or Claude Code via `node dist/mcp/server.js`. Path-based input is validated against the client's advertised MCP roots before any filesystem read. See `docs/plans/2026-04-25-ingestion-design.md` for the design rationale and `docs/plans/2026-04-25-ingestion-implementation.md` for the implementation plan.

Smoke check after install:

```sh
pnpm run check
pnpm run dev
# in another shell:
curl http://localhost:3000/health
# -> {"status":"ok"}
```
