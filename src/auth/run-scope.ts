/** The same SQL predicate serves indexed object lookups, lists, and related coding rounds. */
export type RunAudience = { userId: string; spaces: string[]; ownSpaces?: string[]; empty?: boolean; ownUnscoped?: boolean };
export function runPredicate(viewer: RunAudience, alias = "runs") {
  const covered = (own: boolean) => {
    const scope = alias + ".scope";
    const within = "in (select value from json_each(?))";
    return `((${alias}.space_id is null or ${alias}.space_id ${within})
      and (${scope} is not null or ${own && viewer.ownUnscoped !== false ? 1 : 0})
      and (coalesce(json_array_length(${scope}),0)>0 or ${own || viewer.empty ? 1 : 0})
      and not exists (select 1 from json_each(${scope}) j where j.value not ${within}))`;
  };
  const own = JSON.stringify(viewer.ownSpaces ?? viewer.spaces);
  const shared = JSON.stringify(viewer.spaces);
  return { sql: `((coalesce(${alias}.user_id,'owner')=? and ${covered(true)}) or ${covered(false)})`, params: [viewer.userId,own,own,shared,shared] };
}
