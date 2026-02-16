import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import {
  buildGitUrl,
  cloneRepo,
  getRepoInfo,
  getRepoRemote,
  isGitRepo,
  parseRepoSpec,
  switchBranch,
  updateRepo,
} from "./src/git"
import {
  loadManifest,
  saveManifest,
  setCacheDir,
  type RepoEntry,
  withManifestLock,
} from "./src/manifest"
import { findLocalRepoByName, matchRemoteToSpec, scanLocalRepos } from "./src/scanner"

interface Config {
  cacheDir?: string
  localSearchPaths?: string[]
  defaultBranch?: string
  useHttps?: boolean
  includeProjectParent?: boolean
}

interface ResolvedConfig {
  cacheDir: string
  localSearchPaths: string[]
  defaultBranch: string
  useHttps: boolean
  includeProjectParent: boolean
}

interface RepoTarget {
  owner: string
  repo: string
  repoKey: string
  branch: string
  explicitBranch: string | null
}

interface EnsureRepoResult {
  path: string
  branch: string
  type: "cached" | "local"
  status: "cached" | "cloned" | "reused"
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode-repos.json")

const DEFAULT_CONFIG: ResolvedConfig = {
  cacheDir: join(homedir(), ".cache", "opencode-repos"),
  localSearchPaths: [],
  defaultBranch: "main",
  useHttps: true,
  includeProjectParent: true,
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function uniqueStrings(values: string[]): string[] {
  const output: string[] = []
  for (const value of values) {
    if (!output.includes(value)) {
      output.push(value)
    }
  }
  return output
}

function nowIso(): string {
  return new Date().toISOString()
}

function hasGlobPattern(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[") || value.includes("{")
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const normalizedParent = resolve(parentPath)
  const normalizedCandidate = resolve(candidatePath)
  return (
    normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${sep}`)
  )
}

function expandHomePath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2))
  }
  return path
}

function parseLocalSearchPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const output: string[] = []
  for (const item of value) {
    if (typeof item !== "string") {
      continue
    }
    const normalized = resolve(expandHomePath(item.trim()))
    if (!normalized || output.includes(normalized)) {
      continue
    }
    output.push(normalized)
  }

  return output
}

async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) {
    return {}
  }

  try {
    const content = await readFile(CONFIG_PATH, "utf8")
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object") {
      return {}
    }
    return parsed as Config
  } catch {
    return {}
  }
}

function resolveConfig(userConfig: Config, projectDirectory?: string): ResolvedConfig {
  const cacheDir = userConfig.cacheDir
    ? resolve(expandHomePath(userConfig.cacheDir))
    : DEFAULT_CONFIG.cacheDir

  const configuredPaths = userConfig.localSearchPaths
    ? parseLocalSearchPaths(userConfig.localSearchPaths)
    : DEFAULT_CONFIG.localSearchPaths

  const includeProjectParent =
    typeof userConfig.includeProjectParent === "boolean"
      ? userConfig.includeProjectParent
      : DEFAULT_CONFIG.includeProjectParent

  const searchPaths = [...configuredPaths]
  if (includeProjectParent && projectDirectory) {
    const parent = dirname(projectDirectory)
    if (!searchPaths.includes(parent)) {
      searchPaths.push(parent)
    }
  }

  return {
    cacheDir,
    localSearchPaths: uniqueStrings(searchPaths),
    defaultBranch:
      typeof userConfig.defaultBranch === "string" && userConfig.defaultBranch.trim()
        ? userConfig.defaultBranch.trim()
        : DEFAULT_CONFIG.defaultBranch,
    useHttps: typeof userConfig.useHttps === "boolean" ? userConfig.useHttps : DEFAULT_CONFIG.useHttps,
    includeProjectParent,
  }
}

function resolveRepoTarget(repoInput: string, defaultBranch: string): RepoTarget {
  const spec = parseRepoSpec(repoInput)
  const repoKey = `${spec.owner}/${spec.repo}`

  return {
    owner: spec.owner,
    repo: spec.repo,
    repoKey,
    branch: spec.branch || defaultBranch,
    explicitBranch: spec.branch,
  }
}

function repoRemoteMatches(remote: string | null, repoKey: string): boolean {
  if (!remote) {
    return false
  }
  const remoteSpec = matchRemoteToSpec(remote)
  return remoteSpec?.toLowerCase() === repoKey.toLowerCase()
}

async function touchRepo(repoKey: string, branch?: string): Promise<void> {
  await withManifestLock(async () => {
    const manifest = await loadManifest()
    const entry = manifest.repos[repoKey]
    if (!entry) {
      return
    }

    entry.lastAccessed = nowIso()
    if (branch) {
      entry.currentBranch = branch
      entry.lastUpdated = nowIso()
    }

    await saveManifest(manifest)
  })
}

async function upsertCachedRepoEntry(
  repoKey: string,
  path: string,
  branch: string,
  remote: string,
  clonedAt?: string
): Promise<void> {
  await withManifestLock(async () => {
    const manifest = await loadManifest()
    const now = nowIso()
    const existing = manifest.repos[repoKey]

    const nextEntry: RepoEntry = {
      type: "cached",
      path,
      currentBranch: branch,
      lastAccessed: now,
      lastUpdated: now,
      clonedAt: clonedAt ?? existing?.clonedAt ?? now,
      shallow: true,
      remote,
    }

    manifest.repos[repoKey] = nextEntry
    await saveManifest(manifest)
  })
}

async function removeRepoEntry(repoKey: string, path?: string): Promise<void> {
  await withManifestLock(async () => {
    const manifest = await loadManifest()
    const existing = manifest.repos[repoKey]
    if (!existing) {
      return
    }

    delete manifest.repos[repoKey]

    const maybePath = path ?? existing.path
    for (const [remote, localPath] of Object.entries(manifest.localIndex)) {
      if (localPath === maybePath) {
        delete manifest.localIndex[remote]
      }
    }

    await saveManifest(manifest)
  })
}

async function cloneWithProtocolFallback(
  target: RepoTarget,
  destPath: string,
  useHttps: boolean
): Promise<{ branch: string; remote: string }> {
  const urls = uniqueStrings([
    buildGitUrl(target.owner, target.repo, useHttps),
    buildGitUrl(target.owner, target.repo, !useHttps),
  ])

  const errors: string[] = []

  for (const url of urls) {
    try {
      const cloned = await cloneRepo(url, destPath, target.explicitBranch ? { branch: target.explicitBranch } : {})
      return {
        branch: cloned.branch,
        remote: url,
      }
    } catch (error) {
      errors.push(`${url}: ${toErrorMessage(error)}`)
    }
  }

  throw new Error(`Unable to clone ${target.repoKey}. ${errors.join(" | ")}`)
}

async function ensureCachedRepo(config: ResolvedConfig, target: RepoTarget, force: boolean): Promise<EnsureRepoResult> {
  const manifest = await loadManifest()
  const existing = manifest.repos[target.repoKey]

  if (existing?.type === "local") {
    await touchRepo(target.repoKey)
    return {
      path: existing.path,
      branch: existing.currentBranch,
      type: "local",
      status: "cached",
    }
  }

  if (existing?.type === "cached" && !force) {
    if (await isGitRepo(existing.path)) {
      let branch = existing.currentBranch
      if (branch !== target.branch) {
        await switchBranch(existing.path, target.branch)
        branch = target.branch
      }

      await touchRepo(target.repoKey, branch !== existing.currentBranch ? branch : undefined)

      return {
        path: existing.path,
        branch,
        type: "cached",
        status: "cached",
      }
    }

    await removeRepoEntry(target.repoKey, existing.path)
  }

  const destPath = join(config.cacheDir, target.owner, target.repo)
  await mkdir(dirname(destPath), { recursive: true })

  if (existsSync(destPath)) {
    const reusable = !force && (await isGitRepo(destPath))
    if (reusable) {
      const remote = await getRepoRemote(destPath)
      if (repoRemoteMatches(remote, target.repoKey) && remote) {
        const info = await getRepoInfo(destPath)
        const currentBranch = info.branch || config.defaultBranch
        if (currentBranch !== target.branch) {
          await switchBranch(destPath, target.branch)
        }

        await upsertCachedRepoEntry(target.repoKey, destPath, target.branch, remote)
        return {
          path: destPath,
          branch: target.branch,
          type: "cached",
          status: "reused",
        }
      }
    }

    await rm(destPath, { recursive: true, force: true }).catch(() => undefined)
  }

  const cloned = await cloneWithProtocolFallback(target, destPath, config.useHttps)
  await upsertCachedRepoEntry(target.repoKey, destPath, cloned.branch, cloned.remote, nowIso())

  return {
    path: destPath,
    branch: cloned.branch,
    type: "cached",
    status: "cloned",
  }
}

async function readFiles(repoPath: string, inputPath: string, maxLines: number): Promise<string> {
  let matchedFiles: string[] = []

  if (hasGlobPattern(inputPath)) {
    const glob = new Bun.Glob(inputPath)
    for await (const relativePath of glob.scan({ cwd: repoPath, onlyFiles: true })) {
      const absolutePath = resolve(repoPath, relativePath)
      if (isPathWithin(repoPath, absolutePath)) {
        matchedFiles.push(absolutePath)
      }
    }
  } else {
    const absolutePath = resolve(repoPath, inputPath)
    if (!isPathWithin(repoPath, absolutePath)) {
      return "## Invalid path\n\nThe requested path resolves outside of the repository root."
    }

    if (!(await Bun.file(absolutePath).exists())) {
      return `## File not found\n\nNo file exists at \`${inputPath}\`.`
    }

    matchedFiles = [absolutePath]
  }

  if (matchedFiles.length === 0) {
    return `## No files found\n\nNo files matched \`${inputPath}\`.`
  }

  matchedFiles = uniqueStrings(matchedFiles).sort()

  let output = ""
  for (const filePath of matchedFiles) {
    const relativePath = relative(repoPath, filePath)
    output += `### ${relativePath}\n\n`

    try {
      const content = await readFile(filePath, "utf8")
      const lines = content.split("\n")
      const truncated = lines.length > maxLines
      const shownLines = truncated ? lines.slice(0, maxLines) : lines

      output += "```\n"
      output += shownLines.join("\n")
      if (truncated) {
        output += `\n[truncated at ${maxLines} lines, ${lines.length} total]`
      }
      output += "\n```\n\n"
    } catch (error) {
      output += `Failed to read file: ${toErrorMessage(error)}\n\n`
    }
  }

  return output.trimEnd()
}

function formatFindResults(
  query: string,
  registered: Array<{ key: string; type: "cached" | "local"; path: string; branch: string }>,
  local: Array<{ key: string; path: string; branch: string }>,
  github: Array<{ key: string; description: string; url: string }>
): string {
  let output = `## Repository Search: \"${query}\"\n\n`

  if (registered.length > 0) {
    output += "### Registered\n"
    for (const match of registered) {
      output += `- **${match.key}** (${match.type}) @ ${match.branch}\n  Path: ${match.path}\n`
    }
    output += "\n"
  }

  if (local.length > 0) {
    output += "### Found Locally (not registered)\n"
    for (const match of local) {
      output += `- **${match.key}** @ ${match.branch}\n  Path: ${match.path}\n`
    }
    output += "\n"
  }

  if (github.length > 0) {
    output += "### Found on GitHub\n"
    for (const match of github) {
      const description = match.description ? ` - ${match.description.slice(0, 100)}` : ""
      output += `- **${match.key}**${description}\n`
    }
    output += "\n"
  }

  if (registered.length === 0 && local.length === 0 && github.length === 0) {
    output += "No matches found.\n"
  }

  return output.trimEnd()
}

export const OpencodeRepos: Plugin = async ({ directory }) => {
  const userConfig = await loadConfig()
  const config = resolveConfig(userConfig, directory)

  setCacheDir(config.cacheDir)

  return {
    tool: {
      repo_clone: tool({
        description:
          "Clone a GitHub repository to local cache or return the existing cached path. Handles branch and protocol fallback to reduce git clone 128 errors.",
        args: {
          repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
          force: tool.schema.boolean().optional().default(false).describe("Delete and re-clone cache entry"),
        },
        async execute(args) {
          const target = resolveRepoTarget(args.repo, config.defaultBranch)

          try {
            const ensured = await ensureCachedRepo(config, target, args.force)
            const heading =
              ensured.status === "cached"
                ? "Repository already available"
                : ensured.status === "reused"
                  ? "Repository cache repaired"
                  : "Repository cloned"

            return `## ${heading}\n\n**Repository**: ${target.repoKey}\n**Branch**: ${ensured.branch}\n**Type**: ${ensured.type}\n**Path**: ${ensured.path}`
          } catch (error) {
            return `## Clone failed\n\nFailed to prepare \`${target.repoKey}\`: ${toErrorMessage(error)}`
          }
        },
      }),

      repo_list: tool({
        description: "List repositories currently registered in the local manifest.",
        args: {
          type: tool.schema
            .enum(["all", "cached", "local"])
            .optional()
            .default("all")
            .describe("Filter by repository type"),
        },
        async execute(args) {
          const manifest = await loadManifest()
          const entries = Object.entries(manifest.repos).filter(([, entry]) => {
            if (args.type === "all") {
              return true
            }
            return entry.type === args.type
          })

          if (entries.length === 0) {
            return "## No repositories registered"
          }

          let output = "## Registered Repositories\n\n"
          output += "| Repo | Type | Branch | Last Accessed | Path |\n"
          output += "|------|------|--------|---------------|------|\n"

          for (const [repoKey, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
            output += `| ${repoKey} | ${entry.type} | ${entry.currentBranch} | ${entry.lastAccessed} | ${entry.path} |\n`
          }

          return output.trimEnd()
        },
      }),

      repo_read: tool({
        description: "Read one or more files from a registered repository.",
        args: {
          repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
          path: tool.schema.string().describe("File path or glob pattern inside the repository"),
          maxLines: tool.schema.number().optional().default(500).describe("Maximum lines per file"),
        },
        async execute(args) {
          const target = resolveRepoTarget(args.repo, config.defaultBranch)
          const manifest = await loadManifest()
          const entry = manifest.repos[target.repoKey]

          if (!entry) {
            return `## Repository not registered\n\nClone first with \`repo_clone({ repo: \"${args.repo}\" })\`.`
          }

          if (entry.type === "cached" && entry.currentBranch !== target.branch) {
            try {
              await switchBranch(entry.path, target.branch)
              await touchRepo(target.repoKey, target.branch)
            } catch (error) {
              return `## Branch switch failed\n\nCould not switch to \`${target.branch}\`: ${toErrorMessage(error)}`
            }
          } else {
            await touchRepo(target.repoKey)
          }

          const content = await readFiles(entry.path, args.path, args.maxLines ?? 500)
          return `## Files from ${target.repoKey} @ ${target.branch}\n\n${content}`
        },
      }),

      repo_update: tool({
        description:
          "Update a cached repository to latest commit on its current branch, or the explicitly requested branch.",
        args: {
          repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
        },
        async execute(args) {
          const target = resolveRepoTarget(args.repo, config.defaultBranch)
          const manifest = await loadManifest()
          const entry = manifest.repos[target.repoKey]

          if (!entry) {
            return `## Repository not registered\n\nClone first with \`repo_clone({ repo: \"${args.repo}\" })\`.`
          }

          if (entry.type === "local") {
            try {
              const status = (await $`git -C ${entry.path} status --short`.text()).trim()
              await touchRepo(target.repoKey)
              return `## Local repository\n\n**Repository**: ${target.repoKey}\n**Path**: ${entry.path}\n\n\`\`\`\n${status || "Working tree clean"}\n\`\`\``
            } catch (error) {
              return `## Status failed\n\nCould not read local status: ${toErrorMessage(error)}`
            }
          }

          try {
            if (target.branch !== entry.currentBranch) {
              await switchBranch(entry.path, target.branch)
            } else {
              await updateRepo(entry.path)
            }

            const info = await getRepoInfo(entry.path)

            await withManifestLock(async () => {
              const next = await loadManifest()
              const current = next.repos[target.repoKey]
              if (!current) {
                return
              }
              current.currentBranch = info.branch || target.branch
              current.lastUpdated = nowIso()
              current.lastAccessed = nowIso()
              current.remote = info.remote
              await saveManifest(next)
            })

            return `## Repository updated\n\n**Repository**: ${target.repoKey}\n**Branch**: ${info.branch || target.branch}\n**Commit**: ${info.commit.slice(0, 7)}\n**Path**: ${entry.path}`
          } catch (error) {
            return `## Update failed\n\n${toErrorMessage(error)}`
          }
        },
      }),

      repo_remove: tool({
        description: "Remove a repository from the manifest. Cached repos can also be deleted from disk.",
        args: {
          repo: tool.schema.string().describe("Repository in format 'owner/repo' or 'owner/repo@branch'"),
          confirm: tool.schema.boolean().optional().default(false).describe("Required to delete cached repo files"),
        },
        async execute(args) {
          const target = resolveRepoTarget(args.repo, config.defaultBranch)
          const manifest = await loadManifest()
          const entry = manifest.repos[target.repoKey]

          if (!entry) {
            return `## Repository not found\n\n\`${target.repoKey}\` is not registered.`
          }

          if (entry.type === "local") {
            await removeRepoEntry(target.repoKey, entry.path)
            return `## Repository unregistered\n\n**Repository**: ${target.repoKey}\n**Type**: local\n**Path**: ${entry.path}\n\nFiles were not deleted.`
          }

          if (!args.confirm) {
            return `## Confirmation required\n\n\`${target.repoKey}\` is cached at:\n\`${entry.path}\`\n\nRun:\n\`repo_remove({ repo: \"${target.repoKey}\", confirm: true })\`\n\nThis deletes files from disk.`
          }

          await rm(entry.path, { recursive: true, force: true }).catch(() => undefined)
          await removeRepoEntry(target.repoKey, entry.path)

          return `## Repository removed\n\n**Repository**: ${target.repoKey}\n**Deleted path**: ${entry.path}`
        },
      }),

      repo_scan: tool({
        description:
          "Scan local search paths for Git repositories and register GitHub remotes as local repositories.",
        args: {
          paths: tool.schema.array(tool.schema.string()).optional().describe("Optional path override for this scan"),
        },
        async execute(args) {
          const providedPaths = args.paths ? parseLocalSearchPaths(args.paths) : []
          const searchPaths = providedPaths.length > 0 ? providedPaths : config.localSearchPaths

          if (searchPaths.length === 0) {
            return "## No search paths configured\n\nSet `localSearchPaths` in ~/.config/opencode/opencode-repos.json or pass `paths` to `repo_scan`."
          }

          const discovered = await scanLocalRepos(searchPaths)
          if (discovered.length === 0) {
            return `## Scan complete\n\nNo repositories found in ${searchPaths.length} search path(s).`
          }

          let added = 0
          let skipped = 0

          await withManifestLock(async () => {
            const manifest = await loadManifest()

            for (const repo of discovered) {
              const spec = matchRemoteToSpec(repo.remote)
              if (!spec) {
                skipped += 1
                continue
              }

              const existing = manifest.repos[spec]
              if (existing?.type === "cached") {
                skipped += 1
                continue
              }

              const now = nowIso()
              manifest.repos[spec] = {
                type: "local",
                path: repo.path,
                currentBranch: repo.branch || config.defaultBranch,
                lastAccessed: now,
                shallow: false,
                remote: repo.remote,
              }
              manifest.localIndex[repo.remote] = repo.path
              added += 1
            }

            await saveManifest(manifest)
          })

          return `## Scan complete\n\n**Search paths**: ${searchPaths.length}\n**Repositories found**: ${discovered.length}\n**Added/updated**: ${added}\n**Skipped**: ${skipped}`
        },
      }),

      repo_find: tool({
        description:
          "Find repositories by query across registered entries, local search paths, and GitHub (via gh CLI).",
        args: {
          query: tool.schema
            .string()
            .describe("Repository name or owner/repo, for example 'next.js' or 'vercel/next.js'"),
        },
        async execute(args) {
          const query = args.query.trim()
          const queryLower = query.toLowerCase()
          const manifest = await loadManifest()

          const registered: Array<{ key: string; type: "cached" | "local"; path: string; branch: string }> = []
          for (const [repoKey, entry] of Object.entries(manifest.repos)) {
            if (repoKey.toLowerCase().includes(queryLower)) {
              registered.push({
                key: repoKey,
                type: entry.type,
                path: entry.path,
                branch: entry.currentBranch,
              })
            }
          }

          const local: Array<{ key: string; path: string; branch: string }> = []
          let localScanError: string | null = null
          if (config.localSearchPaths.length > 0) {
            try {
              const localMatches = await findLocalRepoByName(config.localSearchPaths, query)
              for (const match of localMatches) {
                const alreadyRegistered = registered.some((item) => item.path === match.path)
                if (!alreadyRegistered) {
                  local.push({
                    key: match.spec,
                    path: match.path,
                    branch: match.branch,
                  })
                }
              }
            } catch (error) {
              localScanError = toErrorMessage(error)
            }
          }

          const github: Array<{ key: string; description: string; url: string }> = []
          let githubSearchError: string | null = null
          try {
            if (query.includes("/")) {
              const response = await $`gh repo view ${query} --json nameWithOwner,description,url`.text()
              const parsed = JSON.parse(response) as {
                nameWithOwner?: string
                description?: string | null
                url?: string
              }

              if (parsed.nameWithOwner && parsed.url) {
                github.push({
                  key: parsed.nameWithOwner,
                  description: parsed.description ?? "",
                  url: parsed.url,
                })
              }
            } else {
              const response = await $`gh search repos ${query} --limit 5 --json fullName,description,url`.text()
              const parsed = JSON.parse(response) as Array<{
                fullName?: string
                description?: string | null
                url?: string
              }>

              for (const result of parsed) {
                if (result.fullName && result.url) {
                  github.push({
                    key: result.fullName,
                    description: result.description ?? "",
                    url: result.url,
                  })
                }
              }
            }
          } catch (error) {
            githubSearchError = toErrorMessage(error)
          }

          let output = formatFindResults(query, registered, local, github)
          if (localScanError) {
            output += `\n\nLocal scan warning: ${localScanError}`
          }
          if (githubSearchError) {
            output += `\n\nGitHub search warning: ${githubSearchError}`
          }
          return output
        },
      }),
    },
  }
}

export default OpencodeRepos
