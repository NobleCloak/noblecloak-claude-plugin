---
name: NobleCloak Help
description: Provides contextual help about NobleCloak MCP tools and connection management. Activates when users ask about NobleCloak features, connection status, or available tools.
---

## NobleCloak Connection Management

### The Gateway
NobleCloak connects Claude to a single **COO MCP gateway** that surfaces all entitled tools. Tool names are prefixed to make the domain obvious:

- `core_*` — platform admin (users, orgs, profiles, invitations)
- `commerce_*` — subscriptions, billing, entitlements, catalog
- `int_*` — connected third-party services (Gmail, Calendar, GitHub, …)

### Getting Connected
If MCP tools are not available, guide the user:
1. Run `/noblecloak-login` to authenticate with their NobleCloak workspace
2. Restart Claude Code after login completes
3. NobleCloak tools will then be available in the conversation

### Checking Status
Run `/noblecloak-status` to see:
- Whether the user is connected (governance session)
- Token validity and expiration
- The configured MCP gateway URL (the live MCP connection is owned by Claude Code — see `/mcp`)

### Troubleshooting
- **`Tool '<name>' not found in catalog` on every call?** Almost always an **org mismatch** or a stale session snapshot (org-mismatch class). Every gateway tool call resolves against the catalog of the org your session's token is bound to — and you choose that org on the consent page at login. Run `/noblecloak-status` and read two lines: `Organization (hooks token): <uuid>` (is that the workspace you meant?) and `Catalog: N tools visible` (N=0 ⇒ every dispatch will fail). Fix: re-run `/noblecloak-login` and pick the right org on the consent page (or connect the MCP service in THAT org), then reconnect the MCP server from `/mcp` — the MCP session holds its **own** token (see the two-token note below) and must re-mint too.
- **Tools not showing up?** Run `/noblecloak-login`, then restart Claude Code (the MCP server connects via Claude Code's native OAuth; reconnect from `/mcp` if needed).
- **Token expired?** The plugin auto-refreshes the governance session on session start; you can run `/noblecloak-connect` to force a governance-token refresh. (This does not re-fetch MCP config — there isn't any; MCP reconnect is via `/mcp`.)
- **Wrong organization?** The org is chosen on the consent page at login. Re-run `/noblecloak-login` and pick the right one there, AND reconnect the MCP server from `/mcp` (two separate tokens — both must re-mint).
- **Want to disconnect?** Run `/noblecloak-logout` to clear your governance session. Claude Code owns the MCP connection — disconnect the `noblecloak` server from `/mcp` to drop it.
- **Integration tool says "not connected"?** The user needs to connect the service in the NobleCloak app's settings. Once connected, tools work automatically on next session.

### The Two Tokens (why /noblecloak-status labels the org "hooks token")
The plugin holds TWO independently minted tokens from the same authorization server:
1. **Governance-hooks token** (`~/.noblecloak/claude-plugin/auth.json`, or `$NOBLECLOAK_STATE_DIR/auth.json`; written by `/noblecloak-login`) — drives local policy resolution + audit events.
2. **Claude Code's native MCP OAuth token** — owns the live gateway session (`/mcp`).

Both go through the same consent-page org choice, so they normally bind the same org — but they CAN drift (e.g. default org changed between the two logins): local audits would then run against org A while gateway calls resolve org B's catalog. `/noblecloak-status` can only see the hooks token, so it labels the org accordingly. If the catalog probe succeeds but live MCP calls still fail with "not found in catalog", suspect the seam: reconnect the MCP server from `/mcp` to re-mint its token.

### Available Tool Domains
- **Core**: Users, organizations, profiles, invitations, settings.
- **Commerce**: Subscriptions, billing, entitlements, catalog, metering.
- **Integrations**: Gmail (messages, drafts, send), Google Calendar (events), GitHub (repos, PRs, reviews).
