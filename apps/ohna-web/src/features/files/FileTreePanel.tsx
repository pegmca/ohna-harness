/**
 * 文件树面板（W-2 / W-8）：懒加载目录树 + 只读预览 + 联动刷新。
 * 数据与展开逻辑在 `useFileTree`，本组件只做订阅与展示编排；
 * 树行 / 预览为纯展示组件，见 `file-tree-views.tsx`。
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { readFs } from "./files-api";
import { FilePreview, FileTreeRows, type FilePreviewState } from "./file-tree-views";
import { onFilesChanged } from "./refresh-bus";
import { useFileTree } from "./use-file-tree";

/** 面板标题与工作区根目录（W-2：展示 workspaceRoot 结构）。 */
interface FileTreePanelProps {
  /** 工作区根目录绝对路径（来自 /api/health），仅用于面板标题展示。 */
  workspaceRoot: string;
}

/**
 * 文件树面板状态编排壳。
 *
 * @param props 面板属性。
 * @returns 文件树侧栏。
 */
export function FileTreePanel(props: FileTreePanelProps) {
  const tree = useFileTree();
  const [preview, setPreview] = useState<FilePreviewState>();

  useEffect(() => {
    void tree.refresh();
    // W-8：Agent 写类工具落地后自动刷新当前展开目录。
    const unsubscribe = onFilesChanged(() => void tree.scheduleRefresh());
    return unsubscribe;
  }, [tree.refresh, tree.scheduleRefresh]);

  /**
   * 打开文件只读预览。
   *
   * @param path 文件相对路径。
   * @returns 无返回值。
   */
  const handleOpenFile = useCallback((path: string): void => {
    setPreview({ path, loading: true });
    void readFs(path).then((result) => {
      setPreview((current) => {
        if (!current || current.path !== path) return current;
        return result.ok
          ? { path, loading: false, data: result.data }
          : { path, loading: false, error: result.error.message };
      });
    });
  }, []);

  return (
    <aside aria-label="工作区文件树" className="files-panel">
      <header className="files-header">
        <div className="min-w-0">
          <p className="md-label">Files</p>
          <h2 className="files-title" title={props.workspaceRoot}>{props.workspaceRoot}</h2>
        </div>
        <button aria-label="刷新文件树" className="icon-button" onClick={() => void tree.refresh()} type="button">
          <RefreshCw className="icon-size" />
        </button>
      </header>
      {tree.error ? <p className="files-error" role="status">{tree.error}</p> : null}
      <div className="files-scroll">
        <FileTreeRows
          dirPath="."
          entries={tree.entriesByDir["."] ?? []}
          entriesByDir={tree.entriesByDir}
          expanded={tree.expanded}
          onOpenFile={handleOpenFile}
          onToggleDir={tree.toggleDir}
        />
      </div>
      {preview ? <FilePreview preview={preview} onClose={() => setPreview(undefined)} /> : null}
    </aside>
  );
}
