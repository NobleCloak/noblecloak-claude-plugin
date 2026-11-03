---
name: noblecloak-tasks
description: Show open tasks for your active NobleCloak journey, grouped by stage
---

Show the user's open tasks through the COO MCP gateway, scoped to the active journey (or a specified one).

If the user supplied an argument, treat it as a journey title fragment.

**Resolve the journey:**
1. If an argument was given, fuzzy-match it against `cofounder_list_journeys`; pick the best match or ask.
2. If no argument, call `cofounder_get_org_state` to identify the active journey. If unclear, call `cofounder_list_journeys` and ask the user which one.

**Show the tasks:**
1. Call `cofounder_list_tasks` for the chosen journey.
2. Group tasks by stage, keeping stage order.
3. For each stage, show:
   - stage name
   - open tasks as a short list: title, due date (if any), ⚠ marker if blocked
4. At the end, surface counts: total open, blocked, completed-this-week (if timestamps available).
5. Offer `/noblecloak-next-step` to get a recommendation on what to tackle first.

Do not call any write tools from this command. If the user asks to complete a task mid-flow, confirm the specific task first, then call `cofounder_complete_task`.

If the `cofounder_*` tools are not present, suggest `/noblecloak-status` and `/noblecloak-login`.
