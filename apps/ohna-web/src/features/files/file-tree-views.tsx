import type { LocalFsEntryDto, LocalFsReadDto } from "@aiagent/types";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link2 } from "lucide-react";
import { Fragment } from "react";

/** 已展开目录集合（路径 → 是否展开）；根目录固定为 "."。 */
export type ExpandedDirs = ReadonlySet<string>;

/** 目录子条目缓存：目录相对路径 → 一层条目。 */
export type EntriesByDir = Readonly<Record<string, LocalFsEntryDto[]>>;

interface FileTreeRowsProps {
  /** 当前层条目（服务端已按名称排序）。 */
  entries: LocalFsEntryDto[];
  /** 相对路径，用于递归与测试选择器。 */
  dirPath: string;
  expanded: ExpandedDirs;
  entriesByDir: EntriesByDir;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

/** 缩进基准（px / 层）。 */
const INDENT_PX = 14;

/**
 * 纯展示：递归渲染目录树行；懒加载语义由「展开但无缓存 → 显示加载行」表达，
 * 数据获取全部由容器（FileTreePanel）负责。
 *
 * @param props 树数据与回调。
 * @returns 树行列表。
 */
export function FileTreeRows(props: FileTreeRowsProps) {
  const { entries, dirPath } = props;
  if (!entries) {
    return <p className="files-loading" style={{ paddingLeft: indentOf(dirPath) }}>加载中…</p>;
  }
  if (entries.length === 0) {
    return <p className="files-empty" style={{ paddingLeft: indentOf(dirPath) }}>（空目录）</p>;
  }
  return (
    <ul className="files-rows" role="group" aria-label={`${dirPath === "." ? "工作区根目录" : dirPath} 内容`}>
      {entries.map((entry) => (
        <Fragment key={entry.path}>
          <li style={{ paddingLeft: indentOf(entry.path) }}>
            {entry.type === "directory" ? (
              <button
                aria-expanded={props.expanded.has(entry.path)}
                className="files-row"
                onClick={() => props.onToggleDir(entry.path)}
                type="button"
              >
                {props.expanded.has(entry.path)
                  ? <ChevronDown className="icon-size files-chevron" />
                  : <ChevronRight className="icon-size files-chevron" />}
                {props.expanded.has(entry.path)
                  ? <FolderOpen className="icon-size" />
                  : <Folder className="icon-size" />}
                <span className="files-name">{entry.name}</span>
              </button>
            ) : (
              <button
                className="files-row is-file"
                onClick={() => props.onOpenFile(entry.path)}
                type="button"
              >
                {entry.type === "symlink"
                  ? <Link2 className="icon-size" />
                  : <File className="icon-size" />}
                <span className="files-name">{entry.name}</span>
                {typeof entry.size === "number" ? <span className="files-size">{formatSize(entry.size)}</span> : null}
              </button>
            )}
          </li>
          {entry.type === "directory" && props.expanded.has(entry.path) && props.entriesByDir[entry.path] ? (
            <li role="none">
              <FileTreeRows
                dirPath={entry.path}
                entries={props.entriesByDir[entry.path]}
                entriesByDir={props.entriesByDir}
                expanded={props.expanded}
                onOpenFile={props.onOpenFile}
                onToggleDir={props.onToggleDir}
              />
            </li>
          ) : null}
        </Fragment>
      ))}
    </ul>
  );
}

/**
 * 按路径深度计算缩进（根目录子项从 0 开始）。
 *
 * @param path 工作区相对路径。
 * @returns 缩进像素值。
 */
function indentOf(path: string): number {
  return path === "." ? 0 : (path.split("/").length - 1) * INDENT_PX;
}

/**
 * 把字节数格式化为短尺寸文案。
 *
 * @param bytes 字节数。
 * @returns 如 `1.2 KB`。
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 文件预览的加载/失败状态。 */
export interface FilePreviewState {
  path: string;
  loading: boolean;
  data?: LocalFsReadDto;
  error?: string;
}

/**
 * 纯展示：文件只读预览（read 模式，256KB 截断语义由服务端给）。
 *
 * @param props 预览状态与关闭回调。
 * @returns 预览块。
 */
export function FilePreview(props: { preview: FilePreviewState; onClose: () => void }) {
  const { preview } = props;
  return (
    <div className="files-preview">
      <div className="files-preview-header">
        <code className="files-preview-path">{preview.path}</code>
        <button aria-label="关闭预览" className="icon-button" onClick={props.onClose} type="button">×</button>
      </div>
      {preview.loading ? <p className="files-loading">读取中…</p> : null}
      {preview.error ? <p className="files-error" role="status">{preview.error}</p> : null}
      {preview.data ? (
        preview.data.binary
          ? <p className="files-empty">二进制文件，无法预览（{formatSize(preview.data.bytes)}）。</p>
          : (
            <pre className="files-preview-content">
              {preview.data.content}
              {preview.data.truncated ? "\n…（内容已截断，完整内容请让 Agent 读取）" : ""}
            </pre>
          )
      ) : null}
    </div>
  );
}
