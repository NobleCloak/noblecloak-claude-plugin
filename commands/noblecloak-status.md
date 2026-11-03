---
name: noblecloak-status
description: Show your NobleCloak connection status (governance session + MCP gateway)
---

Check the current NobleCloak connection status.

Execute this command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs
```

Report the output to the user. The script shows the governance session state (token validity), WHO the session is signed in as and WHICH org the hooks token is bound to, the configured MCP gateway URL, and a live catalog health probe (`Catalog: N tools visible to this session`); the live MCP connection itself is owned by Claude Code (`/mcp`).

Interpretation guide:
- "Not connected" / "Token expired" → suggest `/noblecloak-login`.
- `Catalog: 0 tools visible` → the bound org has no cataloged tools; every tool call will fail with "not found in catalog". Suggest connecting an MCP service in that org, or switching the default org and re-running `/noblecloak-login`, then reconnecting via `/mcp`.
- Wrong `Organization` → the AS binds the default org invisibly; the user should change their default org, re-login, AND reconnect the MCP server from `/mcp` (it holds a separate token).
- `Sign-in: SIGNED OUT since …` → the refresh grant was rejected; the hooks are making no COO calls (no policy checks, no audit delivery). Suggest `/noblecloak-login`.
- `REFUSED for the current org` / `Audit runs refused by COO (tenant_run_mismatch)` → this Claude Code session's audit run was created under a different org than the current sign-in, and COO refuses its events. Suggest starting a new Claude Code session, or signing back in to the original org.
- `Audit breaker: open` → audit delivery to COO is failing (5xx, timeouts, COO refusing the token with 401 even after a refresh, or a 4xx without a recognised permanent code such as a proxy 404 or a gateway 403); events are kept locally and retried.
- `Unshipped records dropped (NOT delivered): N` → the local audit queue hit its bounds (2,000 records / 7 days) and those records were discarded without reaching NobleCloak. Say so plainly.
- `Refused by COO permanently (dead letters): N` → events COO refused with a recognised permanent code (403 `tenant_run_mismatch`, or 400/422 `validation_error`); they are not retried. COO's local-events route does not send `validation_error` today, so in practice these are org mismatches; a malformed event (400 `bad_request`) is kept and retried like any other 4xx. A following `N of them trimmed from the local forensic tail` line means only the newest 256 dead letters are still on disk; the total still counts all of them.
