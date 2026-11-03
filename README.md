# NobleCloak plugin for Claude Code

Connects Claude Code to your NobleCloak workspace, and applies your
organization's governance rules to the tool calls in your session.

**📖 Full documentation: <https://docs.noblecloak.com/docs/guides/claude-plugin/>**

That is the source of truth for installing, signing in, and what the plugin
sends. This file is the orientation for people working *on* the plugin.

## What it installs

| | |
|---|---|
| Commands | `/noblecloak-login`, `/noblecloak-logout`, `/noblecloak-status`, `/noblecloak-connect`, `/noblecloak-propose-tool`, `/noblecloak-setup`, plus workspace commands for journeys, tasks, and next steps |
| Agents | `noblecloak-assistant` (workspace) and `noblecloak-planner` (sustained planning) |
| Skills | `noblecloak-help` and `noblecloak-journey-work`. The setup skills `noblecloak-setup-{approvals,permissions,connections,langgraph}` are bundled in `setup-skills/`, outside the auto-discovered `skills/`, so they run only through `/noblecloak-setup` |
| Hooks | `SessionStart` token refresh; `PreToolUse` governance resolve; `PostToolUse` / subagent event reporting |
| MCP | A committed, **tokenless** `.mcp.json` declaring the gateway. Claude Code owns the live connection via native OAuth — no script writes this file |

## Set up NobleCloak in your project

Run `/noblecloak-setup` in your project. `scripts/setup.mjs` looks at it:

- `next` plus an `app/` or `src/app/` directory: a Next.js App Router app, so one of the module skills (`approvals`, `permissions`, `connections`).
- `@langchain/langgraph` or `langchain` in `package.json`: a LangGraph agent, so the `langgraph` skill.
- Both: you are asked which. Neither: nothing is changed.

Claude asks you to confirm, then follows that skill's `SKILL.md` from `setup-skills/noblecloak-setup-<name>/`. For a LangGraph agent the last step opens a `propose-policy-set` approval; `/noblecloak-setup` runs the skill's `propose.mjs` with your plugin sign-in (the govern-audience user token `/noblecloak-propose-tool` uses) in that process's environment only, and prints the approval id and the approvals address. The command never writes `NC_TOKEN`.

**Where the packages come from.** `setup.mjs` names the public npm registry as the skills' package source (`--source registry`), and each skill's `apply.mjs` installs the `@noblecloak/*` packages it needs from there by name. `--source <dir>` installs instead from tarballs you already have (`noblecloak-<name>-<version>.tgz` files in one directory): `apply.mjs` then records those paths in your `package.json` as `file:` dependencies and overrides, so keep the directory. For a tarball source `setup.mjs` compares each tarball's version with the versions the bundled skills were written against (`setup-skills/SKILLS.lock`) and prints a `WARNING:` and exits 5 when they differ; Claude tells you and asks, and only re-runs with `--accept-version-drift` (exit 0) if you agree.

**For maintainers: the bundled skills are a pinned copy.** The skills are authored once, in the repositories `SOURCES.skills` in `scripts/sync-skills.mjs` names. Never edit `setup-skills/noblecloak-setup-*` in place; `npm test` recomputes the hashes in `setup-skills/SKILLS.lock` and fails on any difference. Keep them out of `skills/`: Claude Code offers anything there on its own, which would skip the package source and the token hand-off `/noblecloak-setup` provides. To update, run the sync at a new full commit sha (fetch the clone first), then commit the changed files and the lock together:

```bash
node scripts/sync-skills.mjs --sha <40-hex commit> [--clone <local clone>]
```

Without `--clone` it reads the commit with `gh api repos/<repo>/tarball/<sha>`. When `SOURCES` names more than one repository, pass `--sha <owner/name>=<40-hex commit>` once per repository (and `--clone <owner/name>=<dir>` for the clones you have). The lock records, per skill, the repository, sha and path it was copied from, and the `@noblecloak/{react,client,theme,langgraph}` versions at those commits. Each skill's `name` frontmatter is kept; only the directory is prefixed.

## Install

Add this repository as a marketplace, then install the plugin from it. From a
local clone (replace the path with where you cloned it):

```text
/plugin marketplace add /path/to/noblecloak-claude-plugin
/plugin install noblecloak@noblecloak
```

Then run `/noblecloak-login`. Both the marketplace and the plugin are named
`noblecloak`.

## State

The plugin keeps its sign-in and undelivered audit records in
`~/.noblecloak/claude-plugin/` (override with `NOBLECLOAK_STATE_DIR`), so a
plugin update or reinstall does not sign you out. `~/.noblecloak/` is shared
with other NobleCloak tools, hence the subdirectory.

**Upgrading from the `bianoble` plugin.** The first session start (or
`/noblecloak-login` or `/noblecloak-status`) moves the old state in, once, when the
new directory has no `auth.json` and no `migrated-from` marker (so
`/noblecloak-logout` stays logged out; it migrates first, then clears). It looks in `NOBLECLOAK_MIGRATE_FROM` (set it if
you moved or renamed your checkout), in `<plugin>/.local`, and in
`~/.claude/plugins/cache/bianoble/bianoble/*/.local`, and moves the files from the
one holding `auth.json` (the explicit path first, otherwise the newest). It keeps
mode `0600`, records the source in `migrated-from`, prints one line naming it,
and never deletes the old directory. It does nothing when `NOBLECLOAK_STATE_DIR`
is set. The OAuth client registered by the old plugin is reused, so the consent
screen keeps showing the old client name ("Claude Code — BiaNoble plugin") until the
client is registered again. The old environment variables are not read
any more: every `BIANOBLE_*` is now `NOBLECLOAK_*`, and `/noblecloak-status` warns
about any `BIANOBLE_*` still set.

## Privacy posture in one paragraph

The hooks match `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebFetch`,
`Agent` and `mcp__*` calls. **Raw tool input never leaves the machine** — only
a SHA-256 digest of the canonicalized input and a deliberately lossy per-tool
summary (`Bash` → first token, `Edit`/`Write` → cwd-relative path, `WebFetch`
→ domain only, everything else → tool name). NobleCloak's own MCP tools skip
the local resolve entirely; they are already governed at the gateway. The
plugin is **audit-only by default** and blocks nothing unless
`NOBLECLOAK_LOCAL_ENFORCE=true`.

Mechanics, failure modes and the audit-record contract:
[`docs/governance-hook.md`](docs/governance-hook.md). Public-facing wording:
[Privacy and governance](https://docs.noblecloak.com/docs/guides/claude-plugin/privacy-and-governance).

## Two credentials, two owners

A recurring source of confusion, worth internalizing before debugging
anything auth-shaped:

- **`~/.noblecloak/claude-plugin/auth.json`** — the governance session, minted by
  `/noblecloak-login`, used by the hooks.
- **Claude Code's native MCP OAuth token** — separate, owned by Claude Code,
  **unreadable from here**.

Both bind whichever organization was default *when they were issued*, and
they are issued at different moments, so they can disagree. This is why
`/noblecloak-status` labels its org line "hooks token" and why fixing a
wrong-org problem needs `/noblecloak-login` **and** an `/mcp` reconnect.

## When governance goes quiet

`/noblecloak-status` is the place to look. It shows whether the hooks are signed in, when
the token expires, the circuit breaker, the local audit queue, and anything dropped or
refused.

- **Signed out.** If the session can't be refreshed (the grant was rejected), the plugin
  says so at session start and on the next tool call, then stops calling NobleCloak until you
  run `/noblecloak-login`. No policy checks or audit delivery happen while you're signed out.
- **Org mismatch.** A Claude Code session's audit belongs to the org you were signed in to
  when it started. After you switch orgs, a resumed session's audit is refused for good; the
  plugin tells you once. Start a new Claude Code session, or sign back in to the original
  org.
- **Queue bounds.** Undelivered audit records are kept for at most 7 days and 2,000
  records. Anything beyond that is dropped, not delivered, and counted in
  `/noblecloak-status`.

Details: [`docs/governance-hook.md`](docs/governance-hook.md).

## Propose a tool and its policy

`/noblecloak-propose-tool` opens an approval request that, once a person
approves it in the NobleCloak approvals module, registers a tool and applies
your policy for it. The command writes no catalog row itself.

```bash
node scripts/propose-tool.mjs --tool-ref mcp__acme__send --level external --policy ask \
  [--description "..."] [--schema schema.json] [--owner org|principal] [--show-arguments]
```

- **Second token.** The proposal goes to the govern API, which is a different
  audience from the gateway. The first run signs you in again (PKCE, with a
  consent screen) for `resource=<govern origin>` and stores that token beside
  the gateway token under `tokens` in `auth.json`; `refresh.mjs` renews both.
  The govern origin is `NOBLECLOAK_GOVERN_URL`, else the gateway host from
  `.mcp.json` with `mcp.` swapped for `govern.`. `/noblecloak-login` replaces
  `auth.json`, so a re-login drops the govern token and the next proposal
  re-consents.
- **Cannot resolve approvals, by design (D-A84).** The token this command
  stores can open proposals and read approvals; it cannot resolve them. Resolving
  (approve, deny, batch) needs the `approvals:resolve` scope, which Core issues
  only when a client asks for it, and the plugin asks for `mcp offline_access`
  only, for every resource including govern. Tests assert that the govern
  sign-in's authorize URL asks for exactly `mcp offline_access`, that no request
  body of the sign-in or of the refresh grant names an approvals scope, and (a
  source scan) that no file under `scripts/` or `commands/` contains `approvals:`. Approving
  happens in the shell's Approvals module (`/approvals`, D-A87) or the standalone
  module, whose sign-in requests the scope.
- **Residual risk (not closed by file permissions).** `auth.json` is written
  `0600`, which keeps other local users out. It does not stop the agent in this
  session, which runs as the same user, from reading the file through a shell.
  A leaked govern token can therefore open proposals, read approvals and
  withdraw approvals you created (COO leaves withdraw, consume and reads
  without the scope gate), but it cannot approve, deny or batch-resolve them.
  Core does not restrict `approvals:resolve` per client (D-A84), so an agent
  that can run a sign-in as you could request it; the Core consent screen,
  which warns about this scope, is the only gate. Never approve a consent
  prompt you did not start. Whether a hook should deny
  reads of `~/.noblecloak/claude-plugin/auth.json` is an open decision for David.
- **Approval link.** The shell serves the approvals module at `/approvals` (D-A87).
  The tab is locked until the Core `approvals` product is entitled for the org.
  When `NOBLECLOAK_APPROVALS_URL` is unset and the govern origin is the beta one
  (`https://govern.beta.shared.bianoble.com`), the script prints
  `Approve it at https://shell.beta.shared.bianoble.com/approvals`. Any other govern
  origin has no default and prints "Approve it in the NobleCloak approvals
  module." Set `NOBLECLOAK_APPROVALS_URL` to override either. The script never
  opens the approval itself.
- **Exit codes.** `0` opened, `2` refused (400/409/413/422; the problem code is printed, e.g.
  `reserved_tool_ref`), `3` not signed in (no session, a 401 which also clears
  the stored approvals token, or consent declined/timed out), `1` anything else
  (network, 5xx, 403, 429, a busy callback port, an unrefreshable token).
- **Policy scope.** The policy applies to the proposing user only, even with `--owner org`: `owner_kind` only sets who owns the registered tool row (an org-owned row is attributed to the approver). A proposal
  can still be refused at approval time (`proposal_refused:<code>`), for
  example a new tool in another enrolled namespace.

## Development

```bash
npm test    # node --test against a local stub HTTP server
```

Environment variables are documented in
[`docs/governance-hook.md`](docs/governance-hook.md).

## Support

[support@noblecloak.com](mailto:support@noblecloak.com)
