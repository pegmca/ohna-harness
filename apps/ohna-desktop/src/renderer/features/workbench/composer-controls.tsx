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
  useId,
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
  /** 提交按钮的 form 属性：让主区左下角的设置按钮与发送键同处底行（FR-001）。 */
  formId?: string;
  modelCatalogError?: string;
  onInputChange: (value: string) => void;
  onRetryModels: () => void;
  onSelectModel: (modelId: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
  prompts: string[];
  selectedModelId: string;
  /**
   * 只读观测实例（docs/v1.4/06 D-A7）：true 时禁用全部输入与发送，并提示用户，
   * 而不是发送后 404。CLI 单一形态恒为 false。
   */
  observeOnly?: boolean;
}

/**
 * 按分组收敛模型目录，保持首次出现顺序。
 *
 * @param models 扁平模型列表。
 * @returns 分组后的模型；无 group 的归入「其他」。
 */
function groupModels(models: ModelOptionDto[]): Array<{ name: string; models: ModelOptionDto[] }> {
  const groups = new Map<string, ModelOptionDto[]>();
  for (const model of models) {
    const name = model.group?.trim() || "其他";
    const list = groups.get(name);
    if (list) list.push(model);
    else groups.set(name, [model]);
  }
  return [...groups].map(([name, list]) => ({ name, models: list }));
}

/**
 * Kimi 式 Composer 控制面：本地版仅保留灵感、模型与发送，无附件 / Report Mode。
 *
 * 只读实例（observeOnly）下 composer 整体禁用：写入/取消 run 的路由未注册，发送必失败，
 * 因此用「禁用 + 提示」替代「能输入但报错」（BUG-005 止血）。
 *
 * @param props Composer 状态与回调。
 * @returns 可访问的消息输入表单。
 */
export function ComposerControls(props: ComposerControlsProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const modelListId = useId();
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [activeModelIndex, setActiveModelIndex] = useState(0);
  const selectedModel = props.models.find((model) => model.id === props.selectedModelId);
  // 按 group 分组展示（对齐 Codex）；无 group 的模型落在「其他」。
  const modelGroups = groupModels(props.models);
  const orderedModels = modelGroups.flatMap((group) => group.models);
  // 只读实例下直接禁发：绕过「输入非空 + 模型就绪」的常规可发判定。
  const canSend = !props.observeOnly
    && props.input.trim().length > 0
    && props.modelCatalogStatus === "ready"
    && Boolean(props.selectedModelId);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [props.input]);

  useEffect(() => {
    if (!modelOpen) return;
    const selectedIndex = orderedModels.findIndex((model) => model.id === props.selectedModelId);
    const nextIndex = selectedIndex >= 0 ? selectedIndex : 0;
    setActiveModelIndex(nextIndex);
    requestAnimationFrame(() => modelOptionRefs.current[nextIndex]?.focus());
  }, [modelOpen, props.models, props.selectedModelId]);

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

  /**
   * 模型列表键盘导航：方向键移动活动项，Enter 选择，Escape 关闭并归还焦点。
   *
   * @param event 模型列表键盘事件。
   * @returns 无返回值。
   */
  function handleModelListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setModelOpen(false);
      requestAnimationFrame(() => modelTriggerRef.current?.focus());
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = (activeModelIndex + direction + orderedModels.length) % orderedModels.length;
      setActiveModelIndex(next);
      modelOptionRefs.current[next]?.focus();
      return;
    }
    if (event.key === "Enter" && orderedModels[activeModelIndex]) {
      event.preventDefault();
      props.onSelectModel(orderedModels[activeModelIndex].id);
      setModelOpen(false);
      requestAnimationFrame(() => modelTriggerRef.current?.focus());
    }
  }

  return (
    <form className="chat-composer" id={props.formId} onSubmit={props.onSubmit}>
      {props.error ? <div className="composer-error" role="status">{props.error}</div> : null}
      {props.observeOnly ? (
        <div className="composer-readonly-banner" role="status">
          当前为只读观测实例，浏览器不能发起或取消 run；请在终端启动 ohna 后进行交互。
        </div>
      ) : null}
      <div className="composer-box">
        <textarea
          className="composer-textarea"
          disabled={props.isSubmitting || props.observeOnly === true}
          onChange={(event) => props.onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={props.observeOnly ? "只读观测实例：不可发送消息。" : "许下你的愿望"}
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
                  disabled={props.observeOnly === true}
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
                <button
                  className="model-selector"
                  disabled={props.isSubmitting || props.observeOnly === true}
                  ref={modelTriggerRef}
                  type="button"
                >
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
                  <div
                    aria-activedescendant={orderedModels[activeModelIndex] ? `${modelListId}-${orderedModels[activeModelIndex].id}` : undefined}
                    aria-label="模型列表"
                    className="model-list"
                    onKeyDown={handleModelListKeyDown}
                    role="listbox"
                  >
                    {modelGroups.map((group) => (
                      <div className="model-group" key={group.name}>
                        <p className="model-group-label">{group.name}</p>
                        {group.models.map((model) => {
                          const isSelected = model.id === props.selectedModelId;
                          const modelIndex = orderedModels.findIndex((item) => item.id === model.id);
                          return (
                            <button
                              aria-label={`选择模型 ${model.label}`}
                              aria-selected={isSelected}
                              className="model-option"
                              id={`${modelListId}-${model.id}`}
                              key={model.id}
                              onClick={() => {
                                props.onSelectModel(model.id);
                                setModelOpen(false);
                                requestAnimationFrame(() => modelTriggerRef.current?.focus());
                              }}
                              ref={(element) => {
                                modelOptionRefs.current[modelIndex] = element;
                              }}
                              role="option"
                              type="button"
                            >
                              <span className="model-option-name">{model.label}</span>
                              {isSelected ? <Check className="icon-size" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <Popover.Arrow className="popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <button
              aria-label={props.isSubmitting ? "停止生成" : "发送"}
              className="send-button"
              disabled={!props.isSubmitting && !canSend}
              form={props.formId}
              onClick={props.isSubmitting
                ? (event) => {
                  // 停止态不能走表单提交（会再次发送同一输入），先取消默认提交再交给 onStop。
                  event.preventDefault();
                  props.onStop();
                }
                : undefined}
              // 带 form 属性后按钮不再隐式继承所属表单，因此停/发两态都显式指定 submit；
              // 停止态由 onClick 接管（先 preventDefault 再 onStop），不会误提交。
              type="submit"
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
