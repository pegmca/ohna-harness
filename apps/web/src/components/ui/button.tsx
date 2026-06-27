import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
}

const baseClassName =
  "inline-flex items-center justify-center rounded-lg border text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

const variantClassNames: Record<ButtonVariant, string> = {
  primary:
    "border-[var(--md-color-border)] bg-[var(--md-color-primary)] text-[var(--md-color-text-inverse)] hover:bg-[var(--md-color-primary-hover)] disabled:bg-[var(--md-color-muted)] disabled:text-[var(--md-color-text-disabled)]",
  ghost:
    "border-[var(--md-color-border-subtle)] bg-[var(--md-color-surface)] text-[var(--md-color-text-secondary)] hover:border-[var(--md-color-border)] hover:bg-[var(--md-color-elevated)] hover:text-[var(--md-color-text-primary)]"
};

/**
 * shadcn/ui 风格的基础按钮，集中承载 Tailwind 视觉约束供业务组件复用。
 *
 * @param props 按钮属性和 variant。
 * @returns 标准按钮元素。
 */
export function Button(props: ButtonProps) {
  const { children, className, variant = "primary", ...buttonProps } = props;

  return (
    <button className={mergeClassNames(baseClassName, variantClassNames[variant], className)} {...buttonProps}>
      {children}
    </button>
  );
}

/**
 * 合并可选 className，避免为了一个基础组件引入额外运行时依赖。
 *
 * @param values 候选 className。
 * @returns 过滤空值后的 className 字符串。
 */
function mergeClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}
