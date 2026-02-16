# opencode-repos

Minimal repository cache and registry plugin for OpenCode.

This rewrite focuses on stability and predictable behavior instead of advanced orchestration.

## What It Does

- Clones GitHub repositories into a local cache
- Reuses or repairs existing cache directories when possible
- Falls back across SSH/HTTPS clone URLs to reduce `git clone` exit code 128 failures
- Handles branch fallback more safely when default branch is not `main`
- Registers local repositories from configured search paths
- Lists and reads remote GitHub files without cloning
- Reads files from registered repositories with optional glob support
- Registers a dedicated `repo-explorer` subagent for external codebase analysis

## Install

```bash
bun install
```

Then add the plugin path to OpenCode config:

```json
{
  "plugins": [
    "file:///absolute/path/to/opencode-repos/index.ts"
  ]
}
```

## Configuration

Optional file: `~/.config/opencode/opencode-repos.json`

```json
{
  "cacheDir": "~/.cache/opencode-repos",
  "localSearchPaths": ["~/projects"],
  "defaultBranch": "main",
  "useHttps": true,
  "includeProjectParent": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `cacheDir` | `~/.cache/opencode-repos` | Where cached clones are stored |
| `localSearchPaths` | `[]` | Paths scanned by `repo_scan` and `repo_find` |
| `defaultBranch` | `main` | Branch used when repo spec has no branch |
| `useHttps` | `true` | Preferred clone protocol; plugin auto-falls back to the other protocol |
| `includeProjectParent` | `true` | Adds current project parent folder to search paths |

## Tools

### `repo_clone`

Clone or reuse a cached repository.

```ts
repo_clone({ repo: "vercel/next.js" })
repo_clone({ repo: "vercel/next.js@canary" })
repo_clone({ repo: "vercel/next.js", force: true })
```

### `repo_list`

List registered repositories.

```ts
repo_list()
repo_list({ type: "cached" })
repo_list({ type: "local" })
```

### `repo_tree`

List remote repository files directly from GitHub API (no clone).

```ts
repo_tree({ repo: "vercel/next.js" })
repo_tree({ repo: "vercel/next.js@canary", path: "packages/next/src", limit: 300 })
```

### `repo_read_remote`

Read one remote file directly from GitHub API (no clone).

```ts
repo_read_remote({ repo: "vercel/next.js", path: "README.md" })
repo_read_remote({ repo: "vercel/next.js@canary", path: "packages/next/src/server/next.ts", maxLines: 200 })
```

### `repo_read`

Read files from a registered repository.

```ts
repo_read({ repo: "vercel/next.js", path: "README.md" })
repo_read({ repo: "vercel/next.js", path: "packages/**/*.ts", maxLines: 300 })
```

### `repo_update`

Update a cached repository (or show status for local repositories).

```ts
repo_update({ repo: "vercel/next.js" })
repo_update({ repo: "vercel/next.js@canary" })
```

### `repo_remove`

Unregister a local repo or delete a cached repo.

```ts
repo_remove({ repo: "vercel/next.js" })
repo_remove({ repo: "vercel/next.js", confirm: true })
```

### `repo_scan`

Scan local filesystem paths and register discovered local repos.

```ts
repo_scan()
repo_scan({ paths: ["~/projects", "~/work"] })
```

### `repo_find`

Search registered repos, local repos, and GitHub (if `gh` is installed and authenticated).

```ts
repo_find({ query: "next.js" })
repo_find({ query: "vercel/next.js" })
```

## Repo Explorer Agent

The plugin registers a `repo-explorer` subagent automatically.

- Use this when users explicitly ask for "repo explorer agent" behavior
- For quick file discovery, prefer `repo_tree` and `repo_read_remote` first
- Use `repo_clone` + `repo_read` when local checkout is actually required

## Development

```bash
bun test
bunx tsc --noEmit
```

## License

MIT
