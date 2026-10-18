import * as Popover from "@radix-ui/react-popover";
import type { ModelOptionDto } from "@aiagent/types";
import {
  ArrowUp,
  Check,
  Lightbulb,
  Loader2,
  RotateCcw,
  Square
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState
} from "react";

interface ComposerControlsProps {
  error: string | undefined;
  input: string;
  isSubmitting: boolean;
  models: ModelOptionDto[];
  modelCatalogStatus: "loading" | "ready" | "failed";
  modelCatalogError?: string;
  onInputChange: (value: string) => void;
  onRetryModels: () => void;
  onSelectModel: (modelId: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
  prompts: string[];
  selectedModelId: string;
}

/**
 * Kimi 式 Composer 控制面：本地版仅保留灵感、模型与发送，无附件 / Report Mode。
 *
 * @param props Composer 状态与回调。
 * @returns 可访问的消息输入表单。
 */
export function ComposerControls(props: ComposerControlsProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const selectedModel = props.models.find((model) => model.id === props.selectedModelId);
  const canSend = props.input.trim().length > 0
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

  return (
    <form className="chat-composer" onSubmit={props.onSubmit}>
      {props.error ? <div className="composer-error" role="status">{props.error}</div> : null}
      <div className="composer-box">
        <textarea
          className="composer-textarea"
          disabled={props.isSubmitting}
          onChange={(event) => props.onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="描述一个编码任务…"
          ref={textareaRef}
          rows={1}
          value={props.input}
        />

        <div className="composer-toolbar">
          <div className="composer-toolbar-group">
            <Popover.Root onOpenChange={setIdeaOpen} open={ideaOpen}>
              <Popover.Trigger asChild>
                <button
                  aria-label="任务灵感"
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
                  <p className="md-label">任务灵感</p>
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
      {props.modelCatalogStatus === "failed" ? (
        <p className="composer-progress">
          模型目录不可用。
          <button onClick={props.onRetryModels} type="button">重试加载</button>
        </p>
      ) : null}
    </form>
  );
}
