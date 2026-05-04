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

Top-level submodules under `src/` (`adapters/`, `db/`, `http/`, `mcp/`, `query/`, `records/`, `storage/`) are exposed as Node subpath imports — declared in `package.json` `imports`, used as `#adapters`, `#db`, `#http`, `#mcp`, `#query`, `#records`, `#storage`. Cross-module imports must use the alias; relative paths into another submodule are forbidden by `no-restricted-imports` in `eslint.config.js`.

Reaching past a barrel doesn't resolve at runtime: `#db/schema` is not declared in `imports`, so Node throws. To expose something new from a submodule, add the export to that submodule's `index.ts`. To move something between submodules, move the file — never bypass the alias.

Resolution scheme: the `imports` map uses three conditions per alias — `types` (tsc), `development` (tsx + vitest), `default` (production `node dist/...`). Dev/test scripts pass `--conditions=development`; vitest also sets `resolve.conditions: ['development']` in `vitest.config.ts`. Production runs the `default` (dist/) branch.

Why: the codebase is agent-paced. Every cross-module import line begins with `#`, so module dependencies are obvious at a glance and reviewers can spot unexpected coupling without reading every file.
