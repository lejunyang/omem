import { afterEach, expect, test, vi } from "vitest";
import { useUserStateContext } from "./use-user-state-context";
import { useDeviceEmulationContext } from "./use-device-emulation-context";

const hooks = vi.hoisted(() => ({ mounted: [] as Array<() => void> }));
vi.mock("vue", async (load) => ({ ...await load<typeof import("vue")>(), onMounted: (callback: () => void) => hooks.mounted.push(callback), onBeforeUnmount: () => undefined }));
afterEach(() => { vi.unstubAllGlobals(); hooks.mounted = []; });

// 刻意把初始化读取放到“新配置已写入 storage”之后返回，稳定复现 UI 被旧空列表覆盖的竞态。
function delayedStorage() {
  const stored: Record<string, unknown> = {};
  let initial: ((items: Record<string, unknown>) => void) | undefined;
  let first = true;
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true, state: null }) },
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: {
        get: (_keys: unknown, callback: (items: Record<string, unknown>) => void) => {
          if (first) { first = false; initial = callback; } else callback({ ...stored });
        },
        set: (items: Record<string, unknown>, callback: () => void) => { Object.assign(stored, items); callback(); }
      }
    }
  });
  return () => initial?.({});
}

test("late initial user-state read cannot erase the newly created profile", async () => {
  const finishRead = delayedStorage();
  const context = useUserStateContext();
  hooks.mounted[0]();
  await context.addProfile();
  const id = context.selectedProfile.value?.id;
  finishRead();
  await Promise.resolve(); await Promise.resolve();
  expect(context.profiles.value).toHaveLength(1);
  expect(context.selectedProfile.value?.id).toBe(id);
});

test("late initial device read cannot erase a newly saved custom device", async () => {
  const finishRead = delayedStorage();
  const context = useDeviceEmulationContext({ source: "popup", resolveTabId: () => 1 });
  hooks.mounted[0]();
  await context.createProfile();
  const id = context.selectedProfileId.value;
  finishRead();
  await Promise.resolve(); await Promise.resolve();
  expect(context.profiles.value.some((profile) => profile.id === id && !profile.builtin)).toBe(true);
});
