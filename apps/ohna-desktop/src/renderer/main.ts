interface SpikeApi {
  ping(): Promise<string>;
}

declare global {
  interface Window {
    spike: SpikeApi;
  }
}

const statusElement = document.querySelector<HTMLParagraphElement>("#status");

/**
 * 显示 preload 探活结果，验证 sandbox 到 utilityProcess 的完整链路。
 *
 * @returns 页面更新完成后的 Promise。
 */
async function showWorkerStatus(): Promise<void> {
  if (!statusElement) {
    return;
  }

  try {
    statusElement.textContent = await window.spike.ping();
  } catch (error) {
    statusElement.textContent = error instanceof Error ? error.message : "utility process unavailable";
  }
}

void showWorkerStatus();

export {};
