import * as Popover from "@radix-ui/react-popover";
import * as Switch from "@radix-ui/react-switch";
import type { ModelOptionDto } from "@aiagent/types";
import {
  ArrowUp,
  Check,
  FileText,
  Lightbulb,
  Loader2,
  Paperclip,
  Plus,
  RotateCcw,
  Square,
  X
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState
} from "react";
import type { DraftAttachment } from "./types";

interface ComposerControlsProps {
  attachments: DraftAttachment[];
  error: string | undefined;
  input: string;
  isSubmitting: boolean;
  models: ModelOptionDto[];
  modelCatalogStatus: "loading" | "ready" | "failed";
  modelCatalogError?: string;
  onFilesSelected: (files: FileList) => void;
  onInputChange: (value: string) => void;
  onRemoveAttachment: (clientAttachmentId: string) => void;
  onReportModeChange: (checked: boolean) => void;
  onRetryAttachment: (clientAttachmentId: string) => void;
  onRetryModels: () => void;
  onSelectModel: (modelId: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
  prompts: string[];
  reportMode: boolean;
  selectedModelId: string;
}

/**
 * Kimi 式 Composer 控制面：附件/Report、灵感、模型与发送保持同一视觉层级。
 *
 * @param props Composer 状态与回调。
 * @returns 可访问的消息输入表单。
 */
export function ComposerControls(props: ComposerControlsProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const selectedModel = props.models.find((model) => model.id === props.selectedModelId);
  const hasBlockingAttachment = props.attachments.some((item) => item.status !== "indexed");
  const canSend = props.input.trim().length > 0
    && !hasBlockingAttachment
    && props.modelCatalogStatus === "ready"
    && Boolean(props.selectedModelId);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [props.input]);

  /** @param event 键盘事件。 @returns 无返回值。 */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key !== "Enter"
      || event.shiftKey
      || event.nativeEvent.isComposing
      || props.isSubmitting
      || !canSend
    ) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  /** @param event 文件选择事件。 @returns 无返回值。 */
  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    if (event.target.files?.length) props.onFilesSelected(event.target.files);
    event.target.value = "";
  }

  return (
    <form className="chat-composer" onSubmit={props.onSubmit}>
      {props.error ? <div className="composer-error" role="status">{props.error}</div> : null}
      <div className="composer-box">
        {props.attachments.length > 0 ? (
          <div className="composer-attachments" aria-label="待发送附件">
            {props.attachments.map((attachment) => (
              <div className={`attachment-chip is-${attachment.status}`} key={attachment.clientAttachmentId}>
                {attachment.status === "uploading"
                  ? <Loader2 className="icon-size spin" />
                  : <FileText className="icon-size" />}
                <span title={attachment.fileName}>{attachment.fileName}</span>
                {attachment.status === "failed" ? (
                  <button
                    aria-label={`重试上传 ${attachment.fileName}`}
                    onClick={() => props.onRetryAttachment(attachment.clientAttachmentId)}
                    type="button"
                  ><RotateCcw className="icon-size" /></button>
                ) : null}
                <button
                  aria-label={`移除附件 ${attachment.fileName}`}
                  onClick={() => props.onRemoveAttachment(attachment.clientAttachmentId)}
                  type="button"
                ><X className="icon-size" /></button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          className="composer-textarea"
          disabled={props.isSubmitting}
          onChange={(event) => props.onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入金融研究问题..."
          ref={textareaRef}
          rows={1}
          value={props.input}
        />

        <div className="composer-toolbar">
          <div className="composer-toolbar-group">
            <Popover.Root>
              <Popover.Trigger asChild>
                <button aria-label="添加内容" className="composer-icon-button" disabled={props.isSubmitting} type="button">
                  <Plus className="icon-size" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content align="start" className="composer-popover" sideOffset={8}>
                  <button className="composer-menu-row" onClick={() => fileInputRef.current?.click()} type="button">
                    <Paperclip className="icon-size" /><span>上传文件</span><small>MD / TXT</small>
                  </button>
                  <div className="composer-menu-row">
                    <FileText className="icon-size" />
                    <span>Report Mode</span>
                    <Switch.Root
                      aria-label="Report Mode"
                      checked={props.reportMode}
                      className="switch-root"
                      onCheckedChange={props.onReportModeChange}
                    ><Switch.Thumb className="switch-thumb" /></Switch.Root>
                  </div>
                  <Popover.Arrow className="popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <input
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              className="visually-hidden"
              multiple
              onChange={handleFileChange}
              ref={fileInputRef}
              type="file"
            />

            <Popover.Root onOpenChange={setIdeaOpen} open={ideaOpen}>
              <Popover.Trigger asChild>
                <button
                  aria-label="研究灵感"
                  className="composer-icon-button"
                  type="button"
                ><Lightbulb className="icon-size" /></button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="start"
                  className="composer-popover idea-popover"
                  sideOffset={8}
                >
                  <p className="md-label">研究灵感</p>
                  {props.prompts.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        props.onUsePrompt(prompt);
                        setIdeaOpen(false);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                      type="button"
                    >{prompt}</button>
                  ))}
                  <Popover.Arrow className="popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {props.reportMode ? <span className="composer-mode-indicator">Report</span> : null}
          </div>

          <div className="composer-toolbar-group">
            <Popover.Root onOpenChange={setModelOpen} open={modelOpen}>
              <Popover.Trigger asChild>
                <button className="model-selector" disabled={props.isSubmitting} type="button">
                  <span>{selectedModel?.label ?? "选择模型"}</span>
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content align="end" className="composer-popover model-popover" sideOffset={8}>
                  <p className="md-label">选择模型</p>
                  {props.modelCatalogStatus === "loading" ? (
                    <p className="composer-progress"><Loader2 className="icon-size spin" /> 正在加载模型…</p>
                  ) : null}
                  {props.modelCatalogStatus === "failed" ? (
                    <div className="model-catalog-error" role="status">
                      <span>{props.modelCatalogError ?? "模型目录加载失败。"}</span>
                      <button onClick={props.onRetryModels} type="button">
                        <RotateCcw className="icon-size" />重试
                      </button>
                    </div>
                  ) : null}
                  {props.models.map((model) => (
                    <button
                      className="model-option"
                      key={model.id}
                      onClick={() => {
                        props.onSelectModel(model.id);
                        setModelOpen(false);
                      }}
                      type="button"
                    >
                      <span><strong>{model.label}</strong><small>{model.description}</small></span>
                      {model.id === props.selectedModelId ? <Check className="icon-size" /> : null}
                    </button>
                  ))}
                  <Popover.Arrow className="popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <button
              aria-label={props.isSubmitting ? "停止生成" : "发送"}
              className="send-button"
              disabled={!props.isSubmitting && !canSend}
              onClick={props.isSubmitting ? props.onStop : undefined}
              type={props.isSubmitting ? "button" : "submit"}
            >
              {props.isSubmitting ? <Square className="icon-size" /> : <ArrowUp className="icon-size" />}
            </button>
          </div>
        </div>
      </div>
      {hasBlockingAttachment ? <p className="composer-progress">请等待附件完成索引，失败项可重试或移除。</p> : null}
      {props.modelCatalogStatus === "failed" ? (
        <p className="composer-progress">
          模型目录不可用。
          <button onClick={props.onRetryModels} type="button">重试加载</button>
        </p>
      ) : null}
    </form>
  );
}
