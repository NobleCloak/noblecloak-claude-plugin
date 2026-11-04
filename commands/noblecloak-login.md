---
name: noblecloak-login
description: Log in to your NobleCloak workspace
---

Run the NobleCloak OAuth login script to authenticate your workspace.

If you do not have a NobleCloak account yet, signing in creates one, with a personal workspace.

Execute this command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/login.mjs $ARGUMENTS
```

Staff of an organisation that signs in with corporate SSO: `/noblecloak-login you@yourcompany.com`.

This will:
1. Open your browser to the NobleCloak login page
2. After you authenticate, store your NobleCloak governance session locally (used by the local governance hooks)
3. The NobleCloak MCP server connects via Claude Code's **native OAuth** — restart Claude Code, then check `/mcp`. Because login and the MCP connection share the same authorization server, the MCP authorization is usually a one-click (or silent) redirect.

If the browser doesn't open automatically, the script will print a URL you can visit manually.
