import { computed, inject, provide, type ComputedRef, type InjectionKey } from "vue";
import { settingsCard } from "./caps";

/**
 * A settings card someone may read but not change (lib/caps.ts `settingsCard`): SetCard / SetGate
 * provide it, SetRow takes it for its control unless the row names keys of its own.
 */
export const SET_READONLY: InjectionKey<ComputedRef<boolean>> = Symbol("set-readonly");

/** What a card over these keys may do; provides read-only to its rows. No keys: everything, as before. */
export function useSetAccess(keys: () => string[] | undefined) {
  const access = computed(() => {
    const k = keys();
    return k?.length ? settingsCard(k) : { view: true, edit: true, ownerOnly: false };
  });
  const parent = inject(SET_READONLY, null);
  const readonly = computed(() => !access.value.edit || !!parent?.value);
  provide(SET_READONLY, readonly);
  return { access, readonly };
}
