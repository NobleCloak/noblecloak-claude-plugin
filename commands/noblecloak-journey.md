---
name: noblecloak-journey
description: List your NobleCloak journeys, or show a specific one by title
---

List or inspect the user's NobleCloak Cofounder journeys through the COO MCP gateway.

If the user supplied an argument, treat it as a journey title fragment.

**No argument:**
1. Call `cofounder_list_journeys`.
2. Show a compact table: title, status, current stage, updated-at.
3. Ask which one the user wants to dig into, or suggest `/noblecloak-next-step` for the active one.

**Argument given:**
1. Call `cofounder_list_journeys` and fuzzy-match the argument against titles.
   - One match: proceed with that journey.
   - Multiple matches: list candidates and ask the user to pick.
   - No match: show all journeys and ask.
2. For the chosen journey, call `cofounder_list_tasks` (scoped to that journey id) and `cofounder_list_notes`.
3. Summarize:
   - title, status, current stage
   - task counts by status (open / in_progress / blocked / completed)
   - top 3 open tasks
   - most recent note if any
4. Offer follow-ups: `/noblecloak-tasks` for the full task list, `/noblecloak-next-step` for a recommendation.

If the `cofounder_*` tools are not present, suggest `/noblecloak-status` and `/noblecloak-login`.
