# CodeBuddy CLI Tool Definitions

- Source: captured CodeBuddy CLI chat request (`req_4.json`)
- Model: `hy4-preview-f`
- Tool count: 23
- Note: these are sent by the CodeBuddy CLI client as OpenAI-format function-calling tools. They are **NOT** present when calling the bare `/v2/chat/completions` API directly (i.e. without the CLI client).

## 1. Read

Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows CodeBuddy Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as CodeBuddy Code is a multimodal LLM.
- This tool can read PDF files (.pdf). PDFs are processed page by page, extracting both text and visual content for analysis.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "The path to the file to read (can be absolute or relative)"
    },
    "offset": {
      "type": "number",
      "description": "The line number to start reading from. Only provide if the file is too large to read at once"
    },
    "limit": {
      "type": "number",
      "description": "The number of lines to read. Only provide if the file is too large to read at once."
    }
  },
  "required": [
    "file_path"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 2. Write

Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "The path to the file to write (can be absolute or relative)"
    },
    "content": {
      "type": "string",
      "description": "The content to write to the file"
    }
  },
  "required": [
    "file_path",
    "content"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 3. Edit

Performs exact string replacements in files.

Usage:
- This tool reads the file's current contents from disk and matches `old_string` against them directly; a prior `Read` is not required. If `old_string` does not match, read the file to get its latest contents and retry.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.
- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.

CRITICAL REQUIREMENTS:
- The tool will fail if `old_string` and `new_string` are the same
- The tool will fail if `old_string` doesn't match the file contents exactly (including whitespace)
- This tool is for MODIFYING content only - if `old_string` equals `new_string`, you are not making any changes

WARNING:
- NEVER use this tool to "verify" content or as a no-op operation
- NEVER pass identical values for `old_string` and `new_string`
- If you don't need to change anything, don't use this tool
- Make sure the text matches exactly, including whitespace

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "The path to the file to modify (can be absolute or relative)"
    },
    "old_string": {
      "type": "string",
      "description": "The text to replace"
    },
    "new_string": {
      "type": "string",
      "description": "The new text to replace the old text with. must be different from old_string. If they are identical, the tool will fail."
    },
    "replace_all": {
      "type": "boolean",
      "default": false,
      "description": "Replace all occurrences of old_string (default false)"
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 4. Bash

Executes a bash command and returns its output. The working directory persists between commands; shell state (variables, functions, aliases) does not. The shell environment is initialized from the user's profile.

IMPORTANT: The user's default shell is bash. Generate commands using syntax compatible with this shell.

Use this tool for terminal operations (git, package managers, builds, tests, running programs). Unless explicitly instructed, do NOT use it where a dedicated tool exists:
- Read files: Read (NOT cat/head/tail) · Edit files: Edit (NOT sed/awk) · Write files: Write (NOT echo >/cat <<EOF)
- Find files: Glob (NOT find/ls) · Search content: Grep (NOT grep/rg)
- Communicate: output text directly (NOT echo/printf)

# Instructions
- Before creating files or directories, verify the parent directory exists (e.g. with `ls`).
- Quote paths that contain spaces with double quotes.
- Keep the working directory: use absolute paths instead of `cd` unless the user asks. Never prepend `cd <current-directory>` to a command (especially `git`); it is redundant and triggers a permission prompt.
- Timeout: default 120000ms, max 600000ms (tunable via `BASH_DEFAULT_TIMEOUT_MS`). Omit `timeout` for commands that may run long; set it only when the command has a known short upper bound.
- Long-running commands (installs, builds, long tests, servers, watchers): set `run_in_background: true`. You get a task_id and are notified with a `<task-notification>` when it finishes — do not poll or sleep; use TaskOutput only when you need the output and TaskStop to stop it. A foreground command that hits the timeout is auto-backgrounded instead of killed (except `sleep`).
- Never detach processes with `nohup`, `setsid`, `disown` or a trailing `&`: they escape task management and may be killed when the shell or session exits. In non-interactive runs (`-p`) the process exits when your turn ends, so collect background results before finishing.
- Avoid `sleep`. Never retry a failing command in a sleep loop — diagnose the cause. To wait on an external process, use a check command instead.
- Multiple commands: independent → parallel Bash calls in one message; dependent → one call chained with `&&`; use `;` only when earlier failures don't matter. Do not separate commands with newlines (newlines inside quoted strings are fine).
- Commands run non-interactively: never use interactive flags (`git rebase -i`, `git add -i`/`-p`) or commands that wait for input or open an editor.
- If the user, a permission rule, or a security check denies a command, treat it as final: do not retry it or an equivalent through another command, tool, or shell (e.g. no WebFetch after a denied `curl`). Explain what was blocked. The only escalation path is `dangerouslyDisableSandbox` after a sandbox policy failure (see that parameter).
- Git: prefer new commits over `--amend`; before destructive operations (`reset --hard`, `push --force`, `checkout --`) consider safer alternatives; never skip hooks (`--no-verify`) or signing unless the user explicitly asks — if a hook fails, fix the underlying issue. Use the `/commit` or `/commit-push-pr` command for commits and PRs, and `gh` for GitHub URLs, issues, PRs and checks.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The command to execute"
    },
    "timeout": {
      "type": "number",
      "description": "Optional timeout in milliseconds. Omit to use the system default; the effective max is clamped by `BASH_MAX_TIMEOUT_MS` (env) / `settings.env.BASH_MAX_TIMEOUT_MS`. See the tool description for the concrete default/max values active in this session."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice.\nNever use words like \"complex\" or \"risk\" in the description.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n  - ls → \"List files in current directory\"\n  - git status → \"Show working tree status\"\n  - npm install → \"Install package dependencies\"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags):\n  - find . -name \"*.tmp\" -exec rm {} \\; → \"Find and delete all .tmp files recursively\"\n  - git reset --hard origin/main → \"Discard all local changes and match remote main\"\n  - curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"\n\nLanguage MUST follow the <response_language> in system prompt, or the user's input language (most likely Chinese)."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Set to true to run this command in the background. Use TaskOutput to read the output later."
    },
    "dangerouslyDisableSandbox": {
      "type": "boolean",
      "description": "Set to true ONLY when you are confident the command requires operating outside the sandbox and expect the user to approve it.\n\nWhen true, the tool asks the user for explicit consent and — if granted — runs the command with no sandbox isolation. The user can still refuse.\n\nDo NOT set this preemptively. Only use it after a prior sandboxed attempt has failed due to sandbox policy (SANDBOX PERMISSION DENIED in a previous result) or when the task semantically cannot run sandboxed (e.g. installing a system package, modifying files outside the workspace)."
    }
  },
  "required": [
    "command"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 5. Glob

- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Supports pagination with `limit` (max results, default 100) and `offset` (skip N results, default 0) parameters
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "The glob pattern to match files against"
    },
    "path": {
      "type": "string",
      "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
    },
    "limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "default": 100,
      "description": "Maximum number of results to return. Defaults to 100."
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "default": 0,
      "description": "Number of results to skip from the beginning. Defaults to 0."
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 6. Grep

A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Pagination support: Use `head_limit` to limit output (default unlimited) and `offset` to skip first N results (default 0)
  - Use Agent tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "The regular expression pattern to search for in file contents"
    },
    "path": {
      "type": "string",
      "description": "File or directory to search in (rg PATH). Defaults to current working directory."
    },
    "glob": {
      "type": "string",
      "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob"
    },
    "output_mode": {
      "type": "string",
      "enum": [
        "content",
        "files_with_matches",
        "count"
      ],
      "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\"."
    },
    "-B": {
      "type": "integer",
      "minimum": 0,
      "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise."
    },
    "-A": {
      "type": "integer",
      "minimum": 0,
      "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise."
    },
    "-C": {
      "type": "integer",
      "minimum": 0,
      "description": "Alias for context."
    },
    "context": {
      "type": "integer",
      "minimum": 0,
      "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."
    },
    "-n": {
      "type": "boolean",
      "description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise."
    },
    "-i": {
      "type": "boolean",
      "description": "Case insensitive search (rg -i)"
    },
    "type": {
      "type": "string",
      "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types."
    },
    "head_limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). When unspecified, shows all results from ripgrep."
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0."
    },
    "multiline": {
      "type": "boolean",
      "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 7. EnterPlanMode

Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase

**Parameters:**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 8. ExitPlanMode

Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Handling Ambiguity in Plans
Before using this tool, ensure your plan is clear and unambiguous. If there are multiple valid approaches or unclear requirements:
1. Use the AskUserQuestion tool to clarify with the user
2. Ask about specific implementation choices (e.g., architectural patterns, which library to use)
3. Clarify any assumptions that could affect the implementation
4. Edit your plan file to incorporate user feedback
5. Only proceed with ExitPlanMode after resolving ambiguities and updating the plan file

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "allowedPrompts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "tool": {
            "type": "string",
            "enum": [
              "Bash"
            ],
            "description": "The tool this prompt applies to"
          },
          "prompt": {
            "type": "string",
            "description": "Semantic description of the action, e.g. \"run tests\", \"install dependencies\""
          }
        },
        "required": [
          "tool",
          "prompt"
        ],
        "additionalProperties": false
      },
      "description": "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands."
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 9. TaskCreate

Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests task list - When the user directly asks you to use task management
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm**: Present continuous form shown in spinner when task is in_progress (e.g., "Fixing authentication bug"). This is displayed to the user while you work on the task.

**IMPORTANT**: Task descriptions must have two forms:
- subject: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
- activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

## Examples

### Creating a task for a multi-step feature
```json
{
    "subject": "Add dark mode toggle to Settings page",
    "description": "Implement a toggle component in the settings page that allows users to switch between light and dark mode. Should persist preference to localStorage.",
    "activeForm": "Adding dark mode toggle to Settings page"
}
```

### Creating a task for running tests
```json
{
    "subject": "Run tests and ensure they pass",
    "description": "Execute the test suite and verify all tests pass. Fix any failing tests before proceeding."
}
```

## Tips

- Create specific, actionable items
- Break complex tasks into smaller, manageable steps
- Use clear, descriptive task names
- After creating tasks, use TaskList to verify your task list
- Use TaskUpdate to mark tasks as in_progress when starting and completed when done

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string",
      "description": "A brief title for the task"
    },
    "description": {
      "type": "string",
      "description": "A detailed description of what needs to be done"
    },
    "activeForm": {
      "type": "string",
      "description": "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")"
    },
    "metadata": {
      "type": "object",
      "additionalProperties": {},
      "description": "Arbitrary metadata to attach to the task"
    },
    "owner": {
      "type": "string",
      "description": "Task owner (agent name). Use to assign the task to a specific teammate."
    }
  },
  "required": [
    "subject",
    "description"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 10. TaskGet

Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "description": "The ID of the task to retrieve"
    }
  },
  "required": [
    "taskId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 11. TaskUpdate

Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to `deleted` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: `pending` → `in_progress` → `completed`

Use `deleted` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using `TaskGet` before updating it.

## Examples

Mark task as in progress when starting work:
```json
{"taskId": "1", "status": "in_progress"}
```

Mark task as completed after finishing:
```json
{"taskId": "1", "status": "completed"}
```

Delete a task that's no longer needed:
```json
{"taskId": "3", "status": "deleted"}
```

Add a dependency between tasks:
```json
{"taskId": "2", "addBlockedBy": ["1"]}
```

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "description": "The ID of the task to update"
    },
    "subject": {
      "type": "string",
      "description": "New subject for the task"
    },
    "description": {
      "type": "string",
      "description": "New description for the task"
    },
    "activeForm": {
      "type": "string",
      "description": "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")"
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "in_progress",
        "completed",
        "deleted"
      ],
      "description": "New status for the task"
    },
    "addBlocks": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Task IDs that this task blocks"
    },
    "addBlockedBy": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Task IDs that block this task"
    },
    "owner": {
      "type": "string",
      "description": "New owner for the task"
    },
    "metadata": {
      "type": "object",
      "additionalProperties": {},
      "description": "Metadata keys to merge into the task. Set a key to null to delete it."
    }
  },
  "required": [
    "taskId"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 12. WebFetch

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - IMPORTANT: WebFetch is for text-based web content. For direct media or binary URLs, download with Bash, preserve the real extension (infer it from curl's `%{content_type}` if needed), then open with Read.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The URL to fetch content from"
    },
    "prompt": {
      "type": "string",
      "description": "The prompt to run on the fetched content"
    }
  },
  "required": [
    "url",
    "prompt"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 13. WebSearch

- Searches the web and uses the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks
- Use this tool for accessing information beyond the knowledge cutoff
- Searches are performed automatically within a single API call
- You MUST use the current time provided in context when searching for recent information.

When to search:
  - For any factual question about the present-day world, you MUST search before answering; search before EVERY such question.
  - Your confidence on a topic is NOT an excuse to skip search. Present-day facts — who holds a role, what something costs, whether a law still applies, what's newest in a category — cannot come from training data.
  - Even seemingly familiar questions — for example asking about the price of a product or who currently leads a country — can be outdated, because prices and officeholders change frequently.
  - Proactively search instead of answering from your priors and offering to check.

Usage notes:
  - The query must preserve the meaning of the user's request; keep the entity names, versions, dates and terms the user mentioned, and do not substitute or fill them in from prior knowledge.
  - Domain filtering is supported to include or block specific websites.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 2,
      "description": "The search query to use"
    },
    "allowed_domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Only include search results from these domains."
    },
    "blocked_domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Never include search results from these domains"
    },
    "freshness": {
      "type": "string",
      "pattern": "^(?:d(?:[1-9]|[12]\\d|30)?|m(?:[1-9]|1[0-2])?|y[1-5]?)$",
      "description": "Filter search results by time range. Supports d[N], m[N], and y[N] for the last N calendar days, months, and years:\n- d[N]: N is an integer from 1 to 30;\n- m[N]: N is an integer from 1 to 12;\n- y[N]: N is an integer from 1 to 5.\n\nN may be omitted and defaults to 1. The current partial calendar unit counts as 1. For example, d1 means today, m1 means the current month to date, and y1 means the current year to date. Omit this parameter to disable time filtering."
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 14. TaskStop

- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "The ID of the background task to stop. For workers spawned by Agent(), this is the agent_id returned by that call (same string)."
    },
    "shell_id": {
      "type": "string",
      "description": "Deprecated: use task_id instead"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 15. TaskOutput

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "The ID of the background task to retrieve"
    },
    "block": {
      "type": "boolean",
      "description": "Whether to wait for task completion (default: true, up to timeout). Pass false for a non-blocking status check."
    },
    "timeout": {
      "type": "number",
      "default": 60000,
      "description": "Timeout in milliseconds (0-600000, default: 60000)"
    },
    "filter": {
      "type": "string",
      "description": "Optional regex pattern applied only to output read by this call (background shell tasks only)"
    },
    "full": {
      "type": "boolean",
      "description": "Return the current accumulated output snapshot instead of only output added since the previous read (background shell tasks only)"
    }
  },
  "required": [
    "task_id"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 16. DeferExecuteTool

Execute a deferred tool by name. Use this to invoke tools discovered via ToolSearch without needing them in the active tools list.

Usage:
- First use ToolSearch to discover a tool and learn its parameter schema
- Then call this tool with the exact tool name and parameters
- Parameters are validated against the tool's schema before execution
- The target tool's permission checks and hooks are applied normally

Example:
DeferExecuteTool({ toolName: "ImageGen", params: { prompt: "a sunset over mountains" } })

Notes:
- If parameter validation fails, a detailed error with the expected schema is returned
- You can skip ToolSearch if you already know the tool name and parameters from a previous turn
- This tool follows standard permission checks (may require approval depending on permissions configuration)

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "toolName": {
      "type": "string",
      "description": "The exact name of the deferred tool to execute (as returned by ToolSearch)."
    },
    "params": {
      "type": "object",
      "additionalProperties": {},
      "description": "The parameters to pass to the target tool. Must match the tool's parameter schema (as returned by ToolSearch in a previous turn)."
    }
  },
  "required": [
    "toolName",
    "params"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 17. SendMessage

# SendMessageTool

Send messages to agent teammates and handle protocol requests/responses in a team.

## Message Types

### type: "message" - Send a Direct Message

Send a message to a **single specific teammate**. You MUST specify the recipient.

**IMPORTANT for teammates**: Your plain text output is NOT visible to the team lead or other teammates. To communicate with anyone on your team, you **MUST** use this tool. Just typing a response or acknowledgment in text is not enough.

```
{
  "type": "message",
  "recipient": "researcher",
  "content": "Your message here",
  "summary": "Brief status update on auth module"
}
```

- **recipient**: The name of the teammate to message (required)
- **content**: The message text (required)
- **summary**: A 5-10 word summary shown as preview in the UI (required)

### type: "broadcast" - Send Message to ALL Teammates (USE SPARINGLY)

Send the **same message to everyone** on the team at once.

**WARNING: Broadcasting is expensive.** Each broadcast sends a separate message to every teammate, which means:
- N teammates = N separate message deliveries
- Each delivery consumes API resources
- Costs scale linearly with team size

```
{
  "type": "broadcast",
  "content": "Message to send to all teammates",
  "summary": "Critical blocking issue found"
}
```

- **content**: The message content to broadcast (required)
- **summary**: A 5-10 word summary shown as preview in the UI (required)

**CRITICAL: Use broadcast only when absolutely necessary.** Valid use cases:
- Critical issues requiring immediate team-wide attention (e.g., "stop all work, blocking bug found")
- Major announcements that genuinely affect every teammate equally

**Default to "message" instead of "broadcast".** Use "message" for:
- Responding to a single teammate
- Normal back-and-forth communication
- Following up on a task with one person
- Sharing findings relevant to only some teammates
- Any message that doesn't require everyone's attention

### type: "shutdown_request" - Request a Teammate to Shut Down

Use this to ask a teammate to gracefully shut down:

```
{
  "type": "shutdown_request",
  "recipient": "researcher",
  "content": "Task complete, wrapping up the session"
}
```

The teammate will receive a shutdown request and can either approve (exit) or reject (continue working).

### type: "shutdown_response" - Respond to a Shutdown Request

#### Approve Shutdown

When you receive a shutdown request as a JSON message with `type: "shutdown_request"`, you **MUST** respond to approve or reject it. Do NOT just acknowledge the request in text - you must actually call this tool.

```
{
  "type": "shutdown_response",
  "request_id": "abc-123",
  "approve": true
}
```

**IMPORTANT**: Extract the `requestId` from the JSON message and pass it as `request_id` to the tool. Simply saying "I'll shut down" is not enough - you must call the tool.

This will send confirmation to the leader and terminate your process.

#### Reject Shutdown

```
{
  "type": "shutdown_response",
  "request_id": "abc-123",
  "approve": false,
  "content": "Still working on task #3, need 5 more minutes"
}
```

The leader will receive your rejection with the reason.

### type: "plan_approval_response" - Approve or Reject a Teammate's Plan

#### Approve Plan

When a teammate with `plan_mode_required` calls ExitPlanMode, they send you a plan approval request as a JSON message with `type: "plan_approval_request"`. Use this to approve their plan:

```
{
  "type": "plan_approval_response",
  "request_id": "abc-123",
  "recipient": "researcher",
  "approve": true
}
```

After approval, the teammate will automatically exit plan mode and can proceed with implementation.

#### Reject Plan

```
{
  "type": "plan_approval_response",
  "request_id": "abc-123",
  "recipient": "researcher",
  "approve": false,
  "content": "Please add error handling for the API calls"
}
```

The teammate will receive the rejection with your feedback and can revise their plan.

## Important Notes

- Messages from teammates are automatically delivered to you. You do NOT need to manually check your inbox.
- When reporting on teammate messages, you do NOT need to quote the original message - it's already rendered to the user.
- **IMPORTANT**: Always refer to teammates by their NAME (e.g., "team-lead", "researcher", "tester"), never by UUID.
- Do NOT send structured JSON status messages. Use TaskUpdate to mark tasks completed and the system will automatically send idle notifications when you stop.

## Background Agent Usage

This tool is also available to **background agents** launched via the Agent tool with `run_in_background: true`. Background agents should use this tool to send their results back to the main agent:

```
{
  "type": "message",
  "recipient": "main",
  "content": "Here are my findings: ...",
  "summary": "Completed analysis of auth module"
}
```

- **recipient**: Use `"main"` to send results back to the main agent
- The main agent will automatically receive and process the message

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "message",
        "broadcast",
        "shutdown_request",
        "shutdown_response",
        "plan_approval_response"
      ],
      "description": "Message type: \"message\" for DMs, \"broadcast\" to all teammates, \"shutdown_request\" to request shutdown, \"shutdown_response\" to respond to shutdown, \"plan_approval_response\" to approve/reject plans"
    },
    "recipient": {
      "type": "string",
      "description": "Agent name of the recipient (required for message, shutdown_request, plan_approval_response)"
    },
    "content": {
      "type": "string",
      "description": "Message text, reason, or feedback"
    },
    "summary": {
      "type": "string",
      "description": "A 5-10 word summary of the message, shown as a preview in the UI (required for message, broadcast)"
    },
    "request_id": {
      "type": "string",
      "description": "Request ID to respond to (required for shutdown_response, plan_approval_response)"
    },
    "approve": {
      "type": "boolean",
      "description": "Whether to approve the request (required for shutdown_response, plan_approval_response)"
    }
  },
  "required": [
    "type"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 18. LibraryUpload

Add a single local file to the user's library as a new item so it can be searched, cited, and opened later.

Usage:
- path must be an absolute path (or a file:// URI) to the local file the user wants to upload (attachments often live outside the workspace; pass the user's path as-is). Relative paths are rejected.
- file_name is optional and only changes the display name shown in the library; if given, its extension must match the file's extension.
- parent_id is optional. Omit it to use the server-side default target. Do not invent folder or space ids.
- The item type is chosen from the file extension: .md/.markdown -> document, .csv -> table, .html/.htm -> saved page, anything else -> the original file.
- The uploaded item stays private to the user: this tool does not create share links or change permissions.
- Files up to 100 MiB are supported. Use this tool only when the user asks to upload, save, add, or attach a specific local file to their library.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute path (or file:// URI) of the local file to upload, e.g. \"/Users/me/report.pdf\". Pass the path the user gave as-is: files outside the workspace are supported."
    },
    "file_name": {
      "type": "string",
      "description": "Optional name shown in the library. Defaults to the file basename; if given, its extension must match the file."
    },
    "parent_id": {
      "type": "string",
      "description": "Optional target folder/node id. Omit and the server resolves the default target."
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 19. WaitForMcpServers

Wait for MCP servers that are still connecting and whose tools are not
yet in your tool list. Pass `servers` to wait for specific ones, or omit
it to wait for all pending servers.

If the user's request needs tools from a still-connecting server, call this
tool to wait for it. Once it connects, its tools will be added to your tool
list and you can use them directly. Returns ready=true when servers are
ready, ready=false if they failed to connect, need authentication, or are
disabled.

You do not need to ask the user for confirmation to use this tool.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "servers": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Server names to wait for (default: all pending)"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 20. Agent

Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. (Tools: *)
- statusline-setup: Use this agent to configure the user's Codebuddy Code status line setting.(Tools:Read,Write,Edit,ToolSearch,DeferExecuteTool,SendMessage,MessageColleague,SpeakInChannel,ChannelTasks,CreateColleague,CreateChannel,ListColleagues,ExitPlanMode)
- Explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.(Tools:Read,Bash,PowerShell,Glob,Grep,TaskCreate,TaskGet,TaskUpdate,TaskList,WebFetch,WebSearch,Skill,SendMessage,SendUserMessage,ToolSearch,DeferExecuteTool,MessageColleague,SpeakInChannel,ChannelTasks,CreateColleague,CreateChannel,ListColleagues,ExitPlanMode)
- Plan: Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a multi-step task before writing code. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs. Read-only: it designs but does not modify files or exit plan mode; the caller reviews the plan and implements it.(Tools:Read,Bash,Glob,Grep,TaskCreate,TaskGet,TaskUpdate,TaskList,WebFetch,WebSearch,Skill,ToolSearch,DeferExecuteTool,TeamCreate,TeamDelete,SendMessage,SendUserMessage,MessageColleague,SpeakInChannel,ChannelTasks,CreateColleague,CreateChannel,ListColleagues,ExitPlanMode)

When using the Agent tool, you can specify a subagent_type parameter to select which agent type to use. If omitted, it defaults to "general-purpose" which runs with an independent context.
**Fork mode (subagent_type="fork")**: When you explicitly set subagent_type to "fork", the agent inherits your full context (system prompt, tools, conversation history). This is ideal for:
- Tasks that require the same tools and context as the current conversation
- Tasks where the agent needs to understand the full conversation history to proceed

Only use fork mode when inheriting context is essential. For most tasks (code review, exploration, research, generation), prefer specifying a concrete agent type or omitting subagent_type to get an independent agent.

When NOT to use the Agent tool:
- If you want to read a specific file path, use the Read tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Bash tool (`grep -rn` / `rg`) instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- You can optionally run agents in the background using the `run_in_background` parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.
- To continue a previously spawned agent, use SendMessage with the agent's name as the `recipient` field — that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent.
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
## Spawning Teammates

When a team is active (created via TeamCreate), you can spawn teammates by providing the `name` and optionally `team_name` parameters:

- `name`: Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.
- `subagent_type`: The type of specialized agent to use for this task. If omitted, the general-purpose agent is used.
- `team_name`: Team name for spawning. Uses current team context if omitted.
- `mode`: Permission mode for the spawned teammate (e.g., "plan" to require plan approval)
- `max_turns`: Maximum number of agentic turns (API round-trips) before the agent stops

## Choosing Agent Types for Teammates

When spawning teammates via the Agent tool, choose the `subagent_type` based on what tools the agent needs for its task. Each agent type has a different set of available tools — match the agent to the work:
- **Read-only agents** (e.g., Explore, Plan) cannot edit or write files. Only assign them research, search, or planning tasks. Never assign them implementation work.
- **Full-capability agents** (e.g., general-purpose) have access to all tools including file editing, writing, and bash. Use these for tasks that require making changes.
- **Custom agents** defined in `.codebuddy/agents/` may have their own tool restrictions. Check their descriptions to understand what they can and cannot do.
Always review the agent type descriptions and their available tools listed in the Agent tool prompt before selecting a `subagent_type` for a teammate.

Teammates always run in the background in detached mode. They communicate via the SendMessage tool and coordinate through the shared task list.

Example usage:

<example_agent_descriptions>
"code-reviewer": use this agent after you are done writing a significant piece of code
"greeting-responder": use this agent to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the code-reviewer agent to run the tests
</commentary>
assistant: Uses the Agent tool to launch the code-reviewer agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Agent tool to launch the greeting-responder agent"
</example>

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "A short (3-5 word) description of the task. Defaults to `name` when omitted."
    },
    "prompt": {
      "type": "string",
      "description": "The task for the agent to perform"
    },
    "subagent_type": {
      "type": "string",
      "description": "The type of specialized agent to use for this task"
    },
    "model": {
      "type": "string",
      "minLength": 1,
      "description": "Model to use for this agent. Accepts a model ID, name, alias, or a routing value: \"default\" inherits from the parent, \"lite\" favors fast and cost-effective models, and \"reasoning\" favors enhanced reasoning models."
    },
    "resume": {
      "type": "string",
      "description": "Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript."
    },
    "name": {
      "type": "string",
      "description": "Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running. The name \"team-lead\" is reserved for the leader created by TeamCreate — do NOT use it for spawned teammates; pick a role-based name like \"pm\", \"ui-designer\", \"fe-dev\", etc. Names must be unique within a team."
    },
    "team_name": {
      "type": "string",
      "description": "Deprecated; ignored. The session has a single implicit active team."
    },
    "mode": {
      "type": "string",
      "enum": [
        "acceptEdits",
        "bypassPermissions",
        "default",
        "plan",
        "dontAsk",
        "auto"
      ],
      "description": "Permission mode for spawned teammate (e.g., \"plan\" to require plan approval)."
    },
    "max_turns": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "description": "Maximum number of agentic turns (API round-trips) before stopping."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Set to true to run this agent in the background. Use TaskOutput to read the output later."
    }
  },
  "required": [
    "prompt"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 21. TaskList

Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.

## Task List Coordination (Teams)

When working in a team, all teammates share the same task list. Teammates should:
1. Check TaskList periodically, **especially after completing each task**, to find available work or see newly unblocked tasks
2. Claim unassigned, unblocked tasks with TaskUpdate (set `owner` to your name). **Prefer tasks in ID order** (lowest ID first)
3. Create new tasks with TaskCreate when identifying additional work
4. Mark tasks as completed with TaskUpdate when done, then check TaskList for next work
5. Coordinate with other teammates by reading the task list status
6. If all available tasks are blocked, notify the team lead or help resolve blocking tasks

**Parameters:**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 22. Skill

Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills below match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - `skill: "pdf"` - invoke the pdf skill
  - `skill: "commit", args: "-m 'Fix bug'"` - invoke with arguments
  - `skill: "ms-office-suite:pdf"` - invoke using fully qualified name

Important:
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
- If the name matches a deferred tool listed in <available_deferred_tools> (e.g., "Workflow"), do NOT use this Skill tool — use ToolSearch + DeferExecuteTool instead

<available_skills>
skills under folder: (built-in)
- clear: Start a fresh conversation (previous chats remain accessible via /resume)
- config: Manage settings. Subcommands: "list" to show current settings, "get <key>" to read a value, "set <key> <value>" to change a value
- gateway: Manage the remote control gateway. Subcommands: "status" to show current status, "stop" to stop the gateway, "token" to regenerate access token, "tunnel" to start with tunnel
- goal: Keep working until a condition is met. Use "/goal clear" to stop early. Example: /goal all tests pass
- help: Show help and available commands
- model: Set or list AI models. Use "list" to show available models with current selection, or specify a model id to switch (e.g., /model gpt-4o)
- model:lite: Set or list the lite (fast/cheap) scenario model used by Explore and other lightweight sub-tasks
- model:reasoning: Set or list the reasoning (enhanced) scenario model used for complex analysis
- plan: Preview the current plan file content
- rename: Rename the current conversation. Requires a name argument (e.g., /rename my-session)
- resume: List or resume sessions. Use "list" to show all sessions with ids, or specify a session id to resume (e.g., /resume <session-id>)
- skills: List available skills
- status: Show CodeBuddy status including version, model, account, API connectivity, and tool statuses
- tasks: List and manage background tasks
- todos: Display the current session's todo list
- theme: Config CodeBuddy Code Theme
- output-style: Set the output style directly or from a selection menu
- model:text-to-image: Set or list text-to-image models. Use "list" to show available models, or specify a model id to switch
- model:image-to-image: Set or list image-to-image models. Use "list" to show available models, or specify a model id to switch
- model:text-to-video: Set or list text-to-video models. Use "list" to show available models, or specify a model id to switch
- model:image-to-video: Set or list image-to-video models. Use "list" to show available models, or specify a model id to switch
- loop: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)
</available_skills>

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "skill": {
      "type": "string",
      "description": "The skill name. E.g., \"commit\", \"review-pr\", or \"pdf\""
    },
    "command": {
      "type": "string",
      "description": "(Legacy) The skill name (no arguments). E.g., \"pdf\" or \"xlsx\""
    },
    "args": {
      "type": "string",
      "description": "Optional arguments for the skill"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## 23. ToolSearch

Load tool schemas before invoking deferred tools.

Deferred tools are NOT directly callable — use ToolSearch to load their schema, then DeferExecuteTool to invoke.

## Lookup modes

1. Exact (preferred): `tool_names: ["ImageGen"]` — use when you know the tool name.
2. Search: `queries: ["image generation"]` — use when unsure which tool fits.

## Rules
- Known tool name → use `tool_names`, never guess parameters without loading schema.
- Found tools are invoked via DeferExecuteTool with validated parameters.

The following deferred tools are available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with `tool_names` to load schemas before calling them:

<available_deferred_tools>
Artifact: Upload a local HTML or Markdown file and publish it as an artifact: a shareable public link that renders the page. Use when the user wants a shareable link / 分享链接 / to publish a single document. Supports one .html/.htm or .md/.markdown file (not directories); Markdown is rendered server-side. Pass existingShareLink to update a previously published artifact in place.
ArtifactControl: Unpublish an artifact created by the Artifact tool: make a previously published HTML page or Markdown document private so its public link stops working. This is currently the ONLY control action (no list/delete/permission-edit yet). Handles both HTML page links (workbuddy.link/p/...) and Markdown document links (workbuddy.cn/space/d/...). Accepts either the full share link URL or its bare nodeId. Use when the user wants to unpublish / take down / 取消分享 / 设为私密 a shared link.
CronCreate: Schedule a prompt to run at a future time — either recurring on a cron schedule, or once at a specific time. Defaults to session-only (the job dies when this codebuddy code session ends); pass durable=true to persist the job so it keeps running after the session exits.
CronDelete: Cancel a scheduled cron job by ID. Removes it from the in-memory session store.
CronList: List all scheduled cron jobs in this session.
EnterWorktree: Create an isolated git worktree and switch the current session into it. Pass a `path` to switch into an existing worktree instead of creating a new one.
ImageGen: Generate images from text descriptions using AI models.
LeaveWorktree: Leave the current worktree session and switch back to the original working directory.
LSP: Interact with Language Server Protocol (LSP) servers to get code intelligence features.
Monitor: Run a command in the background and get woken up with its incremental output, or open a WebSocket and treat each incoming message as an event, so you can react to log entries, test output, or pushed events mid-conversation.
NotebookEdit: Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source.
PushNotification: Send a desktop/terminal notification to the user so they can be reached when a long-running or background task finishes.
ReportFindings: Report code-review findings as a structured list, with a file, summary, and failure scenario per finding, so the results are rendered as a dedicated list instead of plain text. Call this when active code-review instructions ask you to report findings.
TeamCreate: Create a new team to coordinate multiple agents working on a project. Use when tasks benefit from parallel work by multiple specialized agents.
TeamDelete: Remove team and task directories when the swarm work is complete. Refuses if any teammate is still actively running — gracefully shut them down first via SendMessage with type=shutdown_request.
VideoGen: Generates short videos from text descriptions or input images and saves them locally as MP4 files.
Workflow: Run a Dynamic Workflow — opt-in only. See `/workflows` and `ultracode` keyword.
</available_deferred_tools>

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "queries": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Keyword-based search query using MiniSearch full-text search engine. Supports prefix matching, fuzzy matching, and relevance ranking. Must be an array of keyword strings.For better results, include BOTH Chinese and English keywords (e.g., [\"获取时间\", \"get time\"] or [\"文件搜索\", \"file search\", \"glob\"])."
    },
    "tool_names": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Exact, fully-qualified tool name(s) to look up — e.g., [\"mcp__time__current_time\", \"LSP\", \"mcp__cnb__cnb_create_pull\"]. Do NOT use partial names, descriptions, or keywords."
    },
    "top_k": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 20,
      "default": 3,
      "description": "Maximum number of tools to return with full details (default: 3, max: 20). Only applies when using \"queries\". Ignored when using \"tool_names\". Additional matching tools beyond this limit are shown as additional candidates."
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```
