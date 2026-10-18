import { describe, expect, it, vi } from "vitest";
import { isFileMutatingTool, notifyFilesChanged, onFilesChanged } from "./refresh-bus";

describe("refresh-bus", () => {
  it("notifies listeners for write / edit / bash tool ends", () => {
    const listener = vi.fn();
    const unsubscribe = onFilesChanged(listener);
    notifyFilesChanged("write");
    notifyFilesChanged("edit");
    notifyFilesChanged("bash");
    expect(listener.mock.calls.map((call) => call[0])).toEqual(["write", "edit", "bash"]);
    unsubscribe();
  });

  it("does not mark read-only tools as file-mutating", () => {
    const listener = vi.fn();
    const unsubscribe = onFilesChanged(listener);
    // 门控在 Workbench：只有 isFileMutatingTool 为 true 的 tool_execution_end 才会广播。
    expect(isFileMutatingTool("read")).toBe(false);
    expect(isFileMutatingTool("grep")).toBe(false);
    expect(isFileMutatingTool("ls")).toBe(false);
    expect(isFileMutatingTool("bash")).toBe(true);
    // 总线本身是纯发射器：未广播时监听者不被调用。
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("supports multiple listeners and unsubscribe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onFilesChanged(first);
    const unsubscribeSecond = onFilesChanged(second);

    notifyFilesChanged("write");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    notifyFilesChanged("bash");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    // 取消订阅幂等，重复调用不抛错。
    expect(() => unsubscribeFirst()).not.toThrow();
    unsubscribeSecond();
  });
});
