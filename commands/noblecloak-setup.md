---
name: noblecloak-setup
description: Set up NobleCloak in your project — wire the Approvals, Permissions or Connections module into a Next.js app, or put a LangGraph agent under governance
---

Set up NobleCloak in the project the user is working in. The setup skills are bundled with this plugin (`${CLAUDE_PLUGIN_ROOT}/setup-skills/noblecloak-setup-*`, outside the plugin's auto-discovered `skills/`, so they run only through this command); this command finds out which one applies, then you follow it.

1. Work out what the project is. Run this from the project's root (it writes nothing into the project):

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs
   ```

   It prints what it found, the candidate skill(s) with the path of each `SKILL.md`, and the `--source` to pass to the skill's `apply.mjs`: `registry` by default (the public npm registry, where the `@noblecloak/*` packages are published), or the directory of tarballs the user ran it with (`--source <dir>`). Exit codes:
   - 0: at least one candidate can run.
   - 5: a candidate can run, but a `WARNING:` line says a tarball's package version differs from the one the bundled skills were written against (a `--source <dir>` run only). Do not run a skill. Tell the user what it says and ask whether to continue; only if they agree, re-run the same command with `--accept-version-drift` (it prints the same output and exits 0), then go to step 2. If they decline, stop.
   - 2: the project is neither a Next.js App Router app nor a LangGraph project. Tell the user; do not guess or force a skill.
   - 4: a candidate is blocked because the `--source <dir>` directory lacks a package tarball (the output says which). Tell the user what the output says and stop; do not run that skill.
   - 1: anything else. Relay the printed cause; do not retry in a loop or fall back to another source.

2. Ask the user to confirm before changing anything. Say what you found and which skill you will run.
   - A Next.js App Router app: the module skills are `approvals`, `permissions` and `connections`. Ask which of them to set up (one at a time).
   - A LangGraph agent: the `langgraph` skill.
   - Both: ask which one to set up first.

3. For langgraph, before the skill asks for a service principal credential and id: if the user has none, offer to create it (they must administer the organization; the plugin must be signed in). It signs them in as admin with a link, then prints the credential path, the principal id and the three env lines the skill needs:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs service-principal
   ```

   Optional `--name`, `--out` (outside any git repository) and `--expires-in-days`. Never read or print the credential file. Exit 3: the plugin is not signed in, run `/noblecloak-login`; 5: the administrator sign-in the CLI opened did not complete (failed, timed out or cancelled), re-run and complete the browser sign-in as an administrator; 4: not an administrator; 1: relay the printed cause and run the command it prints, if any, as printed (an interrupted create may have made a principal, and `sp list` shows it; a created-but-unsaved one is revoked with the printed `sp revoke` command), and do not re-run the create until that is settled.

4. Read the chosen skill's `SKILL.md` (the path the command printed) and follow it exactly. It says what to ask the user (the API origin, and for langgraph the agent's service principal credential and id), which script to run and what to write. Wherever it says `node <this skill's directory>/scripts/apply.mjs`, use the skill's bundled directory and add `--source <what the command printed>` (`registry`, or the tarball directory). Do not edit the bundled skill files: they are a pinned copy.

5. Rules that hold for every skill:
   - Never write `NC_TOKEN`, and never run the agent on a user token.
   - For langgraph, if the user has only a user token and no service principal credential, stop as the skill says.

6. For langgraph, the skill's last step opens the `propose-policy-set` approval with `propose.mjs`. Run it through this command instead of calling `propose.mjs` directly, so the plugin supplies the user's own token (the same govern-audience sign-in `/noblecloak-propose-tool` uses; the first run opens a browser sign-in with a consent screen, which is expected). Check the plan first, then run for real:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs propose --plan <plan.json> --dry-run
   node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs propose --plan <plan.json>
   ```

   The token is passed to `propose.mjs` in its environment only. Never put it on a command line or in a file, and do not ask the user to paste one. The destination (`NC_BASE_URL` or `--base-url`, the module API origin the user gave you) must be set and must be the same origin the sign-in is for; the command never defaults it, and refuses with exit 1 (before getting a token) when it is missing or differs, so relay that message rather than working around it. `propose.mjs` prints the approval id and the address of the approvals module; relay both. Exit codes are `propose.mjs`'s own (0 opened, 2 plan refused, fix the plan and re-run), plus 3 when the plugin is not signed in (run `/noblecloak-login`) or the deployment did not accept the token (the command has cleared the stored token, so re-running signs in again), and 1 for any other failure (relay the printed cause).

7. When the source was a tarball directory, do not delete it. The skill's `apply.mjs` records the tarball paths in the project's `package.json`, so the project installs from them until it moves to registry versions. With the registry source nothing is recorded but ordinary package versions.

Tell the user what happens next as the skill says: nothing is registered or published until an administrator approves.
