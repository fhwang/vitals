# Project scaffold design

**Date:** 2026-04-23
**Status:** Approved, ready to execute

## Goal

Scaffold an empty Node + TypeScript service at the root of the new `vitals` repo. Produce a runnable "Hello World" service (Hono `GET /health`) with CI lint, format, typecheck, and test checks wired up. Every substantive toolchain decision should be in place so the next real feature (CCDA ingestion per `~/Desktop/rewrite-vitals.md`) slots in without setup work.

## Context

The parent plan (`~/Desktop/rewrite-vitals.md`) describes a personal health-data service: persistent Node process exposing HTTP + MCP, reading and writing an S3 archive, stateless apart from S3. This scaffold is the empty shell that plan builds on top of.

Style model: `/Users/fhwang/Code/ai-rig/main/spend-alerting` — a Deno project with aggressive TypeScript strictness and ESLint rules. We want the same style posture but Node + PNPM instead of Deno, because this service has different constraints: persistent process, MCP stdio transport (Node-native), and eventual containerized deployment.

## Decisions

### Scope: minimum viable service shell

A Hono app with one route (`GET /health`), zod-validated env config, a Vitest test, and a graceful-shutdown entry point. No S3, no records, no MCP — but the skeleton is real and runnable.

Alternatives considered:

- **Bare `console.log`:** too thin; CI wouldn't exercise anything meaningful.
- **Full directory scaffold with stubs:** premature structure; empty directories tend to be wrong and need to be unwound.

### Runtime: Node 24 LTS + PNPM

Node 26 is the current stable line as of April 2026, but LTS doesn't begin until October. Node 24 is Active LTS and matches what hosted runtimes (Lambda, Fly, Railway, ECS) currently offer. Cost of switching later is an `.nvmrc` edit and a `tsconfig target` bump.

PNPM 10.x pinned via `packageManager` field + Corepack.

ESM throughout (`"type": "module"`), `NodeNext` module resolution so TS imports carry `.js` extensions.

### Linter: ESLint flat config, type-aware, matching spend-alerting's strictness plus additions

Rule set copied from spend-alerting:

- `max-lines: 300`, `max-lines-per-function: 50`, `max-depth`, `max-params`, `max-statements`, `max-nested-callbacks`, `complexity`
- `@typescript-eslint/no-unused-vars: error`
- `@typescript-eslint/no-explicit-any: error`
- Relaxed limits for `*.test.ts` files

Added on top (type-aware):

- `@typescript-eslint/no-floating-promises`
- `@typescript-eslint/no-misused-promises`
- `@typescript-eslint/consistent-type-imports`
- `@typescript-eslint/strict-boolean-expressions`
- `@typescript-eslint/prefer-nullish-coalescing`
- `@typescript-eslint/prefer-optional-chain`

Plugins:

- `typescript-eslint` (unified v8) — parser + plugin + recommended configs
- `eslint-plugin-anvil` — Sera's own plugin; enables `anvil/no-excessive-optionals` (type hygiene)

Also: `forbid-junk-object-types` run as a separate CI step (CLI, not an ESLint rule).

Rejected: Biome (doesn't match `max-lines-per-function`/`complexity` shape), Oxlint (more moving parts for speed we don't need).

### Formatter: Prettier

- 100-char line, single quotes, trailing commas (`all`), semi, LF
- Formats `.ts`, `.js`, `.json`, `.yaml`, `.md`
- `eslint-config-prettier` appended last in ESLint flat config so stylistic rules don't fight

Rationale for formatting under agent-authored code: agents drift on style across sessions; a deterministic formatter keeps diffs about logic, not whitespace. Runs in CI via `prettier --check`.

### Pre-commit hooks: none

CI is the enforcer. No husky/lint-staged. Solo project, trivial to re-run locally, and hooks tend to produce `--no-verify` creep.

### Build/dev: `tsc` for prod, `tsx watch` for dev

- `pnpm run dev` — `tsx watch src/index.ts`, instant reloads
- `pnpm run build` — `tsc`, emits `dist/`
- `pnpm run start` — `node dist/index.js`

Rejected: `tsup` (bundler complicates native-dep and source-maps story for no gain on a server), `tsx` in prod (startup overhead, less predictable).

### Test framework: Vitest

Confirmed from parent plan. Hono's in-process `app.request()` API exercises real routing without binding a port.

### CI: GitHub Actions, five parallel jobs

One workflow (`.github/workflows/ci.yml`), jobs: `format`, `lint`, `typecheck`, `test`, `forbid-junk-object-types`. Triggered on push-to-main and PR-to-main.

Parallel jobs (vs sequential steps) so an agent-authored PR with failures in multiple categories surfaces all of them in one CI run, not round-trips.

Each job: `actions/checkout` → `pnpm/action-setup` → `actions/setup-node` (reading `.nvmrc`, pnpm cache) → `pnpm install --frozen-lockfile` → the relevant script.

### Validation: Zod

Service has four untyped-data boundaries (env, HTTP bodies, S3 sidecar JSON, MCP inputs) that need runtime validation. Zod's schema-is-type pattern means no drift between validator and TS type, and `@hono/zod-validator` + `zod-to-json-schema` give first-party Hono and MCP integration. Zod 4 API.

Rejected: Valibot (smaller but no Hono/MCP ecosystem), Ajv (less ergonomic, needs TypeBox), plain TS (drift at every boundary).

### Logging: pino

Plan says pino. JSON output, no pretty-printer in the scaffold (add if it starts hurting).

## File inventory

```
.github/workflows/ci.yml
.gitignore
.editorconfig
.nvmrc                          # "24"
.env.example
.prettierrc.json
.prettierignore
eslint.config.js
package.json
pnpm-lock.yaml                  # generated
tsconfig.json
vitest.config.ts
README.md
docs/plans/2026-04-23-project-scaffold-design.md  # this file
src/
  index.ts                      # entry, serve + shutdown
  config.ts                     # zod env schema
  http/
    app.ts                      # Hono factory with /health
    app.test.ts                 # vitest GET /health
```

## Acceptance

```
pnpm install                                          # clean
pnpm run check                                        # format + lint + typecheck + test all green
pnpm exec forbid-junk-object-types --target-dir .     # green
pnpm run dev                                          # server on :3000, GET /health → {"status":"ok"}
```

Plus CI passes on first PR.

## Deferred

- **Dockerfile** — belongs in the migration plan's step 10; the base image choice deserves its own decision once the service does real work.
- **Any `src/storage`, `src/records`, `src/mcp`, `src/parsing` directories** — created when their first file is written.
- **Branch protection rules** — GitHub UI setting, configured after first PR lands.
- **Build job in CI** — `tsc --noEmit` (the typecheck job) already proves compile. Add a real build job if/when artifacts need to ship.
