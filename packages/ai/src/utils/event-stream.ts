/**
 * push 式异步事件流：对齐 pi-ai `src/utils/event-stream.ts` 原样移植。
 * agent loop 与 UI 都消费它；`result()` 在流终止事件时 resolve 出最终结果。
 */
import type { AssistantMessage, AssistantMessageEvent } from "../types.js";

/** 通用事件流：内部队列 + waiting 双模式的 AsyncIterable。 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	/**
	 * @param isComplete 判断事件是否为终止事件（终止时锁定流并 resolve 最终结果）。
	 * @param extractResult 从终止事件提取最终结果。
	 */
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

/**
 * 推入一个事件；终止事件会标记流结束并 resolve `result()`。
 * 注意单消费者语义：每个事件只投递给一个等待者（waiting.shift()），
 * 多个消费者并发迭代会互相抢事件，需要扇出时请在上层自行分发。
 * @param event 待分发的事件。
 */
	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// 有等待中的消费者直接交付，否则入队。
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/**
	 * 结束流，唤醒所有等待中的消费者。
	 * @param result 可选的最终结果（用于没有终止事件的场景）。
	 */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as T, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/**
	 * 最终结果的 Promise：在 done/error 终止事件时 resolve。
	 * @returns 终止事件携带的最终结果。
	 */
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/** EventStream 特化：done → message，error → error（均为最终 AssistantMessage）。 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/**
 * AssistantMessageEventStream 工厂（供扩展方使用）。
 * @returns 新的事件流实例。
 */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
