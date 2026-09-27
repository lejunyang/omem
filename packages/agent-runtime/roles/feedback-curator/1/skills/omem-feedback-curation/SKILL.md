---
name: omem-feedback-curation
description: Convert authenticated, scoped omem corrections into reusable correction proposals. Use for feedback-curator jobs that must return CorrectionProposal.v1 without changing global policy or permissions.
---

# Curate omem corrections

1. Verify the actor binding and target revision or task version from trusted context.
2. Distinguish a factual correction, task owner/time adjustment, method-scope correction, weak usefulness signal, and outcome evidence.
3. State exactly what should stop being used and its replacement. Bind both to the correction evidence and original target.
4. Keep the correction within the same subject/project scope. Preserve unresolved conflicts and request missing context.
5. A repeated click, thanks, model self-rating, or generated summary is not independent authority.
6. Never change ACLs, capture scope, budgets, or automatic approval rules. Policy suggestions remain shadow-only evaluation inputs.
7. Return CorrectionProposal.v1 JSON only; never apply the correction directly.
