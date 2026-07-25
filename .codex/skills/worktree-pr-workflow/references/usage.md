# Worktree PR Workflow 使用说明

本 Skill 只支持显式调用。普通对话不会自动加载或应用其中的研发流程。

## 1. 生成方案设计 Agent 提示词

```text
$worktree-pr-workflow 为数据库全面落库生成方案设计 Agent 提示词
```

输出一段可交给 Solution Design Agent 的简短提示词。该 Agent 负责调研仓库、拆分 PR
依赖，并把决策完整的设计写入 `docs/worktree/`，不实现功能代码。

## 2. 生成 Implementation Agent 提示词

```text
$worktree-pr-workflow 输出 PR-06 的 Implementation Agent 提示词
```

读取 `docs/worktree/README.md` 和指定 PR 文档，输出适合粘贴到 CCManager worktree
Codex 窗口的简短提示词。详细实现要求以任务文档为准，不在提示词中重复。

## 3. 生成 Review Agent 提示词

```text
$worktree-pr-workflow 输出 review PR-09 的提示词
```

输出适合主分支 Review Codex 的提示词。Review Agent 只使用 PR diff 和 GitHub Checks
审查并发布普通评论，不修改代码、不正式 Approve、不合并。

## 4. 在人工合并后推进任务

```text
$worktree-pr-workflow PR-01 已合并，告诉我下一批任务
```

根据 `docs/worktree` 的依赖图确认新近可启动的任务，只列出依赖已经合并到 `master` 的
worktree。需要某个任务的提示词时再单独请求。

## 合并门禁

同一 GitHub 账号不能正式 Approve 自己创建的 PR。本流程以以下条件作为合并门禁：

- Implementation Agent 已在自己的 worktree 完成规定测试。
- GitHub Checks 全部通过。
- Review Agent 已评论 `Review completed: no blocking findings.`，或全部 blocking findings
  已由原 Implementation Agent 修复并回复。
- 用户人工执行合并。
