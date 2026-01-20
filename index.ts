import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import { parseRepoSpec, buildGitUrl, cloneRepo, updateRepo, getRepoInfo } from "./src/git"
import { createRepoExplorerAgent } from "./src/agents/repo-explorer"
import {
  loadManifest,
  saveManifest,
  withManifestLock,
  type RepoEntry,
} from "./src/manifest"
import { scanLocalRepos, matchRemoteToSpec } from "./src/scanner"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { rm, readFile } from "node:fs/promises"
import { glob } from "glob"

interface Config {
  localSearchPaths: string[]
}

async function loadConfig(): Promise<Config | null> {
  const configPath = join(homedir(), ".config", "opencode", "opencode-repos.json")

  if (!existsSync(configPath)) {
    return null
  }

  try {
    const content = await readFile(configPath, "utf-8")
    return JSON.parse(content)
  } catch {
    return null
  }
}

const CACHE_DIR = join(homedir(), ".cache", "opencode-repos")

export const OpencodeRepos: Plugin = async ({ client }) => {
  return {
    config: async (config) => {
      const explorerAgent = createRepoExplorerAgent()
      config.agent = {
        ...config.agent,
        "repo-explorer": explorerAgent,
      }
    },
    tool: {
      repo_clone: tool({
        description:
          "Clone a repository to local cache or return path if already cached. Supports public and private (SSH) repos. Example: repo_clone({ repo: 'vercel/next.js' }) or repo_clone({ repo: 'vercel/next.js@canary', force: true })",
        args: {
          repo: tool.schema
            .string()
            .describe(
              "Repository in format 'owner/repo' or 'owner/repo@branch'"
            ),
          force: tool.schema
            .boolean()
            .optional()
            .default(false)
            .describe("Force re-clone even if cached"),
        },
        async execute(args) {
          const spec = parseRepoSpec(args.repo)
          const branch = spec.branch || "main"
          const repoKey = `${spec.owner}/${spec.repo}@${branch}`

          const result = await withManifestLock(async () => {
            const manifest = await loadManifest()

            const existingEntry = manifest.repos[repoKey]
            if (existingEntry && !args.force) {
              existingEntry.lastAccessed = new Date().toISOString()
              await saveManifest(manifest)

              return {
                path: existingEntry.path,
                status: "cached" as const,
                alreadyExists: true,
              }
            }

            const destPath = join(
              CACHE_DIR,
              spec.owner,
              `${spec.repo}@${branch}`
            )
            const url = buildGitUrl(spec.owner, spec.repo)

            if (args.force && existingEntry) {
              try {
                await rm(destPath, { recursive: true, force: true })
              } catch {}
            }

            try {
              await cloneRepo(url, destPath, { branch })
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              throw new Error(`Failed to clone ${repoKey}: ${message}`)
            }

            const now = new Date().toISOString()
            const entry: RepoEntry = {
              type: "cached",
              path: destPath,
              clonedAt: now,
              lastAccessed: now,
              lastUpdated: now,
              defaultBranch: branch,
              shallow: true,
            }
            manifest.repos[repoKey] = entry

            await saveManifest(manifest)

            return {
              path: destPath,
              status: "cloned" as const,
              alreadyExists: false,
            }
          })

          const statusText = result.alreadyExists
            ? "Repository already cached"
            : "Successfully cloned repository"

          return `## ${statusText}

**Repository**: ${args.repo}
**Path**: ${result.path}
**Status**: ${result.status}

You can now use \`repo_read\` to access files from this repository.`
        },
      }),

      repo_read: tool({
        description:
          "Read files from a registered repository. Repo must be cloned first via repo_clone. Supports glob patterns for multiple files.",
        args: {
          repo: tool.schema
            .string()
            .describe(
              "Repository in format 'owner/repo' or 'owner/repo@branch'"
            ),
          path: tool.schema
            .string()
            .describe("File path within repo, supports glob patterns"),
          maxLines: tool.schema
            .number()
            .optional()
            .default(500)
            .describe("Max lines per file to return"),
        },
        async execute(args) {
          const spec = parseRepoSpec(args.repo)
          const branch = spec.branch || "main"
          const repoKey = `${spec.owner}/${spec.repo}@${branch}`

          const manifest = await loadManifest()
          const entry = manifest.repos[repoKey]

          if (!entry) {
            return `## Repository not found

Repository \`${args.repo}\` is not registered.

Use \`repo_clone({ repo: "${args.repo}" })\` to clone it first.`
          }

          const repoPath = entry.path
          const fullPath = join(repoPath, args.path)

          let filePaths: string[] = []

          if (args.path.includes("*") || args.path.includes("?")) {
            filePaths = await glob(fullPath, { nodir: true })
          } else {
            filePaths = [fullPath]
          }

          if (filePaths.length === 0) {
            return `No files found matching path: ${args.path}`
          }

          let output = `## Files from ${args.repo}\n\n`
          const maxLines = args.maxLines ?? 500

          for (const filePath of filePaths) {
            const relativePath = filePath.replace(repoPath + "/", "")
            try {
              const content = await readFile(filePath, "utf-8")
              const lines = content.split("\n")
              const truncated = lines.length > maxLines
              const displayLines = truncated
                ? lines.slice(0, maxLines)
                : lines

              output += `### ${relativePath}\n\n`
              output += "```\n"
              output += displayLines.join("\n")
              if (truncated) {
                output += `\n[truncated at ${maxLines} lines, ${lines.length} total]\n`
              }
              output += "\n```\n\n"
            } catch (error) {
              output += `### ${relativePath}\n\n`
              output += `Error reading file: ${error instanceof Error ? error.message : String(error)}\n\n`
            }
          }

          await withManifestLock(async () => {
            const updatedManifest = await loadManifest()
            if (updatedManifest.repos[repoKey]) {
              updatedManifest.repos[repoKey].lastAccessed =
                new Date().toISOString()
              await saveManifest(updatedManifest)
            }
          })

          return output
        },
      }),

      repo_list: tool({
        description:
          "List all registered repositories (cached and local). Shows metadata like type, branch, last accessed, and size.",
        args: {
          type: tool.schema
            .enum(["all", "cached", "local"])
            .optional()
            .default("all")
            .describe("Filter by repository type"),
        },
        async execute(args) {
          const manifest = await loadManifest()

          const allRepos = Object.entries(manifest.repos)
          const filteredRepos = allRepos.filter(([_, entry]) => {
            if (args.type === "all") return true
            return entry.type === args.type
          })

          if (filteredRepos.length === 0) {
            return "No repositories registered."
          }

          let output = "## Registered Repositories\n\n"
          output += "| Repo | Type | Branch | Last Accessed | Size |\n"
          output += "|------|------|--------|---------------|------|\n"

          for (const [repoKey, entry] of filteredRepos) {
            const repoName = repoKey.substring(0, repoKey.lastIndexOf("@"))
            const lastAccessed = new Date(entry.lastAccessed).toLocaleDateString()
            const size = entry.sizeBytes
              ? `${Math.round(entry.sizeBytes / 1024 / 1024)}MB`
              : "-"

            output += `| ${repoName} | ${entry.type} | ${entry.defaultBranch} | ${lastAccessed} | ${size} |\n`
          }

          const cachedCount = filteredRepos.filter(
            ([_, e]) => e.type === "cached"
          ).length
          const localCount = filteredRepos.filter(
            ([_, e]) => e.type === "local"
          ).length
          output += `\nTotal: ${filteredRepos.length} repos (${cachedCount} cached, ${localCount} local)`

          return output
        },
      }),

      repo_scan: tool({
        description:
          "Scan local filesystem for git repositories and register them. Configure search paths in ~/.config/opencode/opencode-repos.json or override with paths argument.",
        args: {
          paths: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Override search paths (default: from config)"),
        },
        async execute(args) {
          let searchPaths: string[] | null = args.paths || null

          if (!searchPaths) {
            const config = await loadConfig()
            searchPaths = config?.localSearchPaths || null
          }

          if (!searchPaths || searchPaths.length === 0) {
            return `## No search paths configured

Create a config file at \`~/.config/opencode/opencode-repos.json\`:

\`\`\`json
{
  "localSearchPaths": [
    "~/projects",
    "~/personal/projects",
    "~/code"
  ]
}
\`\`\`

Or provide paths directly: \`repo_scan({ paths: ["~/projects"] })\``
          }

          const foundRepos = await scanLocalRepos(searchPaths)

          if (foundRepos.length === 0) {
            return `## No repositories found

Searched ${searchPaths.length} path(s):
${searchPaths.map((p) => `- ${p}`).join("\n")}

No git repositories with remotes were found.`
          }

          let newCount = 0
          let existingCount = 0

          await withManifestLock(async () => {
            const manifest = await loadManifest()

            for (const repo of foundRepos) {
              const spec = matchRemoteToSpec(repo.remote)
              if (!spec) continue

              const branch = repo.branch || "main"
              const repoKey = `${spec}@${branch}`

              if (manifest.repos[repoKey]) {
                existingCount++
                continue
              }

              const now = new Date().toISOString()
              manifest.repos[repoKey] = {
                type: "local",
                path: repo.path,
                lastAccessed: now,
                defaultBranch: branch,
                shallow: false,
              }

              manifest.localIndex[repo.remote] = repo.path

              newCount++
            }

            await saveManifest(manifest)
          })

          return `## Local Repository Scan Complete

**Found**: ${foundRepos.length} repositories in ${searchPaths.length} path(s)
**New**: ${newCount} repos registered
**Existing**: ${existingCount} repos already registered

${newCount > 0 ? "Use `repo_list()` to see all registered repositories." : ""}`
        },
      }),

      repo_update: tool({
        description:
          "Update a cached repository to latest. For local repos, shows git status without modifying. Only cached repos (cloned via repo_clone) are updated.",
        args: {
          repo: tool.schema
            .string()
            .describe(
              "Repository in format 'owner/repo' or 'owner/repo@branch'"
            ),
        },
        async execute(args) {
          const spec = parseRepoSpec(args.repo)
          const branch = spec.branch || "main"
          const repoKey = `${spec.owner}/${spec.repo}@${branch}`

          const manifest = await loadManifest()
          const entry = manifest.repos[repoKey]

          if (!entry) {
            return `## Repository not found

Repository \`${args.repo}\` is not registered.

Use \`repo_clone({ repo: "${args.repo}" })\` to clone it first.`
          }

          if (entry.type === "local") {
            try {
              const status = await $`git -C ${entry.path} status --short`.text()

              return `## Local Repository Status

**Repository**: ${args.repo}
**Path**: ${entry.path}
**Type**: Local (not modified by plugin)

\`\`\`
${status || "Working tree clean"}
\`\`\``
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              return `## Error getting status

Failed to get git status for ${args.repo}: ${message}`
            }
          }

          try {
            await updateRepo(entry.path, branch)

            const info = await getRepoInfo(entry.path)

            await withManifestLock(async () => {
              const updatedManifest = await loadManifest()
              if (updatedManifest.repos[repoKey]) {
                updatedManifest.repos[repoKey].lastUpdated = new Date().toISOString()
                updatedManifest.repos[repoKey].lastAccessed = new Date().toISOString()
                await saveManifest(updatedManifest)
              }
            })

            return `## Repository Updated

**Repository**: ${args.repo}
**Path**: ${entry.path}
**Branch**: ${branch}
**Latest Commit**: ${info.commit.substring(0, 7)}

Repository has been updated to the latest commit.`
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return `## Update Failed

Failed to update ${args.repo}: ${message}

The repository may be corrupted. Try \`repo_clone({ repo: "${args.repo}", force: true })\` to re-clone.`
          }
        },
      }),

      repo_remove: tool({
        description:
          "Remove a repository. Cached repos (cloned via repo_clone) are deleted from disk. Local repos are unregistered only (files preserved).",
        args: {
          repo: tool.schema
            .string()
            .describe(
              "Repository in format 'owner/repo' or 'owner/repo@branch'"
            ),
          confirm: tool.schema
            .boolean()
            .optional()
            .default(false)
            .describe("Confirm deletion for cached repos"),
        },
        async execute(args) {
          const spec = parseRepoSpec(args.repo)
          const branch = spec.branch || "main"
          const repoKey = `${spec.owner}/${spec.repo}@${branch}`

          const manifest = await loadManifest()
          const entry = manifest.repos[repoKey]

          if (!entry) {
            return `## Repository not found

Repository \`${args.repo}\` is not registered.

Use \`repo_list()\` to see all registered repositories.`
          }

          if (entry.type === "local") {
            await withManifestLock(async () => {
              const updatedManifest = await loadManifest()
              delete updatedManifest.repos[repoKey]

              for (const [remote, path] of Object.entries(updatedManifest.localIndex)) {
                if (path === entry.path) {
                  delete updatedManifest.localIndex[remote]
                  break
                }
              }

              await saveManifest(updatedManifest)
            })

            return `## Local Repository Unregistered

**Repository**: ${args.repo}
**Path**: ${entry.path}

The repository has been unregistered. Files are preserved at the path above.

To re-register, run \`repo_scan()\`.`
          }

          if (!args.confirm) {
            return `## Confirmation Required

**Repository**: ${args.repo}
**Path**: ${entry.path}
**Type**: Cached (cloned by plugin)

This will **permanently delete** the cached repository from disk.

To proceed: \`repo_remove({ repo: "${args.repo}", confirm: true })\`

To keep the repo but unregister it, manually delete it from \`~/.cache/opencode-repos/manifest.json\`.`
          }

          try {
            await rm(entry.path, { recursive: true, force: true })

            await withManifestLock(async () => {
              const updatedManifest = await loadManifest()
              delete updatedManifest.repos[repoKey]
              await saveManifest(updatedManifest)
            })

            return `## Cached Repository Deleted

**Repository**: ${args.repo}
**Path**: ${entry.path}

The repository has been permanently deleted from disk and unregistered from the cache.

To re-clone: \`repo_clone({ repo: "${args.repo}" })\``
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)

            try {
              await withManifestLock(async () => {
                const updatedManifest = await loadManifest()
                delete updatedManifest.repos[repoKey]
                await saveManifest(updatedManifest)
              })
            } catch {}

            return `## Deletion Failed

Failed to delete ${args.repo}: ${message}

The repository has been unregistered from the manifest. You may need to manually delete the directory at: ${entry.path}`
          }
        },
      }),

      repo_explore: tool({
        description:
          "Explore a repository to understand its codebase. Spawns a specialized exploration agent that analyzes the repo and answers your question. The agent will read source files, trace code paths, and explain architecture.",
        args: {
          repo: tool.schema
            .string()
            .describe(
              "Repository in format 'owner/repo' or 'owner/repo@branch'"
            ),
          question: tool.schema
            .string()
            .describe("What you want to understand about the codebase"),
        },
        async execute(args, ctx) {
          const spec = parseRepoSpec(args.repo)
          const branch = spec.branch || "main"
          const repoKey = `${spec.owner}/${spec.repo}@${branch}`

          let manifest = await loadManifest()
          let repoPath: string

          if (!manifest.repos[repoKey]) {
            try {
              repoPath = join(CACHE_DIR, spec.owner, `${spec.repo}@${branch}`)
              const url = buildGitUrl(spec.owner, spec.repo)

              await withManifestLock(async () => {
                await cloneRepo(url, repoPath, { branch })

                const now = new Date().toISOString()
                const updatedManifest = await loadManifest()
                updatedManifest.repos[repoKey] = {
                  type: "cached",
                  path: repoPath,
                  clonedAt: now,
                  lastAccessed: now,
                  lastUpdated: now,
                  defaultBranch: branch,
                  shallow: true,
                }
                await saveManifest(updatedManifest)
              })
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              return `## Failed to clone repository

Failed to clone ${args.repo}: ${message}

Please check that the repository exists and you have access to it.`
            }
          } else {
            repoPath = manifest.repos[repoKey].path
          }

          const explorationPrompt = `Explore the codebase at ${repoPath} and answer the following question:

${args.question}

Working directory: ${repoPath}

You have access to all standard code exploration tools:
- read: Read files
- glob: Find files by pattern
- grep: Search for patterns
- bash: Run git commands if needed

Remember to:
- Start with high-level structure (README, package.json, main files)
- Cite specific files and line numbers
- Include relevant code snippets
- Explain how components interact
`

          try {
            const response = await client.session.prompt({
              path: { id: ctx.sessionID },
              body: {
                agent: "repo-explorer",
                parts: [{ type: "text", text: explorationPrompt }],
              },
            })

            await withManifestLock(async () => {
              const updatedManifest = await loadManifest()
              if (updatedManifest.repos[repoKey]) {
                updatedManifest.repos[repoKey].lastAccessed =
                  new Date().toISOString()
                await saveManifest(updatedManifest)
              }
            })

            if (response.error) {
              return `## Exploration failed

Error from API: ${JSON.stringify(response.error)}`
            }

            const parts = response.data?.parts || []
            const textParts = parts.filter(p => p.type === "text")
            const texts = textParts.map(p => "text" in p ? p.text : "").filter(Boolean)
            return texts.join("\n\n") || "No response from exploration agent."
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            return `## Exploration failed

Failed to spawn exploration agent: ${message}

This may indicate an issue with the OpenCode session or agent registration.`
          }
        },
      }),
    },
  }
}

export default OpencodeRepos
