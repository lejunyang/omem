---
name: omem-task-planning
description: Propose bounded, evidence-linked next steps for an existing omem task. Use for planning jobs that must return PlanProposal.v1 and must not execute tools or external actions.
---

# Plan bounded next steps

1. Separate the goal, verified current state, prerequisites, dependencies, blockers, and unknowns.
2. Propose only `gather_context`, `draft_document`, `break_down_task`, `suggest_reminder`, or `request_decision` actions.
3. For each step, cite input evidence, state the expected artifact, define verification, say whether owner approval is required, and give a stop condition.
4. Do not mark unknown work complete. Do not invent deadlines; preserve timezones and source wording.
5. External messages, code changes, deployments, and data changes remain proposals requiring a separate executor and authorization.
6. Return PlanProposal.v1 JSON only. Never perform a proposed action or broaden scope.
