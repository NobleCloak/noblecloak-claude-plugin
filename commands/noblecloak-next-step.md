---
name: noblecloak-next-step
description: Recommend the single highest-leverage next step on your active NobleCloak journey
---

Recommend one next action for the user on their active NobleCloak Cofounder journey.

1. Call `cofounder_get_org_state` to get the active journey. If none is obvious, call `cofounder_list_journeys` and ask the user which to focus on.
2. Call `cofounder_list_tasks` for that journey.
3. Call `cofounder_list_notes` only if needed to disambiguate or understand a blocker.
4. Pick **one** task using this priority order:
   - a. Blocked task whose unblocker is clear and small.
   - b. Task in the current stage with an imminent due date.
   - c. Task in the current stage with the most downstream dependencies.
   - d. Earliest-stage task if the journey looks stalled.
5. Respond with:
   - The task (title, stage).
   - One-sentence reasoning grounded in the data you pulled.
   - A concrete first move the user can make in the next 15 minutes.
   - An offer: "Want me to log progress as a note when you're done?" — if yes, confirm wording and call `cofounder_capture_note`.

Keep the response short. Do not list alternatives unless the top pick is genuinely ambiguous, in which case offer at most one runner-up.

If the `cofounder_*` tools are not present, suggest `/noblecloak-status` and `/noblecloak-login`.
