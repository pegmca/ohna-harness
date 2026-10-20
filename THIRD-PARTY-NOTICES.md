# 第三方参考与致谢

本仓库的全部代码均为自主实现，并未直接移植第三方项目的源代码。在设计与实现过程中，
部分模块参考了若干公开项目的思路，并依据其开源许可证进行致谢。以下列出参考来源：

## pi

- 项目：pi（Mario Zechner，badlogic）
- 许可证：MIT
- 版权：Copyright 2025 Mario Zechner
- 说明：本仓库的 Agent 内核、LLM 抽象与编码工具的设计参考了 pi 的实现思路（如
  `packages/ai` 的 `Message` / `AssistantMessageEvent` 抽象、`packages/coding` 的路径与命令
  策略）。相关源码注释保留了对 pi 的参考说明，依其 MIT 许可证致谢原作者。

## opencode

- 项目：opencode（sst）
- 许可证：MIT
- 说明：`apps/ohna-cli/src/ui/tui/*` 的整屏 TUI 渲染基础参考了 opencode 的 TUI 实现思路，
  依其 MIT 许可证致谢。

## superpowers（未随本仓发布）

- 项目：superpowers（AI Coding 工作流 skill 集）
- 许可证：MIT
- 说明：本仓库在开源清洗时已通过 `.gitignore` 排除 `.agents/` 与 `.claude/` 目录下的
  superpowers skill，未将其纳入公开仓库分发，因此此处不随附其完整文本。如需使用，请
  参照 superpowers 上游的 MIT 许可证。

---

上述项目均依据各自的 MIT 许可证进行参考与致谢；如与本仓库主许可证（MIT）存在冲突，
以第三方各自许可证的条款为准。
