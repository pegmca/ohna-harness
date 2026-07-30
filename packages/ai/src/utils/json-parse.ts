/**
 * 流式 JSON 容错解析：对齐 pi-ai `src/utils/json-parse.ts`。
 * 用于流式 toolCall 参数的增量解析——三级容错，永不抛错，失败返回 {}。
 *
 * 与 pi 的刻意差异：pi 依赖 `partial-json` 包做截断容错；本包要求零依赖，
 * 因此内联了一个等价的栈无关递归容错解析器（`partialParse`）。
 */

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * 判断字符是否为 JSON 字符串中必须转义的控制字符。
 * @param char 单个字符。
 * @returns 是控制字符返回 true。
 */
function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

/**
 * 把控制字符转成 JSON 转义序列。
 * @param char 控制字符。
 * @returns 转义后的字符串。
 */
function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * 修复畸形 JSON 字符串字面量：转义字符串内的裸控制字符、把非法转义前的反斜杠加倍。
 * @param json 原始 JSON 文本。
 * @returns 修复后的 JSON 文本。
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
				// 非法 \u 转义（如 \x 或截断的 \u12）：与其他非法转义一样双写反斜杠，
				// 否则原样拷贝后 JSON.parse 仍会失败。
				repaired += "\\\\";
				continue;
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

/**
 * 先直接 JSON.parse，失败后修复字符串字面量再 parse。
 * @template T 期望的解析结果类型。
 * @param json JSON 文本。
 * @returns 解析结果；彻底失败时抛错。
 */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/** 内部信号：输入在解析中途被截断（区别于真正的语法错误）。 */
class Truncated extends Error {}

/**
 * 跳过空白。
 * @param text 输入文本。
 * @param index 起始下标。
 * @returns 第一个非空白字符下标。
 */
function skipWhitespace(text: string, index: number): number {
	while (index < text.length && /\s/.test(text[index])) index++;
	return index;
}

/**
 * 解析 JSON 字符串字面量；截断时抛 Truncated。
 * @param text 输入文本。
 * @param index 起始引号之后的下标。
 * @returns [解析出的字符串, 结束下标]。
 */
function parseString(text: string, index: number): [string, number] {
	let output = "";
	while (index < text.length) {
		const char = text[index];
		if (char === '"') return [output, index + 1];
		if (char === "\\") {
			const next = text[index + 1];
			if (next === undefined) throw new Truncated();
			if (next === "u") {
				const digits = text.slice(index + 2, index + 6);
				if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Truncated();
				output += String.fromCharCode(Number.parseInt(digits, 16));
				index += 6;
				continue;
			}
			const escapes: Record<string, string> = {
				'"': '"',
				"\\": "\\",
				"/": "/",
				b: "\b",
				f: "\f",
				n: "\n",
				r: "\r",
				t: "\t",
			};
			if (!(next in escapes)) throw new Error(`Invalid escape: \\${next}`);
			output += escapes[next];
			index += 2;
			continue;
		}
		output += char;
		index++;
	}
	throw new Truncated();
}

/**
 * 解析 JSON 对象；子值截断时丢弃未完成的对、返回已解析部分。
 * @param text 输入文本。
 * @param index "{" 之后的下标。
 * @returns [解析出的对象, 结束下标]。
 */
function parseObject(text: string, index: number): [Record<string, unknown>, number] {
	const result: Record<string, unknown> = {};
	let i = index;
	for (;;) {
		i = skipWhitespace(text, i);
		// 对之间遇 EOF：容器被截断，返回已解析部分。
		if (i >= text.length) return [result, i];
		if (text[i] === "}") return [result, i + 1];
		if (text[i] !== '"') throw new Error(`Expected object key at ${i}`);
		let key: string;
		try {
			[key, i] = parseString(text, i + 1);
			i = skipWhitespace(text, i);
			if (text[i] !== ":") throw i >= text.length ? new Truncated() : new Error(`Expected ":" at ${i}`);
			const [value, next] = parseValue(text, i + 1);
			result[key] = value;
			i = skipWhitespace(text, next);
		} catch (error) {
			// 未完成的对（键截断/值截断/尾逗号后截断）整体丢弃。
			if (error instanceof Truncated) return [result, i];
			throw error;
		}
		if (i >= text.length) return [result, i];
		if (text[i] === ",") {
			i++;
			continue;
		}
		if (text[i] === "}") return [result, i + 1];
		throw new Error(`Expected "," or "}" at ${i}`);
	}
}

/**
 * 解析 JSON 数组；元素截断时丢弃未完成的元素、返回已解析部分。
 * @param text 输入文本。
 * @param index "[" 之后的下标。
 * @returns [解析出的数组, 结束下标]。
 */
function parseArray(text: string, index: number): [unknown[], number] {
	const result: unknown[] = [];
	let i = index;
	for (;;) {
		i = skipWhitespace(text, i);
		// 元素之间遇 EOF：数组被截断，返回已解析部分。
		if (i >= text.length) return [result, i];
		if (text[i] === "]") return [result, i + 1];
		try {
			const [value, next] = parseValue(text, i);
			result.push(value);
			i = skipWhitespace(text, next);
		} catch (error) {
			if (error instanceof Truncated) return [result, i];
			throw error;
		}
		if (i >= text.length) return [result, i];
		if (text[i] === ",") {
			i++;
			continue;
		}
		if (text[i] === "]") return [result, i + 1];
		throw new Error(`Expected "," or "]" at ${i}`);
	}
}

/**
 * 解析任意 JSON 值；字面量前缀截断视为 Truncated。
 * @param text 输入文本。
 * @param index 起始下标。
 * @returns [解析出的值, 结束下标]。
 */
function parseValue(text: string, index: number): [unknown, number] {
	const i = skipWhitespace(text, index);
	if (i >= text.length) throw new Truncated();
	const char = text[i];
	if (char === "{") return parseObject(text, i + 1);
	if (char === "[") return parseArray(text, i + 1);
	if (char === '"') return parseString(text, i + 1);
	for (const [literal, value] of [
		["true", true],
		["false", false],
		["null", null],
	] as const) {
		if (text.startsWith(literal, i)) return [value, i + literal.length];
		// 输入是字面量的前缀 → 截断而非语法错误。
		if (literal.startsWith(text.slice(i)) && text.slice(i).length > 0) throw new Truncated();
	}
	const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
	if (numberMatch) return [Number(numberMatch[0]), i + numberMatch[0].length];
	if (/^-?$/.test(text.slice(i))) throw new Truncated();
	throw new Error(`Unexpected token at ${i}`);
}

/**
 * 容错解析可能截断的 JSON（等价 pi 依赖的 partial-json）：
 * 尽量返回已完整解析的部分，未闭合的字符串/容器按截断丢弃。
 * @param text 可能不完整的 JSON 文本。
 * @returns 解析结果；完全无法解析时返回 undefined。
 */
export function partialParse(text: string): unknown {
	try {
		return parseValue(text, 0)[0];
	} catch (error) {
		if (error instanceof Truncated) return undefined;
		throw error;
	}
}

/**
 * 解析流式中可能不完整的 JSON，永远返回合法对象。
 * 三级容错：直接 parse（含修复）→ partialParse → 修复后 partialParse → {}。
 *
 * @template T 期望的对象类型。
 * @param partialJson 流式累积的 JSON 片段。
 * @returns 解析出的对象，彻底失败时返回 {}。
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
