---
name: NobleCloak Journey & Task Work
description: Use when the user is working with their NobleCloak Cofounder journeys, stages, or tasks — reviewing progress, picking a next step, unblocking work, logging notes, or triaging a backlog. Activates on mentions of "journey", "stage", "task", "blocker", "next step", "progress review", "weekly review", "what should I work on", or when a Cofounder journey/task is already in conversation context. Teaches how to reach for the cofounder_* MCP tools through the NobleCloak (COO) MCP gateway and how to interpret the data they return.
---

# NobleCloak Journey & Task Work

You are helping the user make progress on their business with NobleCloak Cofounder. This skill gives you the domain fluency to work effectively with their journey and task data through the Cofounder tools that the plugin exposes.

## Gateway Model

All NobleCloak AI tooling reaches Claude through the **COO MCP gateway**. When the user is connected, journey/task tools arrive with a `cofounder_` prefix alongside integration tools (`int_*`, e.g. Gmail/Calendar/GitHub) and Core admin tools (`core_*`). The gateway handles auth, governance, confirmation gates on write operations, and audit logging — you do not need to re-implement any of that. You just need to pick the right tool and call it with the right arguments.

If you see only `int_*` or only `core_*` tools and no `cofounder_*` tools, the user's workspace may not have the Cofounder product entitled, or their session needs refresh — guide them to `/noblecloak-status` then `/noblecloak-login`.

## Data Model Primer

NobleCloak Cofounder organizes planning work as a hierarchy:

- **Journey** — a long-running, goal-oriented plan (e.g. "Launch v1", "Achieve product-market fit", "Hire first engineer"). One user can have several journeys active at once, but usually one is the focus.
- **Stage** — a phase inside a journey with its own objective (e.g. "Discovery", "Design", "Build", "Launch"). Stages are ordered; a journey has a current stage.
- **Task** — an actionable item inside a stage. Tasks have a `status` lifecycle: `open` → `in_progress` → `blocked` / `completed` / `cancelled`. Tasks can have due dates, owners, and linked notes.
- **Note** — a timestamped free-form observation or update attached to a journey, stage, or task.
- **Knowledge doc** — a longer-form reference document in the user's workspace.

The user's *active* journey is usually implicit. When unclear, list journeys first and disambiguate by title or recency.

## Tool Map (via COO MCP Gateway)

When connected, these tools are available. Names are what the gateway surfaces; action scopes listed for reference.

### Read (no confirmation needed)

| Goal | Tool | Scope |
|---|---|---|
| Overview of planning state | `cofounder_get_org_state` | `cofounder:get-org-state` |
| List all journeys | `cofounder_list_journeys` | `cofounder:list-journeys` |
| List tasks across a journey | `cofounder_list_tasks` | `cofounder:list-tasks` |
| List notes | `cofounder_list_notes` | `cofounder:list-notes` |
| Search the user's captured knowledge | `cofounder_search_knowledge` | `cofounder:search-knowledge` |
| List knowledge docs | `cofounder_list_knowledge_docs` | `cofounder:list-knowledge-docs` |

### Write (the gateway enforces a confirmation gate; you should also confirm in plain language)

| Goal | Tool | Scope |
|---|---|---|
| Mark a task complete | `cofounder_complete_task` | `cofounder:complete-task` |
| Log a note on a journey/stage/task | `cofounder_capture_note` | `cofounder:capture-note` |

### Admin (only if the user is an admin in this org)

| Goal | Tool | Scope |
|---|---|---|
| Enable an agent on the org | `cofounder_enable_agent` | `cofounder:enable-agent` |

**Things you may wish for that do not exist as tools today:** single-journey fetch, single-task fetch, artifact generation. Work around this by filtering the list results — e.g. to inspect one journey, call `cofounder_list_journeys`, pick the target id, then call `cofounder_list_tasks` and `cofounder_list_notes` scoped to it. If the user asks for an artifact, point them to the Cofounder app tab.

## Common Workflows

### Daily "what should I do?"
1. Call `cofounder_get_org_state` for a quick read on the active journey and cadence.
2. If that doesn't resolve the journey, call `cofounder_list_journeys` and pick by recency or user prompt.
3. Call `cofounder_list_tasks` with the journey id and an `open`-status filter if the tool supports it (otherwise filter client-side).
4. Rank by: (a) blocked dependencies — surface blockers first, (b) due date, (c) stage position — prioritize current stage.
5. Propose the single highest-leverage task. State *why* — e.g. "Blocking two downstream tasks" or "Due tomorrow".

### Weekly review
1. List journeys, pick the focus one (confirm with the user if multiple).
2. Pull tasks for that journey; separate into "completed recently" vs "open" vs "blocked".
3. Pull recent notes via `cofounder_list_notes`.
4. Summarize: wins, blockers, what shifted, recommended next-week focus. Offer to log the summary via `cofounder_capture_note`.

### Unblock a task
1. Pull the tasks list and the journey's notes for context.
2. Ask the user what the blocker is, if unclear from notes.
3. Propose concrete unblock steps (a note update, a dependency reorder, an external message to draft, a search of captured knowledge via `cofounder_search_knowledge`).
4. Only mutate state after user confirmation.

### Log progress
1. Ask what to capture.
2. Draft the note concisely (1-3 sentences).
3. Confirm the wording.
4. Call `cofounder_capture_note` with the journey/stage/task reference.

## Judgment Rules

- **Confirm before side effects.** `cofounder_complete_task` and `cofounder_capture_note` are writes. Show the user what you're about to do and wait for acknowledgment, unless they've explicitly pre-authorized. The gateway will also gate these, but confirming in plain language is better UX.
- **Prefer the smallest useful answer.** Don't dump a journey's full task list when the user asked "what's my next step" — identify the single highest-leverage item.
- **Ground claims in data.** Never say "you completed X this week" without having seen it in a tool response. If you're not sure, say so and offer to look.
- **Handoff to the product when appropriate.** If the user needs heavy editing, artifact generation, or teammate collaboration, point them to their Cofounder app tab rather than trying to do it all through the MCP surface.
- **Respect the user's current focus.** If they named a specific journey or task, do not broaden scope without being asked.

## If Tools Are Missing

If the `cofounder_*` tools are not present in this session:

- Check connection: suggest `/noblecloak-status`.
- If not connected, suggest `/noblecloak-login`.
- If connected but only integration (`int_*`) tools are visible, the workspace may not have the Cofounder product entitled — tell them and point to `app.beta.shared.bianoble.com/setup`.

Do not guess or fabricate journey/task data.
