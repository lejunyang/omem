import { computed } from "vue";
import { useRoute } from "vue-router";

/**
 * A route param of one page (`/runs/:id`). While the router has already moved to another page and
 * this one is not yet unmounted, it keeps its last value: otherwise the page would load the next
 * page's id as its own (a run id fetched as a requirement, “需求点不存在”).
 *
 * `page` is the page's first path segment (`runs`), or, for pages under a shared one (the tabs of
 * 编码), the router pattern of its own route (`/code/reqs/:id?`).
 */
export function pageParam(page: string, name = "id") {
  const route = useRoute();
  const mine = page.startsWith("/") ? () => route.matched.at(-1)?.path === page : () => route.path.split("/")[1] === page;
  let last = "";
  return computed(() => {
    if (mine()) last = (route.params[name] as string | undefined) || "";
    return last;
  });
}
