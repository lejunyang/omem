import { computed } from "vue";
import { useRoute } from "vue-router";

/**
 * A route param of one page (`/reqs/:id`). While the router has already moved to another page and
 * this one is not yet unmounted, it keeps its last value: otherwise the page would load the next
 * page's id as its own (a run id fetched as a requirement, “需求点不存在”).
 */
export function pageParam(section: string, name = "id") {
  const route = useRoute();
  let last = "";
  return computed(() => {
    if (route.path.split("/")[1] === section) last = (route.params[name] as string | undefined) || "";
    return last;
  });
}
