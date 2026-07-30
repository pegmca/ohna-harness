/**
 * 多 AbortSignal 合并：对齐 pi-ai `src/utils/abort-signals.ts`。
 * 任一信号中断即中断合并信号，reason 透传。
 */

/** 合并结果：合并后的 signal 与清理函数（移除监听，避免泄漏）。 */
export interface CombinedAbortSignal {
	signal?: AbortSignal;
	cleanup: () => void;
}

/**
 * 合并多个 AbortSignal 为一个。
 * @param signals 待合并的信号列表（可含 undefined）。
 * @returns 合并信号与 cleanup；无有效信号时 signal 为 undefined。
 */
export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (activeSignals.length === 0) {
		return { cleanup: () => {} };
	}
	if (activeSignals.length === 1) {
		return { signal: activeSignals[0], cleanup: () => {} };
	}

	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};

	for (const signal of activeSignals) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		const listener = () => abort(signal);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { signal, listener } of listeners) {
				signal.removeEventListener("abort", listener);
			}
		},
	};
}
