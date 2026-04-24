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

| Command                 | What                                    |
| ----------------------- | --------------------------------------- |
| `pnpm run dev`          | Start the service with watch mode       |
| `pnpm run test`         | Run tests                               |
| `pnpm run typecheck`    | `tsc` (no emit)                         |
| `pnpm run lint`         | ESLint                                  |
| `pnpm run format`       | Prettier (write)                        |
| `pnpm run format:check` | Prettier (check only)                   |
| `pnpm run check`        | Format check, lint, typecheck, and test |
| `pnpm run build`        | Emit `dist/`                            |
| `pnpm run start`        | Run `dist/index.js`                     |

## Status

Scaffold only. The real service is documented in `docs/plans/2026-04-23-project-scaffold-design.md` and `~/Desktop/rewrite-vitals.md`.

Smoke check after install:

```sh
pnpm run check
pnpm run dev
# in another shell:
curl http://localhost:3000/health
# -> {"status":"ok"}
```
