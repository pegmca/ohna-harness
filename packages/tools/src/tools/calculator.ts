import { z } from "zod";
import { defineAgentTool } from "../agent-tool.js";
import type { AgentTool } from "../types.js";

export const calculatorInputSchema = z.object({
  expression: z.string().min(1, "expression is required")
});

export const calculatorOutputSchema = z.object({
  expression: z.string(),
  value: z.number()
});

export type CalculatorInput = z.infer<typeof calculatorInputSchema>;
export type CalculatorOutput = z.infer<typeof calculatorOutputSchema>;

export const calculatorTool: AgentTool<typeof calculatorInputSchema, CalculatorOutput> = defineAgentTool({
  name: "calculator",
  description: "Evaluate a basic arithmetic expression with +, -, *, / and parentheses.",
  label: "Calculator",
  parameters: calculatorInputSchema,
  outputSchema: calculatorOutputSchema,
  source: "real",
  formatResult: (output) => `${output.expression} = ${output.value}`,
  /**
   * 执行安全的四则运算解析，避免使用 eval 执行任意代码。
   *
   * @param input 计算器表达式输入。
   * @returns 表达式和计算结果。
   */
  execute(input) {
    return {
      expression: input.expression,
      value: evaluateArithmeticExpression(input.expression)
    };
  }
});

/**
 * 计算基础四则运算表达式；这里手写小型 parser 是为了避免 eval 执行任意代码。
 *
 * @param expression 用户输入的算术表达式。
 * @returns 表达式计算结果。
 */
function evaluateArithmeticExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  const values: number[] = [];
  const operators: string[] = [];

  for (const token of tokens) {
    if (typeof token === "number") {
      values.push(token);
      continue;
    }

    if (token === "(") {
      operators.push(token);
      continue;
    }

    if (token === ")") {
      while (operators.length > 0 && operators[operators.length - 1] !== "(") {
        applyTopOperator(values, operators);
      }

      if (operators.pop() !== "(") {
        throw new Error("Invalid arithmetic expression");
      }
      continue;
    }

    while (
      operators.length > 0 &&
      operators[operators.length - 1] !== "(" &&
      precedence(operators[operators.length - 1]) >= precedence(token)
    ) {
      applyTopOperator(values, operators);
    }
    operators.push(token);
  }

  while (operators.length > 0) {
    if (operators[operators.length - 1] === "(") {
      throw new Error("Invalid arithmetic expression");
    }
    applyTopOperator(values, operators);
  }

  if (values.length !== 1 || !Number.isFinite(values[0])) {
    throw new Error("Invalid arithmetic expression");
  }

  return values[0];
}

/**
 * 将表达式切成 number 和 operator token，非法字符会立即转成执行错误。
 *
 * @param expression 算术表达式。
 * @returns token 列表。
 */
function tokenizeExpression(expression: string): Array<number | string> {
  const tokens: Array<number | string> = [];
  let index = 0;
  let expectsValue = true;

  while (index < expression.length) {
    const char = expression[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char) || (char === "-" && expectsValue)) {
      const start = index;
      index += 1;

      while (index < expression.length && /[0-9.]/.test(expression[index])) {
        index += 1;
      }

      const value = Number(expression.slice(start, index));
      if (!Number.isFinite(value)) {
        throw new Error("Invalid arithmetic expression");
      }

      tokens.push(value);
      expectsValue = false;
      continue;
    }

    if (char === "(") {
      tokens.push(char);
      expectsValue = true;
      index += 1;
      continue;
    }

    if (char === ")") {
      tokens.push(char);
      expectsValue = false;
      index += 1;
      continue;
    }

    if (["+", "-", "*", "/"].includes(char)) {
      if (expectsValue) {
        throw new Error("Invalid arithmetic expression");
      }

      tokens.push(char);
      expectsValue = true;
      index += 1;
      continue;
    }

    throw new Error("Invalid arithmetic expression");
  }

  if (tokens.length === 0 || expectsValue) {
    throw new Error("Invalid arithmetic expression");
  }

  return tokens;
}

/**
 * 返回运算符优先级，用于 shunting-yard 风格求值。
 *
 * @param operator 四则运算符。
 * @returns 运算符优先级。
 */
function precedence(operator: string): number {
  return operator === "+" || operator === "-" ? 1 : 2;
}

/**
 * 弹出并应用栈顶运算符，发现缺少操作数时转为结构化执行错误。
 *
 * @param values 数值栈。
 * @param operators 运算符栈。
 */
function applyTopOperator(values: number[], operators: string[]): void {
  const operator = operators.pop();
  const right = values.pop();
  const left = values.pop();

  if (!operator || left === undefined || right === undefined) {
    throw new Error("Invalid arithmetic expression");
  }

  if (operator === "/" && right === 0) {
    throw new Error("Division by zero");
  }

  values.push(applyOperator(left, right, operator));
}

/**
 * 执行单个四则运算符。
 *
 * @param left 左操作数。
 * @param right 右操作数。
 * @param operator 运算符。
 * @returns 单步计算结果。
 */
function applyOperator(left: number, right: number, operator: string): number {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    default:
      throw new Error("Invalid arithmetic expression");
  }
}
