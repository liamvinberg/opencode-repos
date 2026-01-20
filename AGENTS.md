# AGENTS.md - opencode-repos

Guidelines for AI agents working in this repository.

## Build & Development Commands

```bash
bun install              # Install dependencies
bunx tsc --noEmit        # Type checking
bun test                 # Run all tests
bun test src/__tests__/git.test.ts           # Run single file
bun test --test-name-pattern "parseRepoSpec" # Run matching tests
bun test --watch         # Watch mode
```

## Project Structure

```
opencode-repos/
├── index.ts                  # Main plugin - tool definitions
├── src/
│   ├── manifest.ts           # Manifest CRUD + file locking
│   ├── git.ts                # Git operations (clone, update, parse)
│   ├── scanner.ts            # Local filesystem repo scanner
│   ├── agents/repo-explorer.ts
│   └── __tests__/            # Test files (*.test.ts)
├── package.json
└── tsconfig.json
```

## Code Style

### Runtime: Bun (NOT Node.js)

This project uses Bun exclusively. Do not use Node.js, npm, pnpm, or yarn.

```typescript
import { $ } from "bun"
await $`git clone ${url} ${dest}`.quiet()  // Shell commands

const file = Bun.file(path)                // File operations
await Bun.write(path, content)
await Bun.sleep(100)                       // Sleep
```

### Imports

Order: types → external → internal → relative. Use `node:` prefix for built-ins.

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import { homedir } from "node:os"
import { parseRepoSpec } from "./src/git"
```

### TypeScript

- Strict mode enabled
- Never use `any`, `@ts-ignore`, or `@ts-expect-error`
- Export interfaces for public types
- Use type guards: `(r): r is LocalRepoInfo => r !== null`

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Functions/Variables | camelCase | `parseRepoSpec`, `repoPath` |
| Constants | SCREAMING_SNAKE | `CACHE_DIR`, `LOCK_STALE_MS` |
| Interfaces/Types | PascalCase | `RepoEntry`, `CloneOptions` |
| Files | kebab-case | `repo-explorer.ts` |

### Error Handling

```typescript
// Type-narrow errors
try {
  await cloneRepo(url, destPath, { branch })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  throw new Error(`Failed to clone ${repoKey}: ${message}`)
}

// Cleanup on failure
try {
  await $`git clone ...`.quiet()
} catch (error) {
  try { await rm(destPath, { recursive: true, force: true }) } catch {}
  throw error
}

// Silent catch for optional cleanup
await unlink(LOCK_PATH).catch(() => {})
```

### Async Patterns

- Use Promise.all for parallel operations
- Use `.quiet()` on shell commands

```typescript
const [remote, branch] = await Promise.all([
  $`git -C ${path} remote get-url origin`.text(),
  $`git -C ${path} branch --show-current`.text(),
])
```

### Testing

```typescript
import { test, expect, describe } from "bun:test"

describe("parseRepoSpec", () => {
  test("parses owner/repo without branch", () => {
    expect(parseRepoSpec("vercel/next.js")).toEqual({
      owner: "vercel", repo: "next.js", branch: null
    })
  })

  test("throws on invalid input", () => {
    expect(() => parseRepoSpec("invalid")).toThrow("Invalid repo spec")
  })
})
```

### Tool Definitions

```typescript
repo_clone: tool({
  description: "Brief description with example usage",
  args: {
    repo: tool.schema.string().describe("Format: 'owner/repo@branch'"),
    force: tool.schema.boolean().optional().default(false).describe("..."),
  },
  async execute(args) {
    return `## Markdown formatted response`
  },
})
```

### Formatting

- Only add comments for complex logic
- No emojis in logs or comments
- Use ISO 8601: `new Date().toISOString()`

### File Locking

Use `withManifestLock` for any manifest mutations:

```typescript
await withManifestLock(async () => {
  const manifest = await loadManifest()
  manifest.repos[key] = entry
  await saveManifest(manifest)
})
```

## Key Patterns

### Repo Spec Parsing

Format: `owner/repo` or `owner/repo@branch`

```typescript
const spec = parseRepoSpec("vercel/next.js@canary")
// { owner: "vercel", repo: "next.js", branch: "canary" }
```

### Tool Return Format

Tools return markdown-formatted strings:

```typescript
return `## Repository Cloned

**Repository**: ${args.repo}
**Path**: ${result.path}`
```
