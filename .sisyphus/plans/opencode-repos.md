# OpenCode Repos Plugin

## Context

### Original Request
Create an OpenCode plugin to manage repository references for AI agents. Currently, the user manually clones repos for reference, sometimes reuses them, and the workflow is inefficient. The plugin should cache GitHub repos and auto-discover local repos already on the filesystem.

**Core Use Case**: Agent working in Project A (e.g., backend) needs to understand Project B (e.g., firmware/frontend) to integrate properly. The plugin provides infrastructure to quickly access and explore cross-project codebases, enabling agents to understand underlying code and write proper integration code.

### Interview Summary
**Key Discussions**:
- Storage: Global cache at `~/.cache/opencode-repos/` with manifest
- Config: `~/.config/opencode/opencode-repos.json` for search paths
- Repo format: Short name `vercel/next.js`, with branch support `vercel/next.js@canary`
- Auth: SSH for private repos (leverage existing keys)
- Clone strategy: Shallow by default (depth=1), separate dirs per branch
- Discovery: Smart clone checks cache -> local index -> clone fresh
- Local scan: Uses `fd` to find repos in configured search paths

**Research Findings**:
- tmux plugin pattern: ~480 lines single file, stateless, Zod schemas
- rate-limit plugin: multi-file, event hooks, config loading
- npm name `opencode-repos` is available
- Plugin receives `$` (Bun shell) for command execution
- **CRITICAL**: oh-my-opencode plugin shows plugins CAN define custom agents via `config` handler
- Agents are registered by modifying `config.agent` in the config handler
- `AgentConfig` from `@opencode-ai/sdk` defines agent structure

### Metis Review
**Identified Gaps** (addressed):
- SSH auth in plugin context: Added validation task before implementation
- Concurrency: Added file locking for manifest writes
- Error recovery: Added cleanup for partial clones
- Git edge cases: Disable hooks, no submodules, shallow only
- Config validation: Handle missing/invalid gracefully
- Phased approach: MVP first (clone, list, read), then scan/update

### OpenCode Plugin API Discovery (from oh-my-opencode analysis)
**Custom Agent Registration Pattern**:
```typescript
// Plugins can define custom agents via config handler
const plugin: Plugin = async (ctx) => {
  return {
    config: async (config) => {
      config.agent = {
        ...config.agent,
        "repo-explorer": {
          description: "Specialized agent for exploring external codebases",
          mode: "subagent",
          model: "anthropic/claude-sonnet-4-5",
          temperature: 0.1,
          permission: { edit: "deny", write: "deny", task: "deny" },
          prompt: "You are a codebase exploration specialist..."
        }
      }
    },
    tool: { /* tools */ }
  }
}
```

**AgentConfig Interface** (from @opencode-ai/sdk):
- `description`: What the agent does
- `mode`: "primary" | "subagent"
- `model?`: Model to use
- `temperature?`: Sampling temperature
- `permission?`: Tool permissions (allow/deny/ask per tool)
- `prompt`: System prompt for the agent
- `tools?`: Tool whitelist

---

## Work Objectives

### Core Objective
Build an OpenCode plugin that provides agents with efficient cross-codebase intelligence through:
1. **Tools** for repo management (clone, list, read, scan, update, remove)
2. **Custom `repo-explorer` agent** purpose-built for exploring external codebases
3. **`repo_explore` tool** that spawns the explorer agent in a repo's context

The goal is enabling agents to deeply understand other projects (firmware, dependencies, related services) to write proper integration code.

### Concrete Deliverables
- `~/personal/projects/opencode-repos/index.ts` - Main plugin file with tools + config handler
- `~/personal/projects/opencode-repos/package.json` - Package manifest
- `~/personal/projects/opencode-repos/tsconfig.json` - TypeScript config
- `~/personal/projects/opencode-repos/README.md` - Documentation
- `~/personal/projects/opencode-repos/src/manifest.ts` - Manifest types and operations
- `~/personal/projects/opencode-repos/src/git.ts` - Git operations
- `~/personal/projects/opencode-repos/src/scanner.ts` - Local repo scanner
- `~/personal/projects/opencode-repos/src/agents/repo-explorer.ts` - Explorer agent definition
- `~/personal/projects/opencode-repos/src/__tests__/manifest.test.ts` - Manifest tests
- `~/personal/projects/opencode-repos/src/__tests__/git.test.ts` - Git operation tests

### Definition of Done
- [x] `bun test` passes with all tests green
- [x] Plugin loads in OpenCode without errors
- [x] Can clone public repo via `repo_clone("vercel/next.js")`
- [x] Can clone private repo via SSH
- [x] Can list cached repos via `repo_list`
- [x] Can read files via `repo_read`
- [x] Can scan local repos via `repo_scan`
- [x] `repo-explorer` agent appears in agent list
- [x] Can explore a repo via `repo_explore("vercel/next.js", "How does routing work?")`
- [x] Reference in opencode.jsonc works: `file:///Users/liamvinberg/personal/projects/opencode-repos/index.ts`

### Must Have
- Smart clone (check cache -> local -> clone fresh)
- Shallow clones only (depth=1)
- SSH auth support for private repos
- Manifest persistence with atomic writes
- File locking for concurrent access
- Branch support with separate directories
- Local repo discovery via fd
- Configurable search paths
- Metadata tracking (clone date, last accessed, size, etc.)
- **Custom `repo-explorer` agent** for cross-codebase exploration
- **`repo_explore` tool** that spawns explorer in repo context
- **Config handler** to register the agent

### Must NOT Have (Guardrails)
- No GitHub/GitLab API integration (pure git only)
- No auto-clone on `repo_read` (explicit clone required)
- No submodule support (v1 limitation)
- No LFS support (document as limitation)
- No commit/push/branch creation (read-only)
- No search within repos (use existing grep/glob tools)
- No multiple remotes per repo
- No auto-update on access
- No depth override (shallow only)
- No diff/blame features (use git directly)

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: NO (new project)
- **User wants tests**: Basic tests with bun test
- **Framework**: bun test (built-in)

### Test Setup
```bash
bun init  # Creates package.json with test support
bun test  # Built-in test runner
```

### Test Structure
Each TODO includes test requirements. Tests focus on:
1. Manifest operations (parse, write, lock)
2. Git operations (clone, update)
3. Scanner operations (find repos, match remotes)

---

## Task Flow

```
0. Setup project
     |
1. Manifest types/ops --> 2. Git operations (parallel)
     |                         |
     v                         v
3. Tool: repo_clone (depends on 1, 2)
     |
4. Tool: repo_list --> 5. Tool: repo_read (parallel)
     |
6. Scanner module
     |
7. Tool: repo_scan
     |
8. Tools: repo_update, repo_remove (parallel)
     |
9. Agent: repo-explorer definition
     |
10. Tool: repo_explore + Config handler
     |
11. Documentation
```

## Parallelization

| Group | Tasks | Reason |
|-------|-------|--------|
| A | 1, 2 | Independent modules |
| B | 4, 5 | Independent tools after repo_clone |
| C | 8a, 8b | Independent tools after scan |

| Task | Depends On | Reason |
|------|------------|--------|
| 3 | 1, 2 | Uses manifest and git modules |
| 4-5 | 3 | Need clone working first |
| 7 | 6 | Scanner tool needs scanner module |
| 8 | 7 | Update/remove build on full foundation |
| 9 | 5 | Agent needs repo_read to work |
| 10 | 9 | Tool needs agent definition |
| 11 | 10 | Docs after all features complete |

---

## TODOs

- [x] 0. Setup project structure

  **What to do**:
  - Create directory `~/personal/projects/opencode-repos/`
  - Initialize with `bun init`
  - Create `tsconfig.json` matching tmux plugin pattern
  - Add `@opencode-ai/plugin` as peer and dev dependency
  - Create `src/` directory for modules
  - Create `src/__tests__/` directory for tests

  **Must NOT do**:
  - Don't add unnecessary dependencies
  - Don't deviate from tmux plugin structure

  **Parallelizable**: NO (foundation for all other tasks)

  **References**:
  
  **Pattern References**:
  - `~/personal/projects/opencode-tmux/package.json:1-28` - Package structure pattern
  - `~/personal/projects/opencode-tmux/tsconfig.json` - TypeScript config pattern
  
  **Acceptance Criteria**:
  - [x] Directory exists at `~/personal/projects/opencode-repos/`
  - [x] `package.json` has name `opencode-repos`, type `module`
  - [x] `@opencode-ai/plugin` in peerDependencies and devDependencies
  - [x] `tsconfig.json` targets ES2022
  - [x] `bun test` runs (even with no tests yet)

  **Commit**: YES
  - Message: `chore: initial project setup`
  - Files: `package.json`, `tsconfig.json`
  - Pre-commit: `bun test`

---

- [x] 1. Implement manifest types and operations

  **What to do**:
  - Define TypeScript interfaces for manifest structure
  - Implement manifest read/write with atomic operations
  - Implement file locking using lockfile
  - Handle missing/corrupted manifest gracefully
  - Write tests for manifest operations

  **Must NOT do**:
  - Don't use complex database (simple JSON)
  - Don't skip file locking

  **Parallelizable**: YES (with task 2)

  **References**:
  
  **Pattern References**:
  - `~/personal/projects/opencode-rate-limit-fallback/src/config.ts` - Config loading pattern with fallbacks
  
  **Type Definitions**:
  ```typescript
  interface RepoEntry {
    type: 'cached' | 'local'
    path: string
    clonedAt?: string      // ISO timestamp
    lastAccessed: string   // ISO timestamp
    lastUpdated?: string   // ISO timestamp
    sizeBytes?: number
    defaultBranch: string
    shallow: boolean
  }

  interface Manifest {
    version: 1
    repos: Record<string, RepoEntry>  // key: "owner/repo@branch"
    localIndex: Record<string, string> // remote URL -> local path
  }

  interface Config {
    localSearchPaths: string[]
  }
  ```
  
  **External References**:
  - https://www.npmjs.com/package/proper-lockfile - File locking pattern (reference only, implement manually with Bun)

  **Acceptance Criteria**:
  - [x] `src/manifest.ts` exports: `loadManifest`, `saveManifest`, `withManifestLock`
  - [x] Creates manifest if not exists with empty repos
  - [x] Atomic writes (write to .tmp, rename)
  - [x] File locking prevents concurrent writes
  - [x] `bun test src/__tests__/manifest.test.ts` passes

  **Commit**: YES
  - Message: `feat: implement manifest operations with locking`
  - Files: `src/manifest.ts`, `src/__tests__/manifest.test.ts`
  - Pre-commit: `bun test`

---

- [x] 2. Implement git operations module

  **What to do**:
  - Implement `cloneRepo(url, destPath, options)` with shallow clone
  - Implement `updateRepo(path)` with fetch + reset
  - Implement `getRepoInfo(path)` to get remote, branch, etc.
  - Implement `parseRepoSpec(spec)` to parse `owner/repo@branch`
  - Disable git hooks on clone
  - Handle errors gracefully with cleanup
  - Write tests for git operations

  **Must NOT do**:
  - Don't support submodules
  - Don't allow depth override
  - Don't add push/commit operations
  - Don't execute git hooks

  **Parallelizable**: YES (with task 1)

  **References**:
  
  **Pattern References**:
  - `~/personal/projects/opencode-tmux/index.ts:74-94` - Bun shell command execution pattern
  
  **Implementation Details**:
  ```typescript
  // Clone command pattern
  await $`git clone --depth=1 --single-branch --branch ${branch} --config core.hooksPath=/dev/null ${url} ${destPath}`
  
  // Update command pattern
  await $`git -C ${path} fetch origin ${branch} --depth=1`
  await $`git -C ${path} reset --hard origin/${branch}`
  ```

  **Acceptance Criteria**:
  - [x] `src/git.ts` exports: `cloneRepo`, `updateRepo`, `getRepoInfo`, `parseRepoSpec`, `buildGitUrl`
  - [x] `cloneRepo` always uses `--depth=1`
  - [x] `cloneRepo` disables hooks via `--config core.hooksPath=/dev/null`
  - [x] `cloneRepo` cleans up on failure (removes partial directory)
  - [x] `parseRepoSpec("vercel/next.js@canary")` returns `{ owner: "vercel", repo: "next.js", branch: "canary" }`
  - [x] `parseRepoSpec("vercel/next.js")` returns `{ owner: "vercel", repo: "next.js", branch: null }`
  - [x] `buildGitUrl` returns SSH URL: `git@github.com:owner/repo.git`
  - [x] `bun test src/__tests__/git.test.ts` passes

  **Commit**: YES
  - Message: `feat: implement git operations module`
  - Files: `src/git.ts`, `src/__tests__/git.test.ts`
  - Pre-commit: `bun test`

---

- [x] 3. Implement repo_clone tool

  **What to do**:
  - Create main plugin export in `index.ts`
  - Implement `repo_clone` tool with Zod schema
  - Smart flow: check manifest -> clone if not exists -> return path
  - Update manifest with new entry
  - Track lastAccessed on every clone call
  - Validate SSH auth works for private repos

  **Must NOT do**:
  - Don't auto-clone in other tools
  - Don't clone if already exists (return cached path)

  **Parallelizable**: NO (depends on 1, 2)

  **References**:
  
  **Pattern References**:
  - `~/personal/projects/opencode-tmux/index.ts:242-261` - Plugin export pattern
  - `~/personal/projects/opencode-tmux/index.ts:276-323` - Tool definition with Zod schema
  
  **Tool Signature**:
  ```typescript
  repo_clone: tool({
    description: "Clone a repository to local cache or return path if already cached. Supports public and private (SSH) repos.",
    args: {
      repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
      force: tool.schema.boolean().optional().default(false).describe("Force re-clone even if cached"),
    },
    async execute(args) {
      // 1. Parse repo spec
      // 2. Check manifest for existing entry
      // 3. If exists and !force, update lastAccessed, return path
      // 4. If force or !exists, clone to cache
      // 5. Update manifest
      // 6. Return path and status
    }
  })
  ```

  **Acceptance Criteria**:
  - [x] `index.ts` exports plugin following tmux pattern
  - [x] `repo_clone("vercel/next.js")` clones to `~/.cache/opencode-repos/vercel/next.js@main/`
  - [x] `repo_clone("vercel/next.js@canary")` clones to `~/.cache/opencode-repos/vercel/next.js@canary/`
  - [x] Second call to same repo returns cached path without cloning
  - [x] `force: true` re-clones even if cached
  - [x] Manifest updated after successful clone
  - [x] Returns markdown with path and status

  **Commit**: YES
  - Message: `feat: implement repo_clone tool`
  - Files: `index.ts`
  - Pre-commit: `bun test`

---

- [x] 4. Implement repo_list tool

  **What to do**:
  - Add `repo_list` tool to plugin
  - List all repos from manifest (cached + local)
  - Show metadata: type, path, dates, size
  - Format as markdown table
  - Support filtering by type (cached/local/all)

  **Must NOT do**:
  - Don't calculate size on every call (use cached value)
  - Don't scan filesystem (use manifest only)

  **Parallelizable**: YES (with task 5)

  **References**:
  
  **Pattern References**:
  - `~/personal/projects/opencode-tmux/index.ts:414-471` - tmux_list tool pattern with scoped output
  
  **Tool Signature**:
  ```typescript
  repo_list: tool({
    description: "List all registered repositories (cached and local)",
    args: {
      type: tool.schema.enum(["all", "cached", "local"]).optional().default("all"),
    },
    async execute(args) {
      // Load manifest
      // Filter by type
      // Format as markdown table
    }
  })
  ```

  **Output Format**:
  ```markdown
  ## Registered Repositories
  
  | Repo | Type | Branch | Last Accessed | Size |
  |------|------|--------|---------------|------|
  | vercel/next.js | cached | canary | 2024-01-20 | 52MB |
  | my-project | local | main | 2024-01-19 | - |
  
  Total: 2 repos (1 cached, 1 local)
  ```

  **Acceptance Criteria**:
  - [x] `repo_list()` returns markdown table of all repos
  - [x] `repo_list({ type: "cached" })` filters to cached only
  - [x] Shows repo name, type, branch, last accessed, size
  - [x] Returns "No repositories registered" if empty

  **Commit**: YES
  - Message: `feat: implement repo_list tool`
  - Files: `index.ts`
  - Pre-commit: `bun test`

---

- [x] 5. Implement repo_read tool

  **What to do**:
  - Add `repo_read` tool to plugin
  - Read file(s) from a registered repo
  - Validate repo exists in manifest
  - Update lastAccessed timestamp
  - Support glob patterns for multiple files

  **Must NOT do**:
  - Don't auto-clone if repo not found (error instead)
  - Don't read binary files (skip with warning)

  **Parallelizable**: YES (with task 4)

  **References**:
  
  **Pattern References**:
  - `~/personal/projects/opencode-tmux/index.ts:277-323` - Tool with multiple optional args
  
  **Tool Signature**:
  ```typescript
  repo_read: tool({
    description: "Read files from a registered repository. Repo must be cloned first via repo_clone.",
    args: {
      repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
      path: tool.schema.string().describe("File path within repo, supports glob patterns"),
      maxLines: tool.schema.number().optional().default(500).describe("Max lines per file"),
    },
    async execute(args) {
      // 1. Look up repo in manifest
      // 2. Error if not found
      // 3. Resolve path within repo
      // 4. Read file(s)
      // 5. Update lastAccessed
      // 6. Return content
    }
  })
  ```

  **Acceptance Criteria**:
  - [x] `repo_read({ repo: "vercel/next.js", path: "README.md" })` returns file content
  - [x] `repo_read({ repo: "vercel/next.js", path: "src/*.ts" })` returns multiple files
  - [x] Returns error if repo not in manifest: "Repository not found. Run repo_clone first."
  - [x] Updates lastAccessed in manifest after read
  - [x] Truncates large files with note: "[truncated at 500 lines]"

  **Commit**: YES
  - Message: `feat: implement repo_read tool`
  - Files: `index.ts`
  - Pre-commit: `bun test`

---

- [x] 6. Implement scanner module

  **What to do**:
  - Implement local repo scanner using `fd`
  - Find all git repos in configured search paths
  - Extract remote URL to match against repo specs
  - Build local index mapping remote -> local path
  - Handle repos with no remote gracefully

  **Must NOT do**:
  - Don't scan entire filesystem (only configured paths)
  - Don't follow symlinks into loops
  - Don't scan nested git repos (max-depth limit)

  **Parallelizable**: NO (depends on foundation)

  **References**:
  
  **Implementation Pattern**:
  ```typescript
  // Find all .git directories
  const gitDirs = await $`fd -H -t d '^.git$' --max-depth 4 ${searchPath}`.text()
  
  // For each, get remote
  for (const gitDir of gitDirs.split('\n').filter(Boolean)) {
    const repoPath = path.dirname(gitDir)
    const remote = await $`git -C ${repoPath} remote get-url origin`.text().catch(() => null)
    if (remote) {
      // Parse remote to get owner/repo
      // Add to local index
    }
  }
  ```

  **Acceptance Criteria**:
  - [x] `src/scanner.ts` exports: `scanLocalRepos`, `matchRemoteToSpec`
  - [x] `scanLocalRepos(paths)` returns array of `{ path, remote, branch }`
  - [x] Handles repos without remote (skips them)
  - [x] Respects max-depth of 4 to avoid deep nesting
  - [x] `matchRemoteToSpec("git@github.com:vercel/next.js.git")` returns `"vercel/next.js"`
  - [x] Handles both SSH and HTTPS remote formats

  **Commit**: YES
  - Message: `feat: implement local repo scanner`
  - Files: `src/scanner.ts`
  - Pre-commit: `bun test`

---

- [x] 7. Implement repo_scan tool

  **What to do**:
  - Add `repo_scan` tool to plugin
  - Load config for search paths
  - Use scanner module to find repos
  - Update manifest with local entries
  - Report what was found

  **Must NOT do**:
  - Don't delete existing cached entries
  - Don't scan if no search paths configured

  **Parallelizable**: NO (depends on 6)

  **References**:
  
  **Tool Signature**:
  ```typescript
  repo_scan: tool({
    description: "Scan local filesystem for git repositories and register them. Configure search paths in ~/.config/opencode/opencode-repos.json",
    args: {
      paths: tool.schema.array(tool.schema.string()).optional().describe("Override search paths (default: from config)"),
    },
    async execute(args) {
      // 1. Load config for default paths (or use args.paths)
      // 2. Validate paths exist
      // 3. Scan each path
      // 4. Register found repos as 'local' type
      // 5. Return summary
    }
  })
  ```

  **Config File** (`~/.config/opencode/opencode-repos.json`):
  ```json
  {
    "localSearchPaths": [
      "~/projects",
      "~/personal/projects",
      "~/code"
    ]
  }
  ```

  **Acceptance Criteria**:
  - [x] `repo_scan()` uses paths from config file
  - [x] `repo_scan({ paths: ["~/custom"] })` overrides config
  - [x] Found repos added to manifest as `type: "local"`
  - [x] Returns summary: "Found 5 repos in 3 paths. 2 new, 3 already registered."
  - [x] Handles missing config: "No search paths configured. Create ~/.config/opencode/opencode-repos.json"

  **Commit**: YES
  - Message: `feat: implement repo_scan tool`
  - Files: `index.ts`
  - Pre-commit: `bun test`

---

- [x] 8a. Implement repo_update tool

  **What to do**:
  - Add `repo_update` tool to plugin
  - Pull latest changes for cached repos
  - Show status for local repos (don't modify)
  - Update lastUpdated timestamp

  **Must NOT do**:
  - Don't modify local repos (only show status)
  - Don't update if there are local changes

  **Parallelizable**: YES (with 8b)

  **References**:
  
  **Tool Signature**:
  ```typescript
  repo_update: tool({
    description: "Update a cached repository to latest. For local repos, shows git status without modifying.",
    args: {
      repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
    },
    async execute(args) {
      // 1. Look up in manifest
      // 2. If cached: fetch + reset
      // 3. If local: show status only
      // 4. Update lastUpdated
    }
  })
  ```

  **Acceptance Criteria**:
  - [x] `repo_update("vercel/next.js")` fetches and resets cached repo
  - [x] Returns: "Updated vercel/next.js@canary to latest (abc1234)"
  - [x] For local repos: "Local repo - showing status only:\n[git status output]"
  - [x] Updates lastUpdated in manifest

  **Commit**: YES (combined with 8b)
  - Message: `feat: implement repo_update and repo_remove tools`
  - Files: `index.ts`
  - Pre-commit: `bun test`

---

- [x] 8b. Implement repo_remove tool

  **What to do**:
  - Add `repo_remove` tool to plugin
  - For cached: delete directory and manifest entry
  - For local: remove from manifest only (don't delete files)
  - Confirm dangerous operations

  **Must NOT do**:
  - Don't delete local repo files (only unregister)
  - Don't remove without confirmation for cached

  **Parallelizable**: YES (with 8a)

  **References**:
  
  **Tool Signature**:
  ```typescript
  repo_remove: tool({
    description: "Remove a repository. Cached repos are deleted from disk. Local repos are unregistered only.",
    args: {
      repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
      confirm: tool.schema.boolean().optional().default(false).describe("Confirm deletion for cached repos"),
    },
    async execute(args) {
      // 1. Look up in manifest
      // 2. If cached: require confirm, delete dir
      // 3. If local: just remove from manifest
      // 4. Update manifest
    }
  })
  ```

  **Acceptance Criteria**:
  - [x] `repo_remove("vercel/next.js")` without confirm: "This will delete cached repo. Use confirm: true to proceed."
  - [x] `repo_remove("vercel/next.js", { confirm: true })` deletes and removes from manifest
  - [x] `repo_remove("my-local")` unregisters without deleting: "Unregistered my-local (files preserved at /path)"

  **Commit**: YES (combined with 8a)
  - Message: `feat: implement repo_update and repo_remove tools`
  - Files: `index.ts`
  - Pre-commit: `bun test`

---

- [x] 9. Define repo-explorer agent

  **What to do**:
  - Create agent definition in `src/agents/repo-explorer.ts`
  - Define agent config following oh-my-opencode patterns
  - Agent is read-only (no edit, write, task permissions)
  - Agent has access to: read, glob, grep, bash (for git commands)
  - Craft system prompt for codebase exploration

  **Must NOT do**:
  - Don't give agent write/edit permissions
  - Don't allow agent to spawn sub-tasks
  - Don't allow agent to modify the repo

  **Parallelizable**: NO (depends on core tools working)

  **References**:
  
  **Pattern References**:
  - `/tmp/oh-my-opencode/src/agents/explore.ts` - Explorer agent pattern
  - `/tmp/oh-my-opencode/src/agents/oracle.ts` - Read-only agent pattern
  
  **Agent Definition**:
  ```typescript
  import type { AgentConfig } from "@opencode-ai/sdk"
  
  export function createRepoExplorerAgent(): AgentConfig {
    return {
      description: "Specialized agent for exploring external codebases. Use when you need to understand another project's architecture, APIs, patterns, or implementation details.",
      mode: "subagent" as const,
      temperature: 0.1,
      permission: {
        edit: "deny",
        write: "deny",
        task: "deny",
        delegate_task: "deny",
      },
      prompt: `You are a codebase exploration specialist. Your job is to deeply understand external codebases and report your findings clearly.

## Your Capabilities
- Read and analyze source code
- Search for patterns and implementations
- Understand project structure and architecture
- Identify APIs, interfaces, and integration points

## Your Approach
1. Start with high-level structure (README, package.json, main entry points)
2. Identify key directories and their purposes
3. Trace code paths relevant to the question
4. Report findings with specific file references and code examples

## Output Format
- Be specific: cite file paths and line numbers
- Include relevant code snippets
- Explain how components interact
- Note any patterns or conventions used

You are READ-ONLY. You cannot modify files or create new ones.`
    }
  }
  ```

  **Acceptance Criteria**:
  - [x] `src/agents/repo-explorer.ts` exports `createRepoExplorerAgent`
  - [x] Agent has `mode: "subagent"`
  - [x] Agent has `permission: { edit: "deny", write: "deny", task: "deny" }`
  - [x] Agent prompt focuses on codebase exploration

  **Commit**: YES
  - Message: `feat: define repo-explorer agent`
  - Files: `src/agents/repo-explorer.ts`
  - Pre-commit: `bun test`

---

- [x] 10. Implement repo_explore tool and config handler

  **What to do**:
  - Add config handler to register `repo-explorer` agent
  - Implement `repo_explore` tool that:
    1. Ensures repo is cloned/available
    2. Spawns `repo-explorer` agent in that repo's context
    3. Returns the exploration results
  - Use OpenCode SDK client to spawn the agent session

  **Must NOT do**:
  - Don't allow exploration without clone
  - Don't give the spawned agent elevated permissions

  **Parallelizable**: NO (depends on agent definition)

  **References**:
  
  **Pattern References**:
  - `/tmp/oh-my-opencode/src/plugin-handlers/config-handler.ts:280-300` - Config handler pattern for agent registration
  - `/tmp/oh-my-opencode/src/tools/call-omo-agent/tools.ts:186-197` - Agent invocation via client.session.prompt
  
  **Implementation Pattern**:
  ```typescript
  // Config handler to register agent
  config: async (config) => {
    const explorerAgent = createRepoExplorerAgent()
    config.agent = {
      ...config.agent,
      "repo-explorer": explorerAgent,
    }
  },
  
  // Tool to spawn explorer in repo context
  repo_explore: tool({
    description: "Explore a repository to understand its codebase. Spawns a specialized exploration agent that analyzes the repo and answers your question.",
    args: {
      repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
      question: tool.schema.string().describe("What you want to understand about the codebase"),
    },
    async execute(args, ctx) {
      // 1. Ensure repo is available (clone if needed)
      const repoPath = await ensureRepo(args.repo)
      
      // 2. Create exploration prompt with repo context
      const prompt = `Explore the codebase at ${repoPath} and answer: ${args.question}
      
Working directory: ${repoPath}
Available tools: read, glob, grep, bash`
      
      // 3. Spawn repo-explorer agent via SDK
      const result = await ctx.client.session.prompt({
        body: {
          agent: "repo-explorer",
          parts: [{ type: "text", text: prompt }],
        }
      })
      
      return result
    }
  })
  ```

  **Acceptance Criteria**:
  - [x] Config handler registers `repo-explorer` agent
  - [x] `repo_explore({ repo: "vercel/next.js", question: "How does routing work?" })` spawns explorer
  - [x] Explorer runs in context of the specified repo
  - [x] Returns exploration results as markdown
  - [x] Auto-clones repo if not cached

  **Commit**: YES
  - Message: `feat: implement repo_explore tool and config handler`
  - Files: `index.ts`
  - Pre-commit: `bun test`

---

- [x] 11. Documentation and final polish

  **What to do**:
  - Write comprehensive README.md
  - Document all tools with examples
  - Document the `repo-explorer` agent
  - Document config file format
  - Add installation instructions
  - Document limitations (no submodules, no LFS, etc.)
  - Update package.json with keywords, repository, etc.

  **Must NOT do**:
  - Don't over-document obvious things
  - Don't promise features not implemented

  **Parallelizable**: NO (final task)

  **References**:
  
  **Pattern References**:
  - `~/personal/projects/opencode-tmux/README.md` - README structure and format
  
  **README Structure**:
  ```markdown
  # opencode-repos
  
  Repository cache, registry, and cross-codebase intelligence for OpenCode agents.
  
  ## Installation
  ## Configuration
  ## Tools
  ### repo_clone
  ### repo_list
  ### repo_read
  ### repo_scan
  ### repo_update
  ### repo_remove
  ### repo_explore
  ## Custom Agent: repo-explorer
  ## Use Cases
  ### Cross-project integration
  ### Understanding dependencies
  ### Firmware/backend exploration
  ## Limitations
  ## Development
  ```

  **Acceptance Criteria**:
  - [x] README.md exists with installation and usage
  - [x] All 7 tools documented with examples
  - [x] `repo-explorer` agent documented with use cases
  - [x] Config file format documented
  - [x] Limitations section lists: no submodules, no LFS, shallow only
  - [x] `package.json` has keywords: `opencode`, `opencode-plugin`, `repos`, `cache`, `codebase`

  **Commit**: YES
  - Message: `docs: add comprehensive documentation`
  - Files: `README.md`, `package.json`
  - Pre-commit: `bun test`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 0 | `chore: initial project setup` | package.json, tsconfig.json | `bun test` |
| 1 | `feat: implement manifest operations with locking` | src/manifest.ts, tests | `bun test` |
| 2 | `feat: implement git operations module` | src/git.ts, tests | `bun test` |
| 3 | `feat: implement repo_clone tool` | index.ts | `bun test` |
| 4 | `feat: implement repo_list tool` | index.ts | `bun test` |
| 5 | `feat: implement repo_read tool` | index.ts | `bun test` |
| 6 | `feat: implement local repo scanner` | src/scanner.ts | `bun test` |
| 7 | `feat: implement repo_scan tool` | index.ts | `bun test` |
| 8a+8b | `feat: implement repo_update and repo_remove tools` | index.ts | `bun test` |
| 9 | `feat: define repo-explorer agent` | src/agents/repo-explorer.ts | `bun test` |
| 10 | `feat: implement repo_explore tool and config handler` | index.ts | `bun test` |
| 11 | `docs: add comprehensive documentation` | README.md, package.json | `bun test` |

---

## Success Criteria

### Verification Commands
```bash
# All tests pass
bun test

# Plugin loads without error (check in opencode)
# Add to opencode.jsonc: "file:///Users/liamvinberg/personal/projects/opencode-repos/index.ts"

# Functional tests (manual in opencode)
repo_clone("vercel/next.js")           # Should clone and return path
repo_clone("vercel/next.js")           # Should return cached path (no clone)
repo_list()                            # Should show the repo
repo_read("vercel/next.js", "README.md") # Should return content
repo_scan()                            # Should find local repos
repo_update("vercel/next.js")          # Should update
repo_remove("vercel/next.js", true)    # Should delete

# Agent verification
# Check that repo-explorer appears in available agents
# Test cross-codebase exploration:
repo_explore("vercel/next.js", "How does the App Router work?")
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass (`bun test`)
- [x] Plugin loads in OpenCode
- [x] Can clone public and private repos
- [x] Local scan discovers existing repos
- [x] `repo-explorer` agent registered and available
- [x] `repo_explore` tool spawns explorer correctly
- [x] Documentation complete
