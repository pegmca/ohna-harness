/**
 * 本地只读文件系统 DTO（ohna-web 跨边界线格式）。
 *
 * 约束（04 Phase 3 / 03 §6.1）：
 * - `path` 一律是**工作区相对路径**，根目录用 `"."` 表示；
 * - 这里只描述读取结果，不提供任何写入形状——写操作只能经 Agent 工具 + 确认闸门；
 * - 越界与敏感路径在服务端被拒绝，不会出现在 DTO 中。
 */

/** 文件系统条目类型；符号链接不跟随，避免把越界目标伪装成普通条目。 */
export type LocalFsEntryType = "file" | "directory" | "symlink" | "other";

/** 目录列表中的单个条目。 */
export interface LocalFsEntryDto {
  /** 条目名（不含父目录）。 */
  name: string;
  /** 工作区相对路径（根为 "."）。 */
  path: string;
  type: LocalFsEntryType;
  /** 文件字节数；目录 / 不可 stat 的条目缺省。 */
  size?: number;
}

/** `mode=list` 的返回。 */
export interface LocalFsListDto {
  /** 请求的工作区相对路径（根为 "."）。 */
  path: string;
  entries: LocalFsEntryDto[];
  /** 条目数超过服务端上限时为 true。 */
  truncated?: boolean;
}

/** `mode=read` 的返回。 */
export interface LocalFsReadDto {
  /** 请求的工作区相对路径（根为 "."）。 */
  path: string;
  /** 文本内容；二进制文件为空字符串。 */
  content: string;
  /** 文件总字节数（不受截断影响）。 */
  bytes: number;
  /** 内容超过读取上限被截断时为 true。 */
  truncated: boolean;
  /** NUL 嗅探判定为二进制时为 true（此时 content 为空）。 */
  binary: boolean;
}

/** `mode=tree` 的递归节点。 */
export interface LocalFsTreeDto {
  /** 节点的工作区相对路径（根为 "."）。 */
  path: string;
  type: LocalFsEntryType;
  /** 目录子节点；文件 / 符号链接缺省。 */
  children?: LocalFsTreeDto[];
  /** 该节点（或全局总量）触达上限时为 true。 */
  truncated?: boolean;
}
