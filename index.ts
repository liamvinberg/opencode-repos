import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import { parseRepoSpec, buildGitUrl, cloneRepo, updateRepo, switchBranch, getRepoInfo } from "./src/git"
import { createRepoExplorerAgent } from "./src/agents/repo-explorer"
import {
  loadManifest,
  saveManifest,
  withManifestLock,
  setCacheDir,
  type RepoEntry,
} from "./src/manifest"
import { scanLocalRepos, matchRemoteToSpec, findLocalRepoByName } from "./src/scanner"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { existsSync } from "node:fs"
import { appendFile, mkdir, rm, readFile } from "node:fs/promises"

interface Config {
  localSearchPaths?: string[]
  cleanupMaxAgeDays?: number
  cacheDir?: string
  useHttps?: boolean
  autoSyncOnExplore?: boolean
  autoSyncIntervalHours?: number
  defaultBranch?: string
  includeProjectParent?: boolean
  debug?: boolean
  repoExplorerModel?: string
  debugLogPath?: string
}

const DEFAULTS = {
  cleanupMaxAgeDays: 30,
  cacheDir: join(tmpdir(), "opencode-repos"),
  useHttps: false,
  autoSyncOnExplore: true,
  autoSyncIntervalHours: 24,
  defaultBranch: "main",
  includeProjectParent: true,
  debug: false,
  repoExplorerModel: "opencode/grok-code",
  debugLogPath: join(homedir(), ".cache", "opencode-repos", "debug.log"),
} as const

function parseModelString(modelString: string): { providerID: string; modelID: string } | undefined {
  const parts = modelString.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined
  }
  return { providerID: parts[0], modelID: parts[1] }
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



async function runCleanup(maxAgeDays: number): Promise<void> {
  const cutoffMs = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)

  try {
    const manifest = await loadManifest()
    const staleKeys: string[] = []

    for (const [repoKey, entry] of Object.entries(manifest.repos)) {
      if (entry.type !== "cached") continue

      const lastAccessedMs = new Date(entry.lastAccessed).getTime()
      if (lastAccessedMs < cutoffMs) {
        staleKeys.push(repoKey)
      }
    }

    if (staleKeys.length === 0) return

    await withManifestLock(async () => {
      const updatedManifest = await loadManifest()

      for (const key of staleKeys) {
        const entry = updatedManifest.repos[key]
        if (!entry || entry.type !== "cached") continue

        try {
          await rm(entry.path, { recursive: true, force: true })
          delete updatedManifest.repos[key]
        } catch {}
      }

      await saveManifest(updatedManifest)
    })
  } catch {}
}

function resolveSearchPaths(
  configuredPaths: string[],
  includeProjectParent: boolean,
  projectDirectory?: string
): string[] {
  const resolved = [...configuredPaths]

  if (includeProjectParent && projectDirectory) {
    const parentDir = dirname(projectDirectory)
    if (!resolved.includes(parentDir)) {
      resolved.push(parentDir)
    }
  }

  return resolved
}

function shouldSyncRepo(lastUpdated: string | undefined, intervalHours: number): boolean {
  if (!lastUpdated) return true

  const lastUpdatedMs = new Date(lastUpdated).getTime()
  if (Number.isNaN(lastUpdatedMs)) return true

  const intervalMs = intervalHours * 60 * 60 * 1000
  return Date.now() - lastUpdatedMs >= intervalMs
}

function expandHomePath(input: string): string {
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2))
  }

  return input
}

async function resolveLocalPathQuery(
  query: string,
  defaultBranch: string
): Promise<{ candidate: RepoCandidate | null; error?: string }> {
  const expanded = expandHomePath(query.trim())

  if (!isAbsolute(expanded)) {
    return { candidate: null }
  }

  if (!existsSync(expanded)) {
    return { candidate: null, error: `Path does not exist: ${expanded}` }
  }

  if (!existsSync(join(expanded, ".git"))) {
    return { candidate: null, error: `No .git directory found at: ${expanded}` }
  }

  try {
    const [remote, branch] = await Promise.all([
      $`git -C ${expanded} remote get-url origin`.text(),
      $`git -C ${expanded} branch --show-current`.text(),
    ])

    if (!remote.trim()) {
      return {
        candidate: null,
        error: "Local repository has no origin remote. Add one to use repo_query.",
      }
    }

    const spec = matchRemoteToSpec(remote.trim())
    if (!spec) {
      return {
        candidate: null,
        error: "Origin remote is not a supported GitHub URL.",
      }
    }

    return {
      candidate: {
        key: spec,
        source: "local",
        path: expanded,
        branch: branch.trim() || defaultBranch,
        remote: remote.trim(),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      candidate: null,
      error: `Failed to read local repository metadata: ${message}`,
    }
  }
}

async function registerLocalRepo(
  repoKey: string,
  path: string,
  branch: string,
  remote: string
): Promise<void> {
  await withManifestLock(async () => {
    const manifest = await loadManifest()
    if (manifest.repos[repoKey]) return

    const now = new Date().toISOString()
    manifest.repos[repoKey] = {
      type: "local",
      path,
      lastAccessed: now,
      currentBranch: branch,
      shallow: false,
    }

    manifest.localIndex[remote] = path
    await saveManifest(manifest)
  })
}

async function resolveCandidates(
  query: string,
  searchPaths: string[],
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  defaultBranch: string,
  allowGithub: boolean
): Promise<{
  candidates: RepoCandidate[]
  exactRepoKey: string | null
  branchOverride: string | null
}> {
  const trimmed = query.trim()
  let exactRepoKey: string | null = null
  let branchOverride: string | null = null

  if (trimmed.includes("/")) {
    try {
      const spec = parseRepoSpec(trimmed)
      exactRepoKey = `${spec.owner}/${spec.repo}`
      branchOverride = spec.branch ?? null
    } catch {
      exactRepoKey = null
      branchOverride = null
    }
  }

  const queryLower = trimmed.toLowerCase()
  const candidates: RepoCandidate[] = []

  for (const [repoKey, entry] of Object.entries(manifest.repos)) {
    if (exactRepoKey) {
      if (repoKey.toLowerCase() !== exactRepoKey.toLowerCase()) continue
      candidates.push({
        key: repoKey,
        source: "registered",
        path: entry.path,
        branch: entry.currentBranch,
      })
      continue
    }

    if (repoKey.toLowerCase().includes(queryLower)) {
      candidates.push({
        key: repoKey,
        source: "registered",
        path: entry.path,
        branch: entry.currentBranch,
      })
    }
  }

  if (searchPaths.length > 0) {
    try {
      const localResults = await findLocalRepoByName(searchPaths, trimmed)
      for (const local of localResults) {
        if (exactRepoKey && local.spec.toLowerCase() !== exactRepoKey.toLowerCase()) {
          continue
        }

        candidates.push({
          key: local.spec,
          source: "local",
          path: local.path,
          branch: local.branch || defaultBranch,
          remote: local.remote,
        })
      }
    } catch {}
  }

  if (allowGithub) {
    try {
      if (exactRepoKey) {
        const repoCheck =
          await $`gh repo view ${exactRepoKey} --json nameWithOwner,description,url 2>/dev/null`.text()
        const repo = JSON.parse(repoCheck)
        candidates.push({
          key: repo.nameWithOwner,
          source: "github",
          description: repo.description || "",
          url: repo.url,
          branch: branchOverride ?? defaultBranch,
        })
      } else {
        const searchResult =
          await $`gh search repos ${trimmed} --limit 5 --json fullName,description,url 2>/dev/null`.text()
        const repos = JSON.parse(searchResult)
        for (const repo of repos) {
          candidates.push({
            key: repo.fullName,
            source: "github",
            description: repo.description || "",
            url: repo.url,
            branch: defaultBranch,
          })
        }
      }
    } catch {}
  }

  return {
    candidates: uniqueCandidates(candidates),
    exactRepoKey,
    branchOverride,
  }
}

async function ensureRepoAvailable(
  repoKey: string,
  branch: string,
  cacheDir: string,
  useHttps: boolean,
  autoSyncOnExplore: boolean,
  autoSyncIntervalHours: number
): Promise<{
  repoPath: string
  branch: string
  type: "cached" | "local"
}> {
  let manifest = await loadManifest()
  const entry = manifest.repos[repoKey]

  if (!entry) {
    const [owner, repo] = repoKey.split("/")
    const repoPath = join(cacheDir, owner, repo)
    const url = buildGitUrl(owner, repo, useHttps)

    let actualBranch = branch
    try {
      await withManifestLock(async () => {
        const cloneResult = await cloneRepo(url, repoPath, { branch })
        actualBranch = cloneResult.branch

        const now = new Date().toISOString()
        const updatedManifest = await loadManifest()
        updatedManifest.repos[repoKey] = {
          type: "cached",
          path: repoPath,
          clonedAt: now,
          lastAccessed: now,
          lastUpdated: now,
          currentBranch: actualBranch,
          shallow: true,
        }
        await saveManifest(updatedManifest)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Clone failed for ${repoKey}@${branch}: ${message}`)
    }

    return {
      repoPath,
      branch: actualBranch,
      type: "cached",
    }
  }

  const repoPath = entry.path

  if (entry.type === "cached") {
    try {
      if (entry.currentBranch !== branch) {
        await switchBranch(repoPath, branch)
        await withManifestLock(async () => {
          const updatedManifest = await loadManifest()
          if (updatedManifest.repos[repoKey]) {
            updatedManifest.repos[repoKey].currentBranch = branch
            updatedManifest.repos[repoKey].lastUpdated = new Date().toISOString()
            await saveManifest(updatedManifest)
          }
        })
      } else if (autoSyncOnExplore && shouldSyncRepo(entry.lastUpdated, autoSyncIntervalHours)) {
        await updateRepo(repoPath)
        await withManifestLock(async () => {
          const updatedManifest = await loadManifest()
          if (updatedManifest.repos[repoKey]) {
            updatedManifest.repos[repoKey].lastUpdated = new Date().toISOString()
            await saveManifest(updatedManifest)
          }
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Update failed for ${repoKey}@${branch}: ${message}`)
    }
  }

  return {
    repoPath,
    branch,
    type: entry.type,
  }
}

async function runRepoExplorer(
  client: RepoClient,
  ctx: RepoToolContext,
  repoKey: string,
  repoPath: string,
  question: string,
  model?: string,
  parentDirectory?: string
): Promise<string> {
  let sessionID: string | undefined

  // Validate that repo-explorer agent is available
  try {
    const agentsResult = await client.app.agents()
    const agents = agentsResult.data ?? []
    const agentNames = agents.map((a) => a.name)
    
    if (debugLogger) {
      debugLogger("repo_explore", [
        `repoKey: ${repoKey}`,
        `availableAgents: ${agentNames.join(", ") || "none"}`,
        `repoExplorerExists: ${agentNames.includes("repo-explorer")}`,
      ])
    }
    
    if (!agentNames.includes("repo-explorer")) {
      return `## Exploration failed

Repository: ${repoKey}
Path: ${repoPath}

The repo-explorer agent is not available. Available agents: ${agentNames.join(", ") || "none"}

This may indicate the opencode-repos plugin is not properly loaded.`
    }
  } catch (error) {
    if (debugLogger) {
      const message = error instanceof Error ? error.message : String(error)
      debugLogger("repo_explore", [
        `repoKey: ${repoKey}`,
        `agentValidationError: ${message}`,
      ])
    }
    // Continue anyway - the session.prompt will fail with a clearer error if agent doesn't exist
  }

  // Use parent directory for session creation (like oh-my-opencode does)
  // The repoPath will be passed in the prompt context instead
  const sessionDirectory = parentDirectory ?? repoPath

  try {
    const createResult = await client.session.create({
      body: {
        parentID: ctx.sessionID,
        title: `Repo explorer: ${repoKey}`,
      },
      query: {
        directory: sessionDirectory,
      },
    })

    sessionID = createResult.data?.id
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `## Exploration failed

Repository: ${repoKey}
Path: ${repoPath}

Failed to create a subagent session: ${message}`
  }

  if (!sessionID) {
    return `## Exploration failed

Repository: ${repoKey}
Path: ${repoPath}

Failed to create a subagent session (no session ID returned).`
  }

  const explorationPrompt = `Index the codebase and answer the following question:

${question}

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

  await Bun.sleep(150)

  let promptAttempt = 0
  const promptMaxAttempts = 3

  const parsedModel = model ? parseModelString(model) : undefined

  while (promptAttempt < promptMaxAttempts) {
    try {
      if (debugLogger) {
        debugLogger("repo_explore", [
          `repoKey: ${repoKey}`,
          `sessionID: ${sessionID}`,
          `promptSending: attempt ${promptAttempt + 1}`,
          `model: ${parsedModel ? `${parsedModel.providerID}/${parsedModel.modelID}` : "default"}`,
        ])
      }
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          agent: "repo-explorer",
          tools: {
            task: false,
            delegate_task: false,
          },
          parts: [{ type: "text", text: explorationPrompt }],
          ...(parsedModel ? { model: parsedModel } : {}),
        },
      })
      if (debugLogger) {
        debugLogger("repo_explore", [
          `repoKey: ${repoKey}`,
          `sessionID: ${sessionID}`,
          `promptSent: success`,
        ])
      }
      break
    } catch (error) {
      promptAttempt += 1
      const message = error instanceof Error ? error.message : String(error)
      if (debugLogger) {
        debugLogger("repo_explore", [
          `repoKey: ${repoKey}`,
          `sessionID: ${sessionID}`,
          `promptError: ${message}`,
          `promptAttempt: ${promptAttempt}`,
        ])
      }

      if (promptAttempt >= promptMaxAttempts) {
        return `## Exploration failed

Repository: ${repoKey}
Session: ${sessionID}
Path: ${repoPath}

Failed to run exploration agent: ${message}`
      }

      await Bun.sleep(300 * promptAttempt)
    }
  }

  const pollStart = Date.now()
  const maxPollMs = 5 * 60 * 1000
  const pollIntervalMs = 500
  const minStabilityTimeMs = 10000
  const stabilityPollsRequired = 3
  let lastMsgCount = 0
  let stablePolls = 0
  let pollCount = 0

  if (debugLogger) {
    debugLogger("repo_explore", [
      `repoKey: ${repoKey}`,
      `sessionID: ${sessionID}`,
      `pollStart: starting poll loop`,
    ])
  }

  while (Date.now() - pollStart < maxPollMs) {
    await Bun.sleep(pollIntervalMs)
    pollCount++

    try {
      const statusResult = await client.session.status()
      const allStatuses = (statusResult.data ?? {}) as Record<string, { type: string }>
      const sessionStatus = allStatuses[sessionID]

      if (pollCount % 10 === 0 && debugLogger) {
        debugLogger("repo_explore", [
          `repoKey: ${repoKey}`,
          `sessionID: ${sessionID}`,
          `pollCount: ${pollCount}`,
          `elapsed: ${Math.floor((Date.now() - pollStart) / 1000)}s`,
          `sessionStatus: ${sessionStatus?.type ?? "not_in_status"}`,
          `stablePolls: ${stablePolls}`,
          `lastMsgCount: ${lastMsgCount}`,
        ])
      }

      if (sessionStatus && sessionStatus.type !== "idle") {
        stablePolls = 0
        lastMsgCount = 0
        continue
      }

      const elapsed = Date.now() - pollStart
      if (elapsed < minStabilityTimeMs) {
        continue
      }

      const messagesResult = await client.session.messages({ path: { id: sessionID } })
      const messages = messagesResult.data ?? []
      const currentMsgCount = messages.length

      if (currentMsgCount === lastMsgCount) {
        stablePolls += 1
        if (stablePolls >= stabilityPollsRequired) {
          if (debugLogger) {
            debugLogger("repo_explore", [
              `repoKey: ${repoKey}`,
              `sessionID: ${sessionID}`,
              `pollComplete: messages stable`,
              `currentMsgCount: ${currentMsgCount}`,
            ])
          }
          break
        }
      } else {
        stablePolls = 0
        lastMsgCount = currentMsgCount
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (debugLogger) {
        debugLogger("repo_explore", [
          `repoKey: ${repoKey}`,
          `sessionID: ${sessionID}`,
          `pollError: ${message}`,
        ])
      }
    }
  }

  if (Date.now() - pollStart >= maxPollMs) {
    return `## Exploration failed

Repository: ${repoKey}
Session: ${sessionID}
Path: ${repoPath}

Timed out waiting for subagent output.`
  }

  const messagesResult = await client.session.messages({ path: { id: sessionID } })
  const messages = messagesResult.data ?? []
  const extracted: string[] = []

  for (const message of messages) {
    const parts = message.parts ?? []
    for (const part of parts) {
      if (
        typeof part === "object" &&
        part &&
        "type" in part &&
        (part as { type: string }).type === "text" &&
        "text" in part
      ) {
        const textValue = (part as { text?: string }).text
        if (textValue) extracted.push(textValue)
      } else if (
        typeof part === "object" &&
        part &&
        "type" in part &&
        (part as { type: string }).type === "tool_result"
      ) {
        const toolResult = part as { content?: unknown }
        if (typeof toolResult.content === "string") {
          extracted.push(toolResult.content)
        } else if (Array.isArray(toolResult.content)) {
          for (const block of toolResult.content) {
            if (block && typeof block === "object" && "text" in block) {
              const blockText = (block as { text?: string }).text
              if (blockText) extracted.push(blockText)
            }
          }
        }
      }
    }
  }

  const responseText = extracted.filter(Boolean).join("\n\n")
  return responseText || "No response from exploration agent."
}

interface RepoToolContext {
  sessionID: string
}

interface PermissionContext {
  ask: (input: {
    permission: "external_directory"
    patterns: string[]
    always: string[]
    metadata: Record<string, string>
  }) => Promise<void>
}

interface RepoClient {
  session: {
    create: (input: {
      body: { parentID?: string; title?: string }
      query?: { directory?: string }
    }) => Promise<{ data?: { id?: string } }>
    get: (input: { path: { id: string } }) => Promise<{ data?: { id?: string; directory?: string } }>
    status: () => Promise<{ data?: Record<string, { type: string }> }>
    messages: (input: { path: { id: string } }) => Promise<{ data?: Array<{ parts?: unknown[] }> }>
    prompt: (input: {
      path: { id: string }
      body: {
        agent: string
        parts: Array<{ type: "text"; text: string }>
        tools?: Record<string, boolean>
        model?: { providerID: string; modelID: string }
      }
    }) => Promise<{
      error?: unknown
      data?: { parts?: Array<{ type: string; text?: string }> }
    }>
  }
  app: {
    agents: () => Promise<{ data?: Array<{ name: string; mode?: string }> }>
  }
}

type RepoSource = "registered" | "local" | "github"

interface RepoCandidate {
  key: string
  source: RepoSource
  path?: string
  branch?: string
  description?: string
  url?: string
  remote?: string
}

interface RepoQueryDebugInfo {
  query: string
  allowGithub: boolean
  localSearchPaths: string[]
  candidates: RepoCandidate[]
  selectedTargets: Array<{ repoKey: string; branch: string }>
}

function uniqueCandidates(candidates: RepoCandidate[]): RepoCandidate[] {
  const map = new Map<string, RepoCandidate>()
  for (const candidate of candidates) {
    if (!map.has(candidate.key)) {
      map.set(candidate.key, candidate)
    }
  }
  return Array.from(map.values())
}

async function touchRepoAccess(repoKey: string): Promise<void> {
  await withManifestLock(async () => {
    const updatedManifest = await loadManifest()
    if (updatedManifest.repos[repoKey]) {
      updatedManifest.repos[repoKey].lastAccessed = new Date().toISOString()
      await saveManifest(updatedManifest)
    }
  })
}

function formatRepoQueryDebug(info: RepoQueryDebugInfo): string {
  let output = "## Debug\n\n"
  output += `Query: ${info.query}\n`
  output += `GitHub search enabled: ${info.allowGithub}\n`
  output += `Local search paths: ${info.localSearchPaths.length}\n`
  for (const path of info.localSearchPaths) {
    output += `- ${path}\n`
  }
  output += "\nCandidates:\n"
  if (info.candidates.length === 0) {
    output += "- none\n"
  } else {
    for (const candidate of info.candidates) {
      output += `- ${candidate.key} (${candidate.source})\n`
    }
  }
  output += "\nSelected targets:\n"
  if (info.selectedTargets.length === 0) {
    output += "- none\n"
  } else {
    for (const target of info.selectedTargets) {
      output += `- ${target.repoKey} @ ${target.branch}\n`
    }
  }
  return output
}

type DebugLogger = (toolName: string, lines: string[]) => void

let debugLogger: DebugLogger | null = null

function appendDebug(
  output: string,
  toolName: string,
  lines: string[],
  enabled: boolean
): string {
  if (!enabled) return output

  if (debugLogger) {
    debugLogger(toolName, lines)
  }

  let section = `\n\n## Debug\n\nTool: ${toolName}\n`
  for (const line of lines) {
    section += `- ${line}\n`
  }

  return `${output}${section}`
}

function createDebugLogger(path: string, enabled: boolean): DebugLogger | null {
  if (!enabled) return null

  return (toolName, lines) => {
    const timestamp = new Date().toISOString()
    const payload = [
      `[${timestamp}] ${toolName}`,
      ...lines.map((line) => `- ${line}`),
      "",
    ].join("\n")

    void appendFile(path, payload)
  }
}

function logRepoQueryDebug(info: RepoQueryDebugInfo): void {
  if (!debugLogger) return

  const lines: string[] = [
    `query: ${info.query}`,
    `allowGithub: ${info.allowGithub}`,
    `localSearchPaths: ${info.localSearchPaths.length}`,
    `candidates: ${info.candidates.map((c) => c.key).join(", ") || "none"}`,
    `selected: ${info.selectedTargets.map((t) => t.repoKey).join(", ") || "none"}`,
  ]

  debugLogger("repo_query", lines)
}

async function requestExternalDirectoryAccess(
  ctx: PermissionContext,
  targetPath: string
): Promise<void> {
  const parentDir = dirname(targetPath)
  const glob = join(parentDir, "*")
  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: targetPath,
      parentDir,
    },
  })
}

export const OpencodeRepos: Plugin = async ({ client, directory }) => {
  const userConfig = await loadConfig()

  const cacheDir = userConfig?.cacheDir ?? DEFAULTS.cacheDir
  const useHttps = userConfig?.useHttps ?? DEFAULTS.useHttps
  const autoSyncOnExplore = userConfig?.autoSyncOnExplore ?? DEFAULTS.autoSyncOnExplore
  const autoSyncIntervalHours =
    userConfig?.autoSyncIntervalHours ?? DEFAULTS.autoSyncIntervalHours
  const defaultBranch = userConfig?.defaultBranch ?? DEFAULTS.defaultBranch
  const cleanupMaxAgeDays = userConfig?.cleanupMaxAgeDays ?? DEFAULTS.cleanupMaxAgeDays
  const includeProjectParent =
    userConfig?.includeProjectParent ?? DEFAULTS.includeProjectParent
  const debugEnabled = userConfig?.debug ?? DEFAULTS.debug
  const repoExplorerModel =
    userConfig?.repoExplorerModel ?? DEFAULTS.repoExplorerModel
  const debugLogPath = expandHomePath(
    userConfig?.debugLogPath ?? DEFAULTS.debugLogPath
  )
  const localSearchPaths = resolveSearchPaths(
    userConfig?.localSearchPaths ?? [],
    includeProjectParent,
    directory
  )

  setCacheDir(cacheDir)

  if (debugEnabled) {
    await mkdir(dirname(debugLogPath), { recursive: true })
  }

  debugLogger = createDebugLogger(debugLogPath, debugEnabled)

  runCleanup(cleanupMaxAgeDays)

  return {
    config: async (config) => {
      const explorerAgent = createRepoExplorerAgent(repoExplorerModel)
      config.agent = {
        ...config.agent,
        "repo-explorer": explorerAgent,
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      output.context.push(`## External Repository Access
When user mentions another project or asks about external code:
1. Use \`repo_find\` to check if it exists locally or on GitHub
2. Tell user what you found before cloning
3. Only clone after user confirms or explicitly requests it`)
    },

    tool: {
      repo_clone: tool({
        description:
          "Clone a repository to local cache or return path if already cached. Supports public and private repos. Example: repo_clone({ repo: 'vercel/next.js' }) or repo_clone({ repo: 'vercel/next.js@canary', force: true })",
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
          const branch = spec.branch || defaultBranch
          const repoKey = `${spec.owner}/${spec.repo}`

          const result = await withManifestLock(async () => {
            const manifest = await loadManifest()
            const existingEntry = manifest.repos[repoKey]
            const destPath = join(cacheDir, spec.owner, spec.repo)

            if (existingEntry && !args.force) {
              if (existingEntry.currentBranch !== branch) {
                await switchBranch(existingEntry.path, branch)
                existingEntry.currentBranch = branch
                existingEntry.lastUpdated = new Date().toISOString()
              }
              existingEntry.lastAccessed = new Date().toISOString()
              await saveManifest(manifest)

              return {
                path: existingEntry.path,
                branch,
                status: "cached" as const,
                alreadyExists: true,
              }
            }

            const url = buildGitUrl(spec.owner, spec.repo, useHttps)

            if (args.force && existingEntry) {
              try {
                await rm(destPath, { recursive: true, force: true })
              } catch {}
            }

            let actualBranch = branch
            try {
              const cloneResult = await cloneRepo(url, destPath, { branch })
              actualBranch = cloneResult.branch
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
              currentBranch: actualBranch,
              shallow: true,
            }
            manifest.repos[repoKey] = entry

            await saveManifest(manifest)

            return {
              path: destPath,
              branch: actualBranch,
              status: "cloned" as const,
              alreadyExists: false,
            }
          })

          const statusText = result.alreadyExists
            ? "Repository already cached"
            : "Successfully cloned repository"

          let output = `## ${statusText}

**Repository**: ${repoKey}
**Branch**: ${result.branch}
**Path**: ${result.path}
**Status**: ${result.status}

You can now use \`repo_read\` to access files from this repository.`

          output = appendDebug(
            output,
            "repo_clone",
            [
              `repoKey: ${repoKey}`,
              `branch: ${result.branch}`,
              `path: ${result.path}`,
              `cacheDir: ${cacheDir}`,
              `useHttps: ${useHttps}`,
              `force: ${args.force}`,
            ],
            debugEnabled
          )

          return output
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
          const branch = spec.branch || defaultBranch
          const repoKey = `${spec.owner}/${spec.repo}`

          const manifest = await loadManifest()
          const entry = manifest.repos[repoKey]

          if (!entry) {
            let output = `## Repository not found

Repository \`${spec.owner}/${spec.repo}\` is not registered.

Use \`repo_clone({ repo: "${args.repo}" })\` to clone it first.`
            output = appendDebug(
              output,
              "repo_read",
              [`repoKey: ${repoKey}`, `branch: ${branch}`],
              debugEnabled
            )
            return output
          }

          if (entry.type === "cached" && entry.currentBranch !== branch) {
            await switchBranch(entry.path, branch)
            await withManifestLock(async () => {
              const updatedManifest = await loadManifest()
              if (updatedManifest.repos[repoKey]) {
                updatedManifest.repos[repoKey].currentBranch = branch
                updatedManifest.repos[repoKey].lastUpdated = new Date().toISOString()
                await saveManifest(updatedManifest)
              }
            })
          }

          const repoPath = entry.path
          const fullPath = join(repoPath, args.path)

          let filePaths: string[] = []

          if (args.path.includes("*") || args.path.includes("?")) {
            const fdResult = await $`fd -t f -g ${args.path} ${repoPath}`.text()
            filePaths = fdResult.split("\n").filter(Boolean)
          } else {
            filePaths = [fullPath]
          }

          if (filePaths.length === 0) {
            const output = appendDebug(
              `No files found matching path: ${args.path}`,
              "repo_read",
              [`repoKey: ${repoKey}`, `branch: ${branch}`],
              debugEnabled
            )
            return output
          }

          let output = `## Files from ${repoKey} @ ${branch}\n\n`
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

          output = appendDebug(
            output,
            "repo_read",
            [
              `repoKey: ${repoKey}`,
              `branch: ${branch}`,
              `files: ${filePaths.length}`,
            ],
            debugEnabled
          )

          return output
        },
      }),

      repo_list: tool({
        description:
          "List all registered repositories (cached and local). Shows metadata like type, current branch, freshness (for cached), and size.",
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
            return appendDebug(
              "No repositories registered.",
              "repo_list",
              [`type: ${args.type}`],
              debugEnabled
            )
          }

          let output = "## Registered Repositories\n\n"
          output += "| Repo | Type | Branch | Last Updated | Size |\n"
          output += "|------|------|--------|--------------|------|\n"

          for (const [repoKey, entry] of filteredRepos) {
            const size = entry.sizeBytes
              ? `${Math.round(entry.sizeBytes / 1024 / 1024)}MB`
              : "-"

            let freshness = "-"
            if (entry.type === "cached" && entry.lastUpdated) {
              const daysSinceUpdate = Math.floor(
                (Date.now() - new Date(entry.lastUpdated).getTime()) / (1000 * 60 * 60 * 24)
              )
              freshness = daysSinceUpdate === 0 ? "today" : `${daysSinceUpdate}d ago`
            }

            output += `| ${repoKey} | ${entry.type} | ${entry.currentBranch} | ${freshness} | ${size} |\n`
          }

          const cachedCount = filteredRepos.filter(
            ([_, e]) => e.type === "cached"
          ).length
          const localCount = filteredRepos.filter(
            ([_, e]) => e.type === "local"
          ).length
          output += `\nTotal: ${filteredRepos.length} repos (${cachedCount} cached, ${localCount} local)`

          return appendDebug(
            output,
            "repo_list",
            [`type: ${args.type}`, `total: ${filteredRepos.length}`],
            debugEnabled
          )
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
          const searchPaths = args.paths ?? (localSearchPaths.length > 0 ? localSearchPaths : null)

          if (!searchPaths || searchPaths.length === 0) {
            let output = `## No search paths configured

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
            output = appendDebug(
              output,
              "repo_scan",
              ["searchPaths: none"],
              debugEnabled
            )
            return output
          }

          const foundRepos = await scanLocalRepos(searchPaths)

          if (foundRepos.length === 0) {
            let output = `## No repositories found

Searched ${searchPaths.length} path(s):
${searchPaths.map((p) => `- ${p}`).join("\n")}

No git repositories with remotes were found.`
            output = appendDebug(
              output,
              "repo_scan",
              [`searchPaths: ${searchPaths.length}`],
              debugEnabled
            )
            return output
          }

          let newCount = 0
          let existingCount = 0

          await withManifestLock(async () => {
            const manifest = await loadManifest()

            for (const repo of foundRepos) {
              const spec = matchRemoteToSpec(repo.remote)
              if (!spec) continue

              const branch = repo.branch || defaultBranch
              const repoKey = spec

              if (manifest.repos[repoKey]) {
                existingCount++
                continue
              }

              const now = new Date().toISOString()
              manifest.repos[repoKey] = {
                type: "local",
                path: repo.path,
                lastAccessed: now,
                currentBranch: branch,
                shallow: false,
              }

              manifest.localIndex[repo.remote] = repo.path

              newCount++
            }

            await saveManifest(manifest)
          })

          let output = `## Local Repository Scan Complete

**Found**: ${foundRepos.length} repositories in ${searchPaths.length} path(s)
**New**: ${newCount} repos registered
**Existing**: ${existingCount} repos already registered

${newCount > 0 ? "Use `repo_list()` to see all registered repositories." : ""}`
          output = appendDebug(
            output,
            "repo_scan",
            [
              `searchPaths: ${searchPaths.length}`,
              `found: ${foundRepos.length}`,
              `new: ${newCount}`,
            ],
            debugEnabled
          )
          return output
        },
      }),

      repo_update: tool({
        description:
          "Update a cached repository to latest. Optionally switch to a different branch first. For local repos, shows git status without modifying.",
        args: {
          repo: tool.schema
            .string()
            .describe(
              "Repository in format 'owner/repo' or 'owner/repo@branch'"
            ),
        },
        async execute(args) {
          const spec = parseRepoSpec(args.repo)
          const requestedBranch = spec.branch
          const repoKey = `${spec.owner}/${spec.repo}`

          const manifest = await loadManifest()
          const entry = manifest.repos[repoKey]

          if (!entry) {
            let output = `## Repository not found

Repository \`${repoKey}\` is not registered.

Use \`repo_clone({ repo: "${args.repo}" })\` to clone it first.`
            output = appendDebug(
              output,
              "repo_update",
              [`repoKey: ${repoKey}`],
              debugEnabled
            )
            return output
          }

          if (entry.type === "local") {
            try {
              const status = await $`git -C ${entry.path} status --short`.text()

              return `## Local Repository Status

**Repository**: ${repoKey}
**Path**: ${entry.path}
**Branch**: ${entry.currentBranch}
**Type**: Local (not modified by plugin)

\`\`\`
${status || "Working tree clean"}
\`\`\``
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              let output = `## Error getting status

Failed to get git status for ${repoKey}: ${message}`
              output = appendDebug(
                output,
                "repo_update",
                [`repoKey: ${repoKey}`, `path: ${entry.path}`],
                debugEnabled
              )
              return output
            }
          }

          try {
            const targetBranch = requestedBranch || entry.currentBranch

            if (targetBranch !== entry.currentBranch) {
              await switchBranch(entry.path, targetBranch)
            } else {
              await updateRepo(entry.path)
            }

            const info = await getRepoInfo(entry.path)

            await withManifestLock(async () => {
              const updatedManifest = await loadManifest()
              if (updatedManifest.repos[repoKey]) {
                updatedManifest.repos[repoKey].currentBranch = targetBranch
                updatedManifest.repos[repoKey].lastUpdated = new Date().toISOString()
                updatedManifest.repos[repoKey].lastAccessed = new Date().toISOString()
                await saveManifest(updatedManifest)
              }
            })

            let output = `## Repository Updated

**Repository**: ${repoKey}
**Path**: ${entry.path}
**Branch**: ${targetBranch}
**Latest Commit**: ${info.commit.substring(0, 7)}

Repository has been updated to the latest commit.`
            output = appendDebug(
              output,
              "repo_update",
              [`repoKey: ${repoKey}`, `branch: ${targetBranch}`],
              debugEnabled
            )
            return output
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            let output = `## Update Failed

Failed to update ${repoKey}: ${message}

The repository may be corrupted. Try \`repo_clone({ repo: "${args.repo}", force: true })\` to re-clone.`
            output = appendDebug(
              output,
              "repo_update",
              [`repoKey: ${repoKey}`],
              debugEnabled
            )
            return output
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
              "Repository in format 'owner/repo'"
            ),
          confirm: tool.schema
            .boolean()
            .optional()
            .default(false)
            .describe("Confirm deletion for cached repos"),
        },
        async execute(args) {
          const spec = parseRepoSpec(args.repo)
          const repoKey = `${spec.owner}/${spec.repo}`

          const manifest = await loadManifest()
          const entry = manifest.repos[repoKey]

          if (!entry) {
            let output = `## Repository not found

Repository \`${repoKey}\` is not registered.

Use \`repo_list()\` to see all registered repositories.`
            output = appendDebug(
              output,
              "repo_remove",
              [`repoKey: ${repoKey}`],
              debugEnabled
            )
            return output
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

            let output = `## Local Repository Unregistered

**Repository**: ${repoKey}
**Path**: ${entry.path}

The repository has been unregistered. Files are preserved at the path above.

To re-register, run \`repo_scan()\`.`
            output = appendDebug(
              output,
              "repo_remove",
              [`repoKey: ${repoKey}`, `path: ${entry.path}`],
              debugEnabled
            )
            return output
          }

          if (!args.confirm) {
            let output = `## Confirmation Required

**Repository**: ${repoKey}
**Path**: ${entry.path}
**Type**: Cached (cloned by plugin)

This will **permanently delete** the cached repository from disk.

To proceed: \`repo_remove({ repo: "${repoKey}", confirm: true })\`

To keep the repo but unregister it, manually delete it from \`~/.cache/opencode-repos/manifest.json\`.`
            output = appendDebug(
              output,
              "repo_remove",
              [`repoKey: ${repoKey}`, `path: ${entry.path}`],
              debugEnabled
            )
            return output
          }

          try {
            await rm(entry.path, { recursive: true, force: true })

            await withManifestLock(async () => {
              const updatedManifest = await loadManifest()
              delete updatedManifest.repos[repoKey]
              await saveManifest(updatedManifest)
            })

            let output = `## Cached Repository Deleted

**Repository**: ${repoKey}
**Path**: ${entry.path}

The repository has been permanently deleted from disk and unregistered from the cache.

To re-clone: \`repo_clone({ repo: "${repoKey}" })\``
            output = appendDebug(
              output,
              "repo_remove",
              [`repoKey: ${repoKey}`, `path: ${entry.path}`],
              debugEnabled
            )
            return output
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)

            try {
              await withManifestLock(async () => {
                const updatedManifest = await loadManifest()
                delete updatedManifest.repos[repoKey]
                await saveManifest(updatedManifest)
              })
            } catch {}

            let output = `## Deletion Failed

Failed to delete ${repoKey}: ${message}

The repository has been unregistered from the manifest. You may need to manually delete the directory at: ${entry.path}`
            output = appendDebug(
              output,
              "repo_remove",
              [`repoKey: ${repoKey}`, `path: ${entry.path}`],
              debugEnabled
            )
            return output
          }
        },
      }),

      repo_find: tool({
        description:
          "Search for a repository locally and on GitHub. Use this BEFORE cloning to check if a repo already exists locally or to find the correct GitHub repo. Returns location info without cloning.",
        args: {
          query: tool.schema
            .string()
            .describe(
              "Repository name or owner/repo format. Examples: 'next.js', 'vercel/next.js', 'react'"
            ),
        },
        async execute(args) {
          const query = args.query.trim()
          const results: {
            registered: Array<{ key: string; path: string; type: string }>
            local: Array<{ path: string; spec: string; branch: string }>
            github: Array<{ fullName: string; description: string; url: string }>
          } = {
            registered: [],
            local: [],
            github: [],
          }

          const manifest = await loadManifest()
          const queryLower = query.toLowerCase()

          for (const [repoKey, entry] of Object.entries(manifest.repos)) {
            if (repoKey.toLowerCase().includes(queryLower)) {
              results.registered.push({
                key: repoKey,
                path: entry.path,
                type: entry.type,
              })
            }
          }

          if (localSearchPaths.length > 0) {
            try {
              const localResults = await findLocalRepoByName(
                localSearchPaths,
                query
              )
              for (const local of localResults) {
                const alreadyRegistered = results.registered.some(
                  (r) => r.path === local.path
                )
                if (!alreadyRegistered) {
                  results.local.push({
                    path: local.path,
                    spec: local.spec,
                    branch: local.branch,
                  })
                }
              }
            } catch {}
          }

          try {
            if (query.includes("/")) {
              const repoCheck =
                await $`gh repo view ${query} --json nameWithOwner,description,url 2>/dev/null`.text()
              const repo = JSON.parse(repoCheck)
              results.github.push({
                fullName: repo.nameWithOwner,
                description: repo.description || "",
                url: repo.url,
              })
            } else {
              const searchResult =
                await $`gh search repos ${query} --limit 5 --json fullName,description,url 2>/dev/null`.text()
              const repos = JSON.parse(searchResult)
              for (const repo of repos) {
                results.github.push({
                  fullName: repo.fullName,
                  description: repo.description || "",
                  url: repo.url,
                })
              }
            }
          } catch {}

          let output = `## Repository Search: "${query}"\n\n`

          if (results.registered.length > 0) {
            output += `### Already Registered\n`
            for (const r of results.registered) {
              output += `- **${r.key}** (${r.type})\n  Path: ${r.path}\n`
            }
            output += `\n`
          }

          if (results.local.length > 0) {
            output += `### Found Locally (not registered)\n`
            for (const r of results.local) {
              output += `- **${r.spec}** @ ${r.branch}\n  Path: ${r.path}\n`
            }
            output += `\nUse \`repo_scan()\` to register these.\n\n`
          }

          if (results.github.length > 0) {
            output += `### Found on GitHub\n`
            for (const r of results.github) {
              const desc = r.description ? ` - ${r.description.slice(0, 60)}` : ""
              output += `- **${r.fullName}**${desc}\n`
            }
            output += `\nUse \`repo_clone({ repo: "owner/repo" })\` to clone.\n`
          }

          if (
            results.registered.length === 0 &&
            results.local.length === 0 &&
            results.github.length === 0
          ) {
            output += `No repositories found matching "${query}".\n\n`
            output += `Tips:\n`
            output += `- Try a different search term\n`
            output += `- Use owner/repo format for exact match\n`
            output += `- Check if gh CLI is authenticated\n`
          }

          output = appendDebug(
            output,
            "repo_find",
            [`query: ${query}`, `localSearchPaths: ${localSearchPaths.length}`],
            debugEnabled
          )
          return output
        },
      }),

      repo_pick_dir: tool({
        description:
          "Open a native folder picker and return the selected path. Call this immediately after the user asks for a local repo (avoid delayed popups if the user is away).",
        args: {
          prompt: tool.schema
            .string()
            .optional()
            .describe("Prompt text shown in the picker dialog"),
        },
        async execute(args) {
          const promptText = args.prompt ?? "Select a repository folder"
          const platform = process.platform

          if (platform === "darwin") {
            const safePrompt = promptText.replace(/"/g, "\\\"")
            const script = `POSIX path of (choose folder with prompt "${safePrompt}")`
            const result = await $`osascript -e ${script}`.text()
            const selected = result.trim()

            if (!selected) {
              return appendDebug(
                "No folder selected.",
                "repo_pick_dir",
                [`platform: ${platform}`],
                debugEnabled
              )
            }

            return appendDebug(
              `## Folder selected\n\n${selected}`,
              "repo_pick_dir",
              [`platform: ${platform}`],
              debugEnabled
            )
          }

          if (platform === "win32") {
            const safePrompt = promptText.replace(/'/g, "''")
            const command = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
              `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;` +
              `$dialog.Description='${safePrompt}';` +
              `if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }`

            const result = await $`powershell -NoProfile -Command ${command}`.text()
            const selected = result.trim()

            if (!selected) {
              return appendDebug(
                "No folder selected.",
                "repo_pick_dir",
                [`platform: ${platform}`],
                debugEnabled
              )
            }

            return appendDebug(
              `## Folder selected\n\n${selected}`,
              "repo_pick_dir",
              [`platform: ${platform}`],
              debugEnabled
            )
          }

          return appendDebug(
            "Folder picker is not supported on this platform.",
            "repo_pick_dir",
            [`platform: ${platform}`],
            debugEnabled
          )
        },
      }),

      repo_query: tool({
        description:
          "Resolve a repository automatically and explore it with a subagent. Accepts local paths or owner/repo. Picks an exact match when possible, otherwise asks you to disambiguate. Can run multiple repos when specified.",
        args: {
          query: tool.schema
            .string()
            .optional()
            .describe(
              "Repository name, owner/repo, or absolute local path. Examples: 'next.js', 'vercel/next.js', '/Users/me/projects/app'"
            ),
          repos: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Explicit repositories to explore (owner/repo or owner/repo@branch)"),
          question: tool.schema
            .string()
            .describe("What you want to understand about the codebase"),
        },
        async execute(args, ctx) {
          const explicitRepos = args.repos?.filter(Boolean) ?? []

          if (explicitRepos.length === 0 && !args.query) {
            return `## Missing repository query

Provide either \`query\` or a non-empty \`repos\` list.`
          }

          const targets: Array<{
            repoKey: string
            branch: string
            source?: RepoSource
            remote?: string
            path?: string
          }> = []

          const debugInfo: RepoQueryDebugInfo = {
            query: args.query ?? explicitRepos.join(", "),
            allowGithub: false,
            localSearchPaths,
            candidates: [],
            selectedTargets: [],
          }

          if (explicitRepos.length > 0) {
            for (const repo of explicitRepos) {
              try {
                const spec = parseRepoSpec(repo)
                targets.push({
                  repoKey: `${spec.owner}/${spec.repo}`,
                  branch: spec.branch || defaultBranch,
                })
                debugInfo.selectedTargets.push({
                  repoKey: `${spec.owner}/${spec.repo}`,
                  branch: spec.branch || defaultBranch,
                })
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error)
                return `## Invalid repository

Failed to parse \`${repo}\`: ${message}`
              }
            }
          } else {
            const localPathResult = await resolveLocalPathQuery(
              args.query!,
              defaultBranch
            )

            if (localPathResult.error) {
              let output = `## Local path error\n\n${localPathResult.error}`
              if (debugEnabled) {
                logRepoQueryDebug(debugInfo)
                output += `\n\n${formatRepoQueryDebug(debugInfo)}`
              }
              return output
            }

            if (localPathResult.candidate) {
              const candidate = localPathResult.candidate
              targets.push({
                repoKey: candidate.key,
                branch: candidate.branch ?? defaultBranch,
                source: candidate.source,
                remote: candidate.remote,
                path: candidate.path,
              })
              debugInfo.candidates = [candidate]
              debugInfo.selectedTargets.push({
                repoKey: candidate.key,
                branch: candidate.branch ?? defaultBranch,
              })
            }

            if (targets.length > 0) {
              for (const target of targets) {
                if (target.source === "local" && target.remote && target.path) {
                  await registerLocalRepo(
                    target.repoKey,
                    target.path,
                    target.branch,
                    target.remote
                  )
                }
              }
            }

            if (targets.length > 0) {
              const results: Array<{ repoKey: string; response: string }> = []

              for (const target of targets) {
                try {
                  const resolved = await ensureRepoAvailable(
                    target.repoKey,
                    target.branch,
                    cacheDir,
                    useHttps,
                    autoSyncOnExplore,
                    autoSyncIntervalHours
                  )

                  await requestExternalDirectoryAccess(
                    ctx as PermissionContext,
                    resolved.repoPath
                  )

                  const response = await runRepoExplorer(
                    client as RepoClient,
                    ctx,
                    target.repoKey,
                    resolved.repoPath,
                    args.question,
                    repoExplorerModel,
                    directory
                  )

                  await touchRepoAccess(target.repoKey)

                  results.push({
                    repoKey: target.repoKey,
                    response,
                  })
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error)
                  results.push({
                    repoKey: target.repoKey,
                    response: `## Exploration failed\n\n${message}`,
                  })
                }
              }

              if (results.length === 1) {
                if (debugEnabled) {
                  logRepoQueryDebug(debugInfo)
                  return `${results[0].response}\n\n${formatRepoQueryDebug(debugInfo)}`
                }
                return results[0].response
              }

              let output = "## Repository Exploration Results\n\n"
              for (const result of results) {
                output += `### ${result.repoKey}\n\n${result.response}\n\n`
              }

              if (debugEnabled) {
                logRepoQueryDebug(debugInfo)
                output += `${formatRepoQueryDebug(debugInfo)}\n`
              }

              return output
            }

            const manifest = await loadManifest()
            let allowGithub = false

            if (args.query?.includes("/")) {
              try {
                parseRepoSpec(args.query)
                allowGithub = true
              } catch {
                allowGithub = false
              }
            }

            debugInfo.allowGithub = allowGithub

            const { candidates, exactRepoKey, branchOverride } = await resolveCandidates(
              args.query!,
              localSearchPaths,
              manifest,
              defaultBranch,
              allowGithub
            )

            debugInfo.candidates = candidates

            if (candidates.length === 0) {
              if (!allowGithub) {
                let output = `## No local repositories matched

No repositories matched \`${args.query}\` in the local registry.

Provide a local path or configure search paths:

- Use \`repo_pick_dir()\` to select a folder (GUI required)
- Or set \`localSearchPaths\` in ~/.config/opencode/opencode-repos.json
- Or pass an explicit repo in \`repos\` (owner/repo)
`
                if (debugEnabled) {
                  logRepoQueryDebug(debugInfo)
                  output += `\n${formatRepoQueryDebug(debugInfo)}`
                }
                return output
              }
              let output = `## No repositories found

No repositories matched \`${args.query}\`.

Try:
- Using owner/repo format for exact matches
- Running \`repo_find({ query: "${args.query}" })\` to see available options`
              if (debugEnabled) {
                logRepoQueryDebug(debugInfo)
                output += `\n${formatRepoQueryDebug(debugInfo)}`
              }
              return output
            }

            if (candidates.length > 1 && !exactRepoKey) {
              let output = `## Multiple repositories matched "${args.query}"

Be more specific or pass an explicit list with \`repos\`.

`
              for (const candidate of candidates) {
                const sourceLabel = candidate.source === "registered" ? "registered" : candidate.source
                const description = candidate.description ? ` - ${candidate.description.slice(0, 80)}` : ""
                output += `- ${candidate.key} (${sourceLabel})${description}\n`
              }

              if (debugEnabled) {
                logRepoQueryDebug(debugInfo)
                output += `\n${formatRepoQueryDebug(debugInfo)}`
              }

              return output
            }

            const selected = candidates[0]
            const branch = branchOverride ?? selected.branch ?? defaultBranch

            targets.push({
              repoKey: selected.key,
              branch,
              source: selected.source,
              remote: selected.remote,
              path: selected.path,
            })

            debugInfo.selectedTargets.push({
              repoKey: selected.key,
              branch,
            })
          }

          for (const target of targets) {
            if (target.source === "local" && target.remote && target.path) {
              await registerLocalRepo(
                target.repoKey,
                target.path,
                target.branch,
                target.remote
              )
            }
          }

          const results: Array<{ repoKey: string; response: string }> = []

          for (const target of targets) {
            try {
              const resolved = await ensureRepoAvailable(
                target.repoKey,
                target.branch,
                cacheDir,
                useHttps,
                autoSyncOnExplore,
                autoSyncIntervalHours
              )

              await requestExternalDirectoryAccess(
                ctx as PermissionContext,
                resolved.repoPath
              )

              const response = await runRepoExplorer(
                client as RepoClient,
                ctx,
                target.repoKey,
                resolved.repoPath,
                args.question,
                repoExplorerModel,
                directory
              )

              await touchRepoAccess(target.repoKey)

              results.push({
                repoKey: target.repoKey,
                response,
              })
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error)
              results.push({
                repoKey: target.repoKey,
                response: `## Exploration failed\n\n${message}`,
              })
            }
          }

          if (results.length === 1) {
            if (debugEnabled) {
              logRepoQueryDebug(debugInfo)
              return `${results[0].response}\n\n${formatRepoQueryDebug(debugInfo)}`
            }
            return results[0].response
          }

          let output = "## Repository Exploration Results\n\n"
          for (const result of results) {
            output += `### ${result.repoKey}\n\n${result.response}\n\n`
          }

          if (debugEnabled) {
            logRepoQueryDebug(debugInfo)
            output += `${formatRepoQueryDebug(debugInfo)}\n`
          }

          return output
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
          const branch = spec.branch || defaultBranch
          const repoKey = `${spec.owner}/${spec.repo}`
          let repoPath: string

          try {
            const resolved = await ensureRepoAvailable(
              repoKey,
              branch,
              cacheDir,
              useHttps,
              autoSyncOnExplore,
              autoSyncIntervalHours
            )
            repoPath = resolved.repoPath
            await requestExternalDirectoryAccess(ctx as PermissionContext, repoPath)
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            const output = `## Failed to prepare repository

Failed to prepare ${args.repo}: ${message}

Please check that the repository exists and you have access to it.`
            return appendDebug(
              output,
              "repo_explore",
              [`repoKey: ${repoKey}`, `branch: ${branch}`],
              debugEnabled
            )
          }

          try {
            const response = await runRepoExplorer(
              client as RepoClient,
              ctx,
              repoKey,
              repoPath,
              args.question,
              repoExplorerModel,
              directory
            )
            await touchRepoAccess(repoKey)
            return appendDebug(
              response,
              "repo_explore",
              [`repoKey: ${repoKey}`, `branch: ${branch}`, `path: ${repoPath}`],
              debugEnabled
            )
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            const output = `## Exploration failed

Failed to spawn exploration agent: ${message}

This may indicate an issue with the OpenCode session or agent registration.`
            return appendDebug(
              output,
              "repo_explore",
              [`repoKey: ${repoKey}`, `branch: ${branch}`],
              debugEnabled
            )
          }
        },
      }),
    },
  }
}

export default OpencodeRepos
