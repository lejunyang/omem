/** Compare scores only within one model's evaluated subset. With partial work,
 * replace evaluated slots in fallback order; untouched slots stay in place.
 * No synthetic zero score or uncalibrated blend with retrieval scores is needed. */
export function evaluatedOrder<T>(
  hits: T[],
  score: (hit: T) => number | undefined,
): T[] {
  const evaluated = hits
    .flatMap((hit, index) => {
      const value = score(hit);
      return value === undefined ? [] : [{ hit, index, value }];
    })
    .sort((a, b) => b.value - a.value || a.index - b.index);
  let next = 0;
  return hits.map((hit) =>
    score(hit) === undefined ? hit : evaluated[next++]!.hit,
  );
}

/** A qualified positive judgment may move ahead of unread fallback slots.
 * Unread candidates remain available; this does not compare unrelated scales. */
export function promotedOrder<T>(
  hits: T[],
  score: (hit: T) => number | undefined,
  promote: (hit: T) => boolean,
): T[] {
  return [
    ...evaluatedOrder(hits.filter(promote), score),
    ...evaluatedOrder(
      hits.filter((hit) => !promote(hit)),
      score,
    ),
  ];
}
