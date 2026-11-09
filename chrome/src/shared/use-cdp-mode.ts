import { onBeforeUnmount, onMounted, ref } from "vue";
import { CDP_MODE_STORAGE_KEY, type CdpMode, DEFAULT_CDP_MODE, loadCdpMode, normalizeCdpMode, saveCdpMode } from "./cdp-mode";

/** popup、面板、侧栏共用：读取并订阅「CDP 增强」开关，任一处切换其他界面立即跟着变。 */
export function useCdpMode() {
  const mode = ref<CdpMode>(DEFAULT_CDP_MODE);
  const loaded = ref(false);

  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && CDP_MODE_STORAGE_KEY in changes) {
      mode.value = normalizeCdpMode(changes[CDP_MODE_STORAGE_KEY].newValue);
    }
  };

  onMounted(async () => {
    mode.value = await loadCdpMode();
    loaded.value = true;
    chrome.storage.onChanged.addListener(onChanged);
  });
  onBeforeUnmount(() => chrome.storage.onChanged.removeListener(onChanged));

  async function setMode(next: CdpMode): Promise<void> {
    mode.value = next;
    await saveCdpMode(next);
  }

  return { mode, loaded, setMode };
}
