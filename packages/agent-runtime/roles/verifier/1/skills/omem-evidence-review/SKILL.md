---
name: omem-evidence-review
description: Verify whether fixed omem evidence supports scoped memory or task proposals. Use for independent verifier jobs that receive candidates plus original evidence and must return AssessmentBatch.v1 without approving changes.
---

# Review omem evidence

1. Recheck exact quote or image identity before semantic review. An invalid or ambiguous deterministic check cannot become `supported`.
2. Compare subject, scope, time, conditions, negation, attribution, and intended strength between evidence and proposal.
3. Distinguish owner commitments from forwarded speech, suggestions, and statements by unknown actors.
4. Check supplied current memories for contradictions and later corrections. Preserve conflicts rather than selecting by confidence of wording.
5. Treat OCR and image descriptions as inferred unless the supplied image is independently readable.
6. Do not infer overall success from a successful tool step or correlation from causation.
7. Return AssessmentBatch.v1 JSON only. Never approve, apply, execute, message, or change policy.
