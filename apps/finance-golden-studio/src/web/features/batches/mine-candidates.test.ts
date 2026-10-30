import { describe, expect, test } from "vitest";
import { parseCandidateFile } from "./mine-candidates.ts";

describe("parseCandidateFile", () => {
  test("parses the CLI-compatible JSON array", () => {
    const result = parseCandidateFile(
      JSON.stringify([
        {
          ticker: "600000.SH",
          report_type: "annual",
          period: "2025",
          type: "numeric_fact"
        }
      ])
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidates[0]?.ticker).toBe("600000.SH");
  });

  test("rejects invalid JSON and non-object arrays", () => {
    expect(parseCandidateFile("{")).toEqual({
      ok: false,
      message: "候选文件必须包含合法的 JSON。"
    });
    expect(parseCandidateFile('["600000.SH"]')).toEqual({
      ok: false,
      message: "候选文件必须包含对象数组。"
    });
  });
});
