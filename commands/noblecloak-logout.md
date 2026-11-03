---
name: noblecloak-logout
description: Disconnect from NobleCloak (clear your governance session)
---

Disconnect from NobleCloak by clearing the stored governance token.

Execute this command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/logout.mjs
```

This clears the local governance session (`auth.json`), so the governance hooks stop authenticating. The committed MCP server config is left in place — Claude Code manages the MCP **connection** itself, so disconnect the `noblecloak` server from Claude Code's `/mcp` if you also want to drop the live MCP connection. Reconnect anytime with `/noblecloak-login`.
