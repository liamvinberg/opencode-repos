# Learnings - opencode-repos

## Task 0: Project Setup

### Plugin Version Discovery
- @opencode-ai/plugin does not have version 0.0.1
- Earliest version is 1.1.x series
- tmux plugin pattern: peerDependencies uses `*`, devDependencies uses `^1.1.25`

### Bun Test Behavior
- `bun test` exits with code 1 when no test files found
- Need at least one placeholder test for clean CI/verification
- Test file pattern: `**{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx}`

### tsconfig.json
- Bun init creates tsconfig with comments (invalid JSON for some tools)
- Replaced with clean JSON matching tmux plugin pattern
- Key settings: ES2022 target, ESNext module, bundler moduleResolution

## Task 1: Manifest Types and Operations

### Atomic File Writes
- Pattern: write to .tmp file, then rename (atomic at OS level)
- `fs.rename()` is atomic on POSIX systems
- Prevents partial writes from corrupting manifest

### File Locking Pattern
- Manual lock file approach works well with Bun
- Check lock existence, check staleness (>5 min), create lock, execute, release
- Use `stat().mtimeMs` to check lock age
- Stale lock detection prevents deadlocks from crashed processes

### Bun File APIs
- `Bun.file(path).exists()` for existence check
- `Bun.file(path).text()` for reading
- `Bun.write(path, content)` for writing
- `Bun.sleep(ms)` for delays in lock retry loop

### Test Isolation
- Tests modify real cache dir (~/.cache/opencode-repos)
- Use beforeEach/afterEach to clean up
- `rm(path, { recursive: true, force: true })` for cleanup

### Graceful Error Handling
- Missing manifest: return empty, don't throw
- Corrupted JSON: log warning, return empty
- Lock acquisition failure: throw after max attempts

## Task 2: Git Operations Module

### Bun Shell Execution
- Import `$` from "bun" for shell commands
- Use `.quiet()` to suppress stdout/stderr output
- Use `.text()` to get string output from commands
- Pattern: `await $\`git command\`.quiet()` for silent execution

### Git Clone Flags
- `--depth=1`: Shallow clone (single commit)
- `--single-branch`: Only fetch specified branch
- `--branch ${branch}`: Specify branch to clone
- `--config core.hooksPath=/dev/null`: Disable git hooks

### Git Directory Operations
- Use `-C ${path}` to run git commands in a specific directory
- Avoids need to change working directory

### Cleanup on Failure
- Wrap clone in try/catch
- On failure, remove destination directory with `rm(destPath, { recursive: true, force: true })`
- Nested try/catch for cleanup to ignore cleanup errors

### Repo Spec Parsing
- Format: "owner/repo" or "owner/repo@branch"
- Split on "@" first for branch extraction
- Split on "/" for owner/repo
- Branch can contain "/" (e.g., "feature/my-branch")
- Validate: owner and repo must not be empty

### Integration Testing
- Use `tmpdir()` for test directories
- Use `beforeAll`/`afterAll` for setup/teardown
- GitHub's octocat/Hello-World is a good public test repo
- Commit hashes match pattern `/^[a-f0-9]{40}$/`

## Task 3: Plugin Export and repo_clone Tool

### Plugin Export Pattern
- Import `Plugin` type and `tool` from "@opencode-ai/plugin"
- Plugin is an async function returning object with `tool` property
- Tools are defined using `tool({ description, args, execute })`
- Export both named (`OpencodeRepos`) and default export

### Tool Schema Pattern
- Use `tool.schema.string()`, `tool.schema.boolean()` for arg types
- Chain `.optional()`, `.default(value)`, `.describe()` for metadata
- Args are automatically validated before execute() is called

### Smart Clone Flow
- Check manifest first (within lock) for existing entry
- If cached and not force: update lastAccessed, return path
- If force: delete existing directory before clone
- Clone to `~/.cache/opencode-repos/{owner}/{repo}@{branch}/`
- Update manifest with new entry after successful clone

### Error Handling in Tools
- Wrap error messages: `error instanceof Error ? error.message : String(error)`
- Throw descriptive errors with repo context
- Return markdown-formatted success messages

### Manifest Locking
- All manifest read/write operations wrapped in `withManifestLock()`
- Ensures concurrent clone operations don't corrupt manifest
- Lock is released even if operation throws

## Task 4: repo_list Tool

### List Tool Pattern
- Reference: opencode-tmux tmux_list tool (lines 414-471)
- Use enum schema for filtering: `tool.schema.enum(["all", "cached", "local"])`
- Return markdown-formatted output with tables

### Markdown Table Output
- Header row with column names
- Separator row with dashes
- Data rows with pipe-separated values
- Summary line at end with counts

### Repo Key Parsing
- Keys stored as "owner/repo@branch"
- Extract repo name: `repoKey.substring(0, repoKey.lastIndexOf("@"))`
- Branch available from entry.defaultBranch

### Size Formatting
- sizeBytes may not exist (local repos don't track size yet)
- Format as MB: `Math.round(entry.sizeBytes / 1024 / 1024)`
- Show "-" if sizeBytes undefined

### Filtering Logic
- Object.entries() to iterate manifest.repos
- Filter by entry.type matching args.type
- "all" type returns everything

## Task 5: repo_read Tool

### Glob Pattern Support
- Use `glob` npm package (v10.x) for file pattern matching
- Check for `*` or `?` in path to determine if glob needed
- `glob(pattern, { nodir: true })` returns only files, not directories
- Single file paths work without glob

### File Reading Pattern
- Use `readFile(path, "utf-8")` from node:fs/promises
- Split content by newlines for line counting
- Truncate at maxLines with `[truncated at N lines, M total]` message
- Handle errors per-file to continue reading other files

### Relative Path Display
- Store repoPath from manifest entry
- Calculate relative: `filePath.replace(repoPath + "/", "")`
- Display relative paths in output for readability

### Manifest Update After Read
- Update lastAccessed timestamp after successful read
- Use withManifestLock for atomic update
- Re-load manifest inside lock to avoid stale data

### Error Handling
- Repo not found: Return helpful message with repo_clone suggestion
- No files found: Return message with the pattern that failed
- File read error: Include in output but continue with other files

## Task 6: Scanner Module

### fd Command for Git Discovery
- `fd -H -t d '^.git$' --max-depth 4 ${searchPath}` finds all .git directories
- `-H`: Include hidden files/dirs (required since .git is hidden)
- `-t d`: Type directory only
- `'^.git$'`: Regex for exact match ".git"
- `--max-depth 4`: Limit depth to avoid deep nested structures

### Remote URL Parsing
- SSH format: `git@github.com:owner/repo.git` -> extract with regex `/git@github\.com:(.+)/`
- HTTPS format: `https://github.com/owner/repo.git` -> extract with regex `/https:\/\/github\.com\/(.+)/`
- Remove `.git` suffix first with `.replace(/\.git$/, "")`
- Return null for unsupported formats (GitLab, Bitbucket, etc.)

### Graceful Error Handling
- Invalid search path: catch and continue to next path
- Repo without remote: catch git error and continue
- Repo with git errors: catch and continue
- No repos found: return empty array (not an error)

### Git Commands for Repo Info
- `git -C ${repoPath} remote get-url origin`: Get remote URL
- `git -C ${repoPath} branch --show-current`: Get current branch
- Default to "main" if branch is empty (detached HEAD state)

## Task 7: repo_scan Tool

### Config Loading Pattern
- Config file location: `~/.config/opencode/opencode-repos.json`
- Use `existsSync()` to check file existence before reading
- Parse JSON with try/catch, return null on failure
- Config interface: `{ localSearchPaths: string[] }`

### Tool Args Override Pattern
- Accept optional `paths` array argument
- If provided, use args.paths directly
- If not provided, fall back to config file
- If neither available, return helpful error with config file example

### Manifest Update for Local Repos
- Local repos use `type: "local"` (vs `type: "cached"` for cloned)
- Local repos have `shallow: false` (they're full clones)
- Add to both `manifest.repos` and `manifest.localIndex`
- `localIndex` maps remote URL to local path for quick lookups

### Repo Key Construction
- Use `matchRemoteToSpec()` to convert remote URL to "owner/repo" format
- Skip non-GitHub remotes (matchRemoteToSpec returns null)
- Construct key as `${spec}@${branch}` to match cached repo format
- Check for existing entry before adding to avoid duplicates

### Summary Output Format
- Report total found, new registered, and already existing
- Include helpful message about repo_list when new repos added
- Handle zero repos found case with list of searched paths

## Task 8a: repo_update Tool

### Update vs Status Pattern
- Cached repos: fetch + reset to update to latest
- Local repos: show status only, never modify
- Differentiate by `entry.type === "local"` check

### Git Update Commands
- `updateRepo(path, branch)` from git module handles fetch + reset
- `getRepoInfo(path)` returns commit hash for confirmation message
- Commit hash truncated to 7 chars for display: `info.commit.substring(0, 7)`

### Git Status for Local Repos
- Use `git -C ${path} status --short` for compact status
- Empty output means working tree is clean
- Display "Working tree clean" when status is empty

### Manifest Timestamp Updates
- Update both `lastUpdated` and `lastAccessed` on successful update
- Use `withManifestLock` for atomic manifest updates
- Re-load manifest inside lock to avoid stale data

### Error Recovery Suggestions
- Repo not found: suggest `repo_clone`
- Update failed: suggest `repo_clone({ force: true })` to re-clone
- Corrupted repos can be fixed by force re-clone

## Task 8b: repo_remove Tool

### Removal Behavior by Type
- Cached repos: require confirmation, delete directory + unregister from manifest
- Local repos: unregister only, preserve files on disk
- Distinction prevents accidental deletion of user-managed repos

### Confirmation Pattern
- Use `confirm: boolean` arg with default false
- Without confirm: return message explaining what will happen
- With confirm: proceed with deletion
- Local repos don't need confirmation since files aren't deleted

### Manifest Cleanup for Local Repos
- Delete from `manifest.repos[repoKey]`
- Also delete from `manifest.localIndex` by finding matching path
- Iterate localIndex entries to find remote URL that maps to entry.path

### Error Recovery on Delete Failure
- If `rm()` fails, still try to unregister from manifest
- Wrap manifest cleanup in nested try/catch to ignore cleanup errors
- Return message noting manual cleanup may be needed
- User can manually delete directory at the path shown

### rm() Options
- `{ recursive: true, force: true }` for directory deletion
- `force: true` prevents errors if directory doesn't exist
- `recursive: true` required for non-empty directories

## Task 9: Define repo-explorer Agent

### AgentConfig Type Location
- Import from `@opencode-ai/sdk` not `@opencode-ai/plugin`
- Type defined in `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
- v2 types have more permissions than v1 types

### AgentConfig Properties
- `description`: When to use this agent (shown in agent selection)
- `mode`: "subagent" | "primary" | "all" - subagent for spawned agents
- `temperature`: 0.1 for focused, deterministic exploration
- `permission`: Object with permission rules per tool category
- `prompt`: System prompt defining agent behavior

### Permission Structure (v1 SDK)
- Available permissions: `edit`, `bash`, `webfetch`, `doom_loop`, `external_directory`
- Values: "ask" | "allow" | "deny"
- `task` and `delegate_task` permissions NOT available in v1 SDK types
- For read-only agent: `edit: "deny"` is sufficient

### System Prompt Best Practices
- Clearly state agent capabilities
- Define exploration approach (high-level to detailed)
- Specify output format (file paths, code snippets, explanations)
- State constraints explicitly (read-only, no modifications)
- Include example questions the agent can answer

### Agent File Location
- Created in `src/agents/` directory
- Export function pattern: `createRepoExplorerAgent(): AgentConfig`
- Function returns config object, not the agent itself

## Task 10: repo_explore Tool and Config Handler

### Plugin Config Handler Pattern
- Plugin can return `config` function alongside `tool` object
- Config handler receives OpenCode config object
- Register agents by merging into `config.agent`: `config.agent = { ...config.agent, "name": agentConfig }`
- Config handler runs before tools are available

### Agent Spawning via ctx.client
- Tool execute function receives `ctx` as second parameter
- `ctx.client.session.prompt()` spawns agent sessions
- Body format: `{ agent: "agent-name", parts: [{ type: "text", text: prompt }] }`
- Agent name must match what was registered in config handler

### Auto-Clone Pattern for repo_explore
- Check manifest for existing repo entry
- If not found, clone it first (reuse repo_clone logic inline)
- Use same CACHE_DIR and manifest update pattern
- Return helpful error if clone fails

### Exploration Prompt Structure
- Include working directory path for agent context
- State the question clearly
- List available tools (read, glob, grep, bash)
- Provide guidance on exploration approach
- Agent's system prompt handles the rest

### Manifest Access Tracking
- Update `lastAccessed` after successful exploration
- Use `withManifestLock` for atomic update
- Re-load manifest inside lock to avoid stale data

## Task 11: Documentation and Final Polish

### README Structure
- Follow opencode-tmux README pattern for consistency
- Include: Features, Installation, Quick Start, Configuration, Tools, Agent, Use Cases, Limitations, Development
- Each tool section: description, arguments, examples, returns
- Use TypeScript code blocks for examples

### package.json Keywords
- Required keywords: opencode, opencode-plugin, repos, repository, cache, codebase
- Keywords help with npm discoverability
- Keep description concise but comprehensive

### Plugin API Learnings
- `PluginInput` has `client` property for SDK access
- `ToolContext` has `sessionID` for current session
- `client.session.prompt()` requires `path.id` with session ID
- Response handling: check `response.error`, extract text from `response.data.parts`

### Type Safety with SDK Response
- Parts array contains various types (text, tool, file, etc.)
- Filter by `p.type === "text"` to get text parts
- Use `"text" in p` guard for safe property access
- TypeScript type predicates need to match full Part type

### LSP vs tsc Discrepancies
- LSP may show stale errors after file changes
- Always verify with `bunx tsc --noEmit` as source of truth
- tsc clean = code is correct, ignore stale LSP errors

### Project Completion Summary
- 7 tools implemented: repo_clone, repo_list, repo_read, repo_scan, repo_update, repo_remove, repo_explore
- 1 custom agent: repo-explorer (read-only codebase exploration)
- 27 tests passing across 3 test files
- Config file support for local search paths
- Comprehensive README with examples for all tools
