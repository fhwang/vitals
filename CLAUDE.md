# vitals

TypeScript service built with Hono, pnpm, Vitest. Node 24+, pnpm 10.

## Worktrees

Use `.claude/worktrees/<name>/` for all isolated work. This aligns with Anthropic's built-in `claude --worktree` feature and unlocks `.worktreeinclude` env copying, auto-cleanup, and subagent isolation out of the box.

### When to create one

Use a worktree when:

- A second Claude session would be useful in parallel.
- The change shouldn't touch the current branch's working tree.
- Running an experiment that might be abandoned.

Skip worktrees for single-file fixes, typo PRs, or anything you'd resolve in a minute — the setup overhead isn't worth it.

### How to create one

Preferred: `claude -w <name>` (creates `.claude/worktrees/<name>/` with branch `worktree-<name>` from `origin/HEAD`, copies files listed in `.worktreeinclude`).

Alternatively: ask an existing session to "work in a worktree."

After the worktree exists, run `pnpm install` then `pnpm check` once as a clean-baseline verification before making any edits. If `check` fails on an unmodified worktree, investigate the baseline before proceeding — don't build on a broken foundation.

### Naming

Kebab-case, purpose-prefixed:

- `feat-<description>` — new features (`feat-auth-oauth`)
- `fix-<description>` or `fix-<issue-num>` — bug fixes (`fix-payment-timeout`, `fix-123`)
- `exp-<description>` — experiments / spikes (`exp-bun-runtime`)
- `refactor-<description>` — non-behavioral refactors

Include issue numbers for tracked work. Don't use `temp`, `wip`, or single-word names.

### Cleanup

Exiting a `-w` session with no changes auto-removes the worktree and branch. With changes, Claude prompts keep-or-remove.

Manual sweep when needed:

```bash
git worktree list
git worktree remove .claude/worktrees/<name>
```

If `origin/HEAD` drifts (new worktrees branching from a stale default), refresh with:

```bash
git remote set-head origin -a
```

### Pitfalls

- **Stashes are repo-global**, not worktree-scoped. Prefer a commit over a stash while multiple worktrees are active.
- **Same branch can't be checked out twice.** If `git worktree add` fails with "already checked out," either reuse the existing worktree or pick a different branch.
- **Never symlink `node_modules`** across worktrees — pnpm fails hard when `node_modules` itself is a symlink. Run a fresh `pnpm install` per worktree; the content-addressable store keeps it fast.
- **Two Claudes at once is the sweet spot**, 3–5 is the practical ceiling. Review overhead dominates past that.

## Toolchain notes

- `eslint-plugin-anvil` and `forbid-junk-object-types` are first-party packages (Sera's own). Keep them in TypeScript setups.
- Run `pnpm check` before declaring any change complete — it chains format, lint, typecheck, `forbid-junk-object-types`, and test.

## Lint policy

**Never bypass a lint rule. Fix the actual problem.**

This applies to ESLint, `forbid-junk-object-types`, and any other configured check. Specifically forbidden:

- `// eslint-disable`, `// eslint-disable-next-line`, `/* eslint-disable */` blocks — at any scope, with any justification.
- Per-file or per-pattern carve-outs in `eslint.config.js` that relax rules for a new file-suffix convention. (The existing `*.test.ts` carve-out is the only one; don't add `*.contract.ts`, `*.fixtures.ts`, etc.)
- Inline-type workarounds for `forbid-junk-object-types` (e.g., spelling an inline shape as `Record<string, unknown>` to dodge the rule).
- Commenting out a rule in the config to make a change land.

If a rule fires, the right move is to refactor: split the function, narrow the type, restructure the API, lean on platform types (`NodeJS.ErrnoException`, AWS SDK error classes), or pick a different data shape (tuple instead of inline object). The rule exists for a reason; bypassing it is opting out of that reason.

If a rule is genuinely wrong for the project, change the rule once for the whole codebase with a reasoned commit message — not per-file.

## Code style

Prefer plain functions and closure factories over classes. Reach for a class only when one of these applies:

- An error subclass (`extends Error`)
- `implements`-driven polymorphism, where the runtime needs a swappable interface (e.g., the `BlobStore` family)
- A genuine state machine with a clear lifecycle and ordering constraints

A class whose only purpose is to share a `db` or `store` reference across methods → refactor to a closure factory like `createCredentialsStore(db)` returning `{read, insert, upsert, ...}`. A class introduced to dodge `max-params` or `forbid-junk-object-types` → that's the wrong workaround. Better factorings: split the function, model the args as a domain-concept struct used in 2+ signatures (which satisfies the single-use rule), capture deps via a closure factory, or use a tuple param for primitive-only bundles.

Tests use the same style: free functions and the existing factories, no class instantiation just to call a method. Use RFC 2606-reserved `example.com` (or `example.org`/`example.net`) for email fixtures so future readers immediately recognize them as placeholders.

## Module boundaries

Top-level submodules under `src/` (`adapters/`, `daemon/`, `db/`, `http/`, `mcp/`, `notifications/`, `query/`, `records/`, `storage/`) are exposed as Node subpath imports — declared in `package.json` `imports`, used as `#adapters`, `#daemon`, `#db`, `#http`, `#mcp`, `#notifications`, `#query`, `#records`, `#storage`. Cross-module imports must use the alias; relative paths into another submodule are forbidden by `no-restricted-imports` in `eslint.config.js`.

Reaching past a barrel doesn't resolve at runtime: `#db/schema` is not declared in `imports`, so Node throws. To expose something new from a submodule, add the export to that submodule's `index.ts`. To move something between submodules, move the file — never bypass the alias.

Resolution scheme: the `imports` map uses three conditions per alias — `types` (tsc), `development` (tsx + vitest), `default` (production `node dist/...`). Dev/test scripts pass `--conditions=development`; vitest also sets `resolve.conditions: ['development']` in `vitest.config.ts`. Production runs the `default` (dist/) branch.

Why: the codebase is agent-paced. Every cross-module import line begins with `#`, so module dependencies are obvious at a glance and reviewers can spot unexpected coupling without reading every file.

## Device-specific code boundary

Vendor/integration-specific code lives **only** under `src/adapters/<vendor>/` (today: `src/adapters/fitbit/`; future: `src/adapters/<other>/`). Shared modules — `db/`, `mcp/`, `notifications/`, `query/`, `storage/`, `daemon/` — must reason about adapters in the abstract; they don't carry the literal vendor's name in any surface that a consumer (harness, MCP client, schema reviewer) sees.

Concretely:

- **Schema:** tables that hold data from multiple adapters carry an `adapter_name` discriminator column rather than splitting into per-vendor tables. Good examples: `adapter_credentials`, `adapter_state`, `adapter_day_state`. Per-vendor tables in `src/db/schema.ts` are forbidden.
- **MCP surface:** tool names, schemas, and descriptions describe behavior in adapter-generic terms ("the most recent sample observed across syncing adapters"), not vendor-specific terms ("the most recent Fitbit sample"). Same goes for tool result shapes — fields use names like `freshness_frontier_at`, not `fitbit_frontier_at`.
- **Notifications:** condition IDs _intentionally_ encode the adapter as a prefix (`fitbit-auth-expired`, future `rippling-auth-expired`). That's the identity of a specific failure mode, not vendor leakage. The evaluator and channel implementations themselves stay vendor-agnostic — they don't branch on which prefix shows up.
- **Adapter-internal helpers** (Fitbit-specific confidence, parsers, etc.) live inside the adapter's directory and may use the vendor's name freely. They are exposed to the rest of the codebase through generic interfaces — e.g., `getFitbitDayConfidence` lives in `src/adapters/fitbit/confidence.ts` but is consumed by `src/query/sqlite-archive.ts` through the adapter-agnostic `buildConfidenceByDate`.

Why: this is a one-adapter codebase that wants to be a many-adapter codebase, and the cost of letting vendor names sediment into shared surfaces is a future rewrite of every consumer's parse path. Lifting them out one at a time is much cheaper than ripping them out after they've spread.
