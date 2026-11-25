import type { App } from "../core/app.ts";
import { notify } from "../core/notify.ts";
import { HttpError } from "../core/util.ts";

/** An actual state change can cite a message the owner was already reminded about. */
export function notifyChange(app: App, input: Parameters<typeof notify>[1]) {
  const notice = { ...input, urgency: "later" as const, plain: true, graceDone: true };
  try { return notify(app, notice); }
  catch (e) {
    if (!(e instanceof HttpError) || e.status !== 409) throw e;
    // The references have passed validation. Keep the links in the body of a plain notification.
    return notify(app, { ...notice, entityId: undefined, sourceRefs: [] });
  }
}
