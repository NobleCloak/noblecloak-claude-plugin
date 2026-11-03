---
name: noblecloak-propose-tool
description: Propose a tool and its policy for approval in your NobleCloak workspace
---

Propose a tool, and the policy you want for it, as an approval request. A person approves it in the NobleCloak approvals module; only then is the tool registered and the policy applied. This command never writes a catalog row itself.

First collect the proposal from the user in conversation. Ask for anything missing:

- `tool_ref` (required): the tool's reference, for example `mcp__acme__send_email`. It must not start with `tool:noblecloak:` (reserved).
- side-effect level (required): one of `read`, `write`, `delete`, `external`, `admin`.
- policy (required): `ask`, `always_allow` or `deny`. It applies to the proposing user only, not the whole organization, whichever `owner_kind` you choose: `owner_kind` only sets who owns the registered tool row.
- optional: a description, a JSON input schema, owner `org` or `principal`, and whether approvers should see the call arguments.

Then write the collected values to a JSON file with the Write tool (named `noblecloak-proposal-<random>.json` in the operating-system temp directory. Use a unique name, never the working directory (it may be a tracked or shared location) and never the plugin directory. The script deletes a file with that name as soon as it has read it). Do not put any user- or tool-supplied text on the shell command line: descriptions can come from untrusted tool metadata and a shell would expand them. The file's members are `tool_ref`, `side_effect_level`, `policy`, and optionally `description`, `input_schema` (an object), `owner_kind` and `show_arguments_to_approvers` (boolean). Then run the script once, pointing at that file:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/propose-tool.mjs --file <proposal.json>
```

Report the script's output to the user as printed. The first run opens a browser sign-in with a consent screen for the approvals API; that is expected. Interpretation:

- Exit 0: the approval was opened. Relay the approval id and the approval line; do not try to open anything yourself.
- Exit 2: the proposal input was refused (invalid, reserved, in use, conflicting or too large); relay the problem code and fix the input with the user, then re-run.
- Exit 3: not signed in (no NobleCloak session, a rejected approvals token, or the consent screen was declined or timed out); run `/noblecloak-login` if there is no session, otherwise re-run to repeat the approvals sign-in.
- Any other exit: a deployment-side refusal (for example `approval_unroutable`: the deployment cannot route tool proposals yet, so changing the input will not help), or a network, server, access (403), rate-limit or local sign-in problem (for example the callback port is busy); tell the user the printed cause and do not retry in a loop.
