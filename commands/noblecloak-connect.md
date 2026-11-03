---
name: noblecloak-connect
description: Refresh your NobleCloak governance session (MCP reconnect after entitlement changes is handled by Claude Code)
---

Refresh the NobleCloak governance session token used by the local governance hooks.

Execute this command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/refresh.mjs
```

Important notes:
- The MCP **connection** is managed by Claude Code's native OAuth against the committed `.mcp.json`. This command does **not** re-fetch or rewrite MCP configuration.
- After an entitlement change, the gateway reflects your new entitlements **server-side** on the next tool call — there is no local config to refresh. If tools don't appear, reconnect the `noblecloak` server from Claude Code's `/mcp` (or restart Claude Code).
- If the script reports you're not signed in, or the token is expired beyond refresh, run `/noblecloak-login`.
