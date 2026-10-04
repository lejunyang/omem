---
name: omem-evidence-review
description: Verify whether fixed omem evidence supports scoped memory or task proposals. Use for independent verifier jobs that receive candidates plus original evidence and must return AssessmentBatch.v1 without approving changes.
---

# Review omem evidence

1. Recheck exact quote or image identity before semantic review. An invalid or ambiguous deterministic check cannot become `supported`.
2. Compare subject, scope, time, conditions, negation, attribution, and intended strength between evidence and proposal.
   Check populated valid_from and valid_to separately: a deadline or observed-at timestamp does not establish a state's validity interval. Reject an unsupported bound even if the statement is accurate; retain explicitly bounded temporary states and explicit effective changes. Explain which bound should remain unknown instead of discarding the useful fact. Do not infer completion merely because a deadline has passed.
3. Distinguish owner commitments from forwarded speech, suggestions, and statements by unknown actors. Check whether the proposal belongs to facts or personal tasks: another person's responsibility/deadline is a scoped claim, not the owner's task. A report by the verified owner does not change who is responsible or authorize personal tracking. Tasks require the owner's own commitment or explicit tracking request and the exact trusted owner ID; a named person's missing internal ID alone does not undermine an attributed factual claim.
4. Check current memories for contradictions and later corrections. In native research, independently read the earlier original and new input, using read_fragments for exact quotes/provenance and read_memory for versions. A later separate message can update an active memory; retain unchanged conditions and separate projects. Preserve unresolved conflicts rather than selecting by confidence of wording.
5. Treat OCR and image descriptions as inferred unless the supplied image is independently readable.
6. Do not infer overall success from a successful tool step or correlation from causation.
7. In native research submit_result with AssessmentBatch.v1; otherwise return the JSON directly. Never approve, apply, execute, message, or change policy. Investigation tools may read originals and derived context, but derived bodies are not independent evidence.
8. For an update, distinguish an established amendment of the same fact from unresolved disagreement: set update_relation to amends, conflicts, or unclear and explain why. Recency alone does not establish an amendment. Do not require user confirmation merely because a clear change arrived as a separate message.
9. Assess all candidate uncertainties, not just the quoted sentence. Set uncertainty_review to non_blocking with a reason only when none affects the proposed fact/action, its actor, scope, time, conditions or authority. Unknown background can coexist with a supported narrow fact; uncertain subject, applicability, effective time or authorization cannot. Use unresolved for a material doubt, even one you discovered yourself. Reserve missing_context for information necessary to establish this proposal, not every question one could ask about the source. Keep the original doubts in the candidate; this review explains their effect rather than erasing them.
