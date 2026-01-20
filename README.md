# opencode-repos

Repository cache, registry, and cross-codebase intelligence for OpenCode agents.

## Features

- **Clone and cache** - Clone repositories to local cache for fast repeated access
- **Local repo scanning** - Discover and register existing local repositories
- **Cross-repo exploration** - Use AI agents to understand external codebases
- **Unified registry** - Single manifest tracks both cached and local repos
- **Glob pattern support** - Read multiple files with glob patterns

## Installation

### From npm (when published)

```bash
npm install opencode-repos
```

### Local development

```bash
git clone https://github.com/liamjv1/opencode-repos
cd opencode-repos
bun install
```

### Configuration

Add to your OpenCode config (`~/.config/opencode/opencode.jsonc` or `.opencode/config.jsonc`):

```json
{
  "plugins": [
    "file:///absolute/path/to/opencode-repos/index.ts"
  ]
}
```

## Quick Start

```typescript
// Clone a repository
repo_clone({ repo: "vercel/next.js" })

// List all registered repositories
repo_list()

// Read files from a repository
repo_read({ repo: "vercel/next.js", path: "README.md" })

// Explore a repository to understand it
repo_explore({ 
  repo: "vercel/next.js", 
  question: "How does the App Router work?" 
})
```

## Configuration

Create `~/.config/opencode/opencode-repos.json` to configure local repository scanning:

```json
{
  "localSearchPaths": [
    "~/projects",
    "~/personal/projects",
    "~/code"
  ]
}
```

## Tools

### repo_find

Search for a repository locally and on GitHub. Use this before cloning to check if a repo already exists locally or to find the correct GitHub repo.

**Arguments:**
- `query` (string, required): Repository name or owner/repo format. Examples: `"next.js"`, `"vercel/next.js"`, `"react"`

**Examples:**
```typescript
// Search by name (fuzzy)
repo_find({ query: "next.js" })

// Search by exact owner/repo
repo_find({ query: "vercel/next.js" })

// Find a library
repo_find({ query: "react" })
```

**Returns:** Results grouped by location:
- **Already Registered** - Repos in manifest (cached or local)
- **Found Locally** - Repos on filesystem not yet registered
- **Found on GitHub** - Repos available to clone

**Note:** Requires `gh` CLI for GitHub search. Configure `localSearchPaths` in config for local filesystem search.

---

### repo_clone

Clone a repository to local cache or return path if already cached.

**Arguments:**
- `repo` (string, required): Repository in format `owner/repo` or `owner/repo@branch`
- `force` (boolean, optional): Force re-clone even if cached. Default: `false`

**Examples:**
```typescript
// Clone a repository (default branch)
repo_clone({ repo: "vercel/next.js" })

// Clone a specific branch
repo_clone({ repo: "vercel/next.js@canary" })

// Force re-clone
repo_clone({ repo: "vercel/next.js", force: true })
```

**Returns:** Path to the cached repository

---

### repo_list

List all registered repositories (cached and local).

**Arguments:**
- `type` (enum, optional): Filter by repository type. Options: `"all"`, `"cached"`, `"local"`. Default: `"all"`

**Examples:**
```typescript
// List all repositories
repo_list()

// List only cached repositories
repo_list({ type: "cached" })

// List only local repositories
repo_list({ type: "local" })
```

**Returns:** Markdown table with repository metadata (type, branch, last accessed, size)

---

### repo_read

Read files from a registered repository.

**Arguments:**
- `repo` (string, required): Repository in format `owner/repo` or `owner/repo@branch`
- `path` (string, required): File path within repo, supports glob patterns
- `maxLines` (number, optional): Max lines per file to return. Default: `500`

**Examples:**
```typescript
// Read a single file
repo_read({ repo: "vercel/next.js", path: "README.md" })

// Read multiple files with glob
repo_read({ repo: "vercel/next.js", path: "src/*.ts" })

// Custom line limit
repo_read({ repo: "vercel/next.js", path: "package.json", maxLines: 100 })
```

**Returns:** File contents as markdown code blocks

---

### repo_scan

Scan local filesystem for git repositories and register them.

**Arguments:**
- `paths` (string[], optional): Override search paths. Default: from config file

**Examples:**
```typescript
// Scan configured paths
repo_scan()

// Scan custom paths
repo_scan({ paths: ["~/work", "~/projects"] })
```

**Returns:** Summary of found repositories (new vs existing)

---

### repo_update

Update a cached repository to latest commit.

**Arguments:**
- `repo` (string, required): Repository in format `owner/repo` or `owner/repo@branch`

**Examples:**
```typescript
// Update a cached repository
repo_update({ repo: "vercel/next.js@canary" })
```

**Returns:** Update status with latest commit hash

**Note:** Local repositories show git status only (files are never modified by the plugin).

---

### repo_remove

Remove a repository (delete cached, unregister local).

**Arguments:**
- `repo` (string, required): Repository in format `owner/repo` or `owner/repo@branch`
- `confirm` (boolean, optional): Confirm deletion for cached repos. Default: `false`

**Examples:**
```typescript
// Unregister a local repository (files preserved)
repo_remove({ repo: "my-org/my-project" })

// Delete a cached repository (requires confirmation)
repo_remove({ repo: "vercel/next.js", confirm: true })
```

**Returns:** Removal status

---

### repo_explore

Explore a repository to understand its codebase using AI agent.

**Arguments:**
- `repo` (string, required): Repository in format `owner/repo` or `owner/repo@branch`
- `question` (string, required): What you want to understand about the codebase

**Examples:**
```typescript
// Understand architecture
repo_explore({ 
  repo: "vercel/next.js", 
  question: "How does the App Router work?" 
})

// Find API usage
repo_explore({ 
  repo: "facebook/react", 
  question: "How do I use useEffect with cleanup?" 
})

// Understand patterns
repo_explore({ 
  repo: "acme/firmware", 
  question: "What patterns does this use for error handling?" 
})
```

**Returns:** Detailed analysis with file paths and code examples

---

## Custom Agent: repo-explorer

The plugin registers a specialized `repo-explorer` agent for deep codebase analysis.

**Capabilities:**
- Read and analyze source code across any programming language
- Search for patterns and implementations using grep, glob, and AST tools
- Understand project structure and architecture
- Identify APIs, interfaces, and integration points
- Trace code paths and data flows
- Explain complex implementations in simple terms

**Permissions:** Read-only (cannot modify, create, or delete files)

**Use Cases:**
- Understanding how to integrate with another project
- Learning from open-source implementations
- Debugging cross-project issues
- API discovery and documentation
- Understanding unfamiliar codebases before contributing

---

## Use Cases

### Cross-project integration

Working on Project A (backend) and need to integrate with Project B (firmware):

```typescript
repo_explore({ 
  repo: "acme/firmware@main", 
  question: "How does the sensor calibration API work?" 
})
```

The explorer agent analyzes the firmware codebase and explains the API with file references and examples.

### Understanding dependencies

Learn how a library works internally:

```typescript
repo_explore({ 
  repo: "facebook/react", 
  question: "How does React's reconciliation algorithm work?" 
})
```

### Firmware/backend exploration

Frontend developer needs to understand backend API:

```typescript
repo_explore({ 
  repo: "company/backend@develop", 
  question: "What's the API for user authentication?" 
})
```

### Multi-repo development

Register all your local projects for quick access:

```typescript
// Configure search paths once
// ~/.config/opencode/opencode-repos.json
{
  "localSearchPaths": ["~/work", "~/personal"]
}

// Scan and register
repo_scan()

// Now access any local repo
repo_read({ repo: "my-org/api-service", path: "src/routes/*.ts" })
```

---

## Limitations

- **No submodules**: Git submodules are not cloned or supported
- **No LFS**: Git Large File Storage is not supported
- **Shallow clones only**: All cached repos use `--depth=1` for fast cloning
- **GitHub only**: Remote URL parsing only supports GitHub (SSH and HTTPS formats)
- **Read-only for local repos**: The plugin never modifies local repositories (type: "local")
- **No diff/blame**: Use git directly for advanced git operations

---

## Development

### Running tests

```bash
bun test
```

### Type checking

```bash
bunx tsc --noEmit
```

### Project structure

```
opencode-repos/
├── index.ts                  # Main plugin file with all tools
├── src/
│   ├── manifest.ts           # Manifest operations (load, save, lock)
│   ├── git.ts                # Git operations (clone, update, parse)
│   ├── scanner.ts            # Local repo scanner
│   └── agents/
│       └── repo-explorer.ts  # Explorer agent definition
├── src/__tests__/            # Test files
├── package.json
├── tsconfig.json
└── README.md
```

---

## License

MIT
