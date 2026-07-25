---
name: worktree-pr-workflow
description: Coordinate a document-driven multi-worktree delivery workflow in which implementation agents build and test one bounded PR, a main-worktree review agent inspects GitHub diffs and CI without approving or editing, and the user merges manually. Use only when the user explicitly invokes `$worktree-pr-workflow` to design worktree task documents, select the next dependency-ready PR, generate a concise implementation/review prompt, or coordinate review feedback and merge progression.
---

# Worktree PR Workflow

## Core contract

Treat the repository task document as the detailed specification and keep chat prompts short. Preserve
these roles:

- **Solution Design Agent**: inspect the repository and roadmap, design a decision-complete delivery
  plan, and write one task document per worktree/PR without implementing feature code.
- **Implementation Agent**: work in one CCManager worktree, implement one task, run its tests, update
  documentation, commit, push, and create a PR.
- **Review Agent**: run from the `master` worktree, inspect the PR with `gh`, read GitHub Checks, and
  publish findings as a normal PR comment. Do not switch branches, edit code, rerun local tests, submit
  Approve/Request Changes, or merge.
- **User**: manually merge after CI passes and blocking findings are resolved.

Never expose or apply this workflow unless the user explicitly invokes `$worktree-pr-workflow`.

## Usage guide

For user-facing invocation examples and expected outputs, read
[references/usage.md](references/usage.md). Load it when the user asks how to invoke this Skill or
requests one of its four supported operations.

## Ground the workflow

Before advising or acting:

1. Read `AGENTS.md`, repository architecture/coding guidance, and the task index under
   `docs/worktree/`.
2. Read only the selected task document and affected implementation surfaces.
3. Inspect `git status`, current branch, worktrees, remote, and relevant PR/CI state as needed.
4. Preserve unrelated dirty changes.
5. Treat task-document dependencies as merge gates: start a dependent worktree only after its
   prerequisites are merged into `master`.

If `docs/worktree/` is absent, first design a task index plus one decision-complete document per PR.
Each document must own a unique branch, migration identifier when applicable, scope, exclusions,
interfaces, tests, documentation impact, and acceptance criteria.

## Choose the requested operation

### Generate a solution-design prompt

Return a compact copyable prompt that directs the Solution Design Agent to inspect before designing,
write the design into the repository, and stop before feature implementation:

```text
请为 <goal> 设计多 worktree / 多 PR 实施方案。

开始前完整阅读：
- AGENTS.md
- <roadmap and architecture documents>
- affected packages, applications, public interfaces, tests, and current persistence/runtime code

不要实现功能代码。先盘点当前状态和缺口，再将方案写入 docs/worktree：
- README.md：总目标、架构原则、依赖图、并行批次、Agent 分工和统一 Review/合并规则
- 每个 PR 一份独立任务文档：前置依赖、分支名、migration（如有）、范围与排除项、设计决策、
  schema/API/port、事务与错误、安全、测试、文档影响、验收、commit/push/PR 要求

任务必须 decision-complete，并按领域边界拆分，避免多个 worktree 同时修改同一高冲突文件。
Implementation Agent 在各自 worktree 实现并测试；master Review Agent 只审查 diff 和 CI；
用户人工合并。

完成后检查文档链接、编号、依赖循环和 git diff，提交本次设计文档，并返回 commit、文档
清单、推荐启动顺序和剩余风险。
```

Keep the prompt short because repository instructions and generated task documents carry the details.
Add goal-specific constraints only when they materially affect task boundaries.

### Generate an implementation prompt

Return a compact copyable prompt. Do not repeat the task document. Include only:

```text
请实现 <task>。

开始前完整阅读并严格执行：
- AGENTS.md
- <architecture/coding guidance>
- docs/worktree/README.md
- <selected task document>

确认当前 worktree 基于包含全部前置 PR 的最新 master，分支应为：
<branch>

只完成当前任务，不扩展到其他 PR。按照任务文档完成实现、测试和文档同步。

完成后检查 diff 和敏感信息，commit、push，并使用 gh 创建目标为 master 的 PR。
返回 commit、PR 链接、验证结果和剩余风险；无法创建 PR 时说明具体阻塞。
```

Add task-specific wording only when it prevents a concrete scope error.

### Generate a review prompt

Return a compact copyable prompt that directs the Review Agent to:

- Read `AGENTS.md`, common worktree guidance, and the selected task document.
- Use `gh pr view`, `gh pr diff`, and GitHub Checks.
- Check the task’s explicit acceptance criteria plus dependency direction, security, tests, and docs.
- Remain on `master`; never edit, switch branch, rerun local tests, approve, request changes, or merge.
- Publish severity-ordered findings with file locations, impact, and fixes via `gh pr comment`.
- Comment `Review completed: no blocking findings.` when no blocker exists.
- Return the review conclusion, comment link, CI state, and residual risks.

Do not treat the same-account inability to Approve as a failure. The merge gate is green CI, no
unresolved blocking findings, and the user’s manual merge.

### Review a PR

When explicitly asked to perform review:

1. Resolve the PR number and selected task document.
2. Inspect metadata, commits, changed files, diff, discussion, and checks with read-only `gh` commands.
3. Compare implementation against every acceptance criterion in the task document.
4. Publish one concise review comment. Separate blocking findings from non-blocking suggestions.
5. Do not fix findings. Return them to the original Implementation Agent.

### Advance after merge

After the user reports a manual merge:

1. Verify the merged PR and dependency state when asked to act.
2. Tell the user to update `master` with a fast-forward pull.
3. List only the newly dependency-ready tasks that can start in parallel.
4. Generate prompts only for tasks the user requests; do not flood the conversation with all prompts.

## Validation ownership

- Require each Implementation Agent to run the narrowest relevant tests in its own worktree before
  creating the PR.
- Let GitHub Checks provide independent automated evidence.
- Keep the Review Agent read-only and rely on the diff, author validation record, and CI.
- Reserve root-level cross-package, restart, recovery, backup, and end-to-end validation for the final
  integration task.

## Safety and completion

- Never create a dependent worktree from an unmerged feature branch unless the task documents
  explicitly define a stacked PR.
- Never modify an already-applied migration.
- Never overwrite another worktree’s changes or use destructive Git commands.
- Do not claim a PR, comment, check, or merge exists without confirming it.
- Keep branch, commit, PR URL, checks, findings, and remaining risks visible at handoff.
