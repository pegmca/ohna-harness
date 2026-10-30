import * as Popover from "@radix-ui/react-popover";
import type { WorkspaceDescriptorDto } from "@aiagent/types";
import { Check, ChevronDown, FolderGit2, FolderOpen, GitBranch, Loader2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { readWorkspaceGitBranch } from "../../shared/sdk/ohna-client";

/**
 * composer 上方的工作区栏：展示当前目录、完整路径与 Git 分支，并提供切换入口。
 *
 * 渲染端只接触 workspaceId / displayPath，绝对路径来自 main 的授权描述符；分支读取也经
 * preload 的只读通道，组件本身不做任何文件系统访问。
 */
interface WorkspaceBarProps {
  active: WorkspaceDescriptorDto | undefined;
  workspaces: WorkspaceDescriptorDto[];
  isLoading: boolean;
  isPicking: boolean;
  onPick: () => void;
  onSelect: (workspaceId: string) => void;
}

/**
 * 取目录展示名。
 *
 * @param displayPath canonical 绝对路径。
 * @returns 最后一段目录名。
 */
function basenameOf(displayPath: string): string {
  const segments = displayPath.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : displayPath;
}

/**
 * 渲染工作区选择栏。
 *
 * @param props 当前工作区、可选列表与回调。
 * @returns 工作区栏。
 */
export function WorkspaceBar(props: WorkspaceBarProps) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const { active } = props;

  useEffect(() => {
    if (!active) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    setBranchLoading(true);
    setBranch(null);
    void Promise.resolve(readWorkspaceGitBranch(active.workspaceId))
      .then((result) => {
        if (cancelled) return;
        setBranch(result?.ok ? result.data : null);
        setBranchLoading(false);
      })
      .catch(() => {
        if (!cancelled) setBranchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.workspaceId]);

  const label = active ? basenameOf(active.displayPath) : "选择工作区";

  return (
    <div className="workspace-bar">
      <Popover.Root onOpenChange={setOpen} open={open}>
        <Popover.Trigger asChild>
          <button
            aria-label={active ? `当前工作区 ${active.displayPath}` : "选择工作区"}
            className="workspace-trigger"
            type="button"
          >
            <FolderGit2 className="icon-size" />
            <span className="workspace-trigger-name">{label}</span>
            {branchLoading ? (
              <Loader2 className="icon-size spin" />
            ) : branch ? (
              <span className="workspace-branch"><GitBranch className="icon-size" />{branch}</span>
            ) : null}
            <ChevronDown className="icon-size workspace-trigger-chevron" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" className="composer-popover workspace-popover" sideOffset={8}>
            <p className="md-label">工作区</p>
            {props.isLoading ? (
              <p className="composer-progress"><Loader2 className="icon-size spin" /> 正在加载工作区…</p>
            ) : null}
            {props.workspaces.map((workspace) => {
              const selected = workspace.workspaceId === active?.workspaceId;
              return (
                <button
                  className="workspace-option"
                  key={workspace.workspaceId}
                  onClick={() => {
                    props.onSelect(workspace.workspaceId);
                    setOpen(false);
                  }}
                  title={workspace.displayPath}
                  type="button"
                >
                  <span>
                    <strong>{basenameOf(workspace.displayPath)}</strong>
                    <small>{workspace.displayPath}</small>
                  </span>
                  {selected ? <Check className="icon-size" /> : null}
                </button>
              );
            })}
            <button
              className="workspace-option workspace-pick"
              disabled={props.isPicking}
              onClick={() => {
                props.onPick();
                setOpen(false);
              }}
              type="button"
            >
              <span>
                <strong><FolderOpen className="icon-size" /> 选择其他目录</strong>
                <small>授权一个新目录作为工作区</small>
              </span>
              {props.isPicking ? <Loader2 className="icon-size spin" /> : <Plus className="icon-size" />}
            </button>
            <Popover.Arrow className="popover-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {active ? <span className="workspace-path" title={active.displayPath}>{active.displayPath}</span> : null}
    </div>
  );
}
