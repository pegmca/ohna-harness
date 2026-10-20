# Third-Party Notices

本仓库在开源清洗前已包含来自第三方项目的移植代码（移植声明散见于源码注释，如
`apps/ohna-cli/src/ui/tui/*` 标注 `ported from opencode ... (MIT)`，`README.md` 标注 pi
（MIT，Copyright 2025 Mario Zechner））。这些代码的著作权归原作者所有，按对应许可证授权。

## pi

- 项目：pi（Mario Zechner，badlogic）
- 许可证：MIT
- 版权：Copyright 2025 Mario Zechner
- 说明：本仓库的 Agent 内核、LLM 抽象与部分设计对齐并移植自 pi；具体文件见源码内
  `ported from pi` / `aligned with pi-ai` 等注释。

## opencode

- 项目：opencode（sst）
- 许可证：MIT
- 说明：`apps/ohna-cli/src/ui/tui/*` 的整屏 TUI 渲染基础部分移植自 opencode。

## superpowers（未随本仓发布）

- 项目：superpowers（AI Coding 工作流 skill 集）
- 许可证：MIT
- 说明：本仓库在开源清洗时已通过 `.gitignore` 排除 `.agents/` 与 `.claude/` 目录下的
  superpowers skill，未将其纳入公开仓库分发，因此此处不随附其完整文本。如需使用，请
  参照 superpowers 上游的 MIT 许可证。

---

所有第三方代码的移植与使用均遵循其原始 MIT 许可证；如与本仓库主许可证（MIT）存在冲突，
以第三方各自许可证的条款为准。
