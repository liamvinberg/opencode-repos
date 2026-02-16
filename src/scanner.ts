import { $ } from "bun"
import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"

const MAX_SCAN_DEPTH = 4
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build"])

export interface LocalRepoInfo {
  path: string
  remote: string
  branch: string
}

export interface LocalFindResult {
  path: string
  remote: string
  branch: string
  spec: string
}

function isGitMarker(entry: Dirent): boolean {
  return entry.name === ".git" && (entry.isDirectory() || entry.isFile())
}

function shouldScanDirectory(entry: Dirent): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink() && !SKIPPED_DIRECTORIES.has(entry.name)
}

async function findGitRootsInPath(searchPath: string): Promise<string[]> {
  const queue: Array<{ path: string; depth: number }> = [{ path: searchPath, depth: 0 }]
  const roots: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    if (current.depth > MAX_SCAN_DEPTH) {
      continue
    }

    let entries: Dirent[]
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }

    if (entries.some(isGitMarker)) {
      roots.push(current.path)
      continue
    }

    for (const entry of entries) {
      if (!shouldScanDirectory(entry)) {
        continue
      }

      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 })
    }
  }

  return roots
}

async function findGitRoots(searchPaths: string[]): Promise<string[]> {
  const nestedRoots = await Promise.all(searchPaths.map((path) => findGitRootsInPath(path)))
  return nestedRoots.flat()
}

async function readLocalRepoInfo(repoPath: string): Promise<LocalRepoInfo | null> {
  try {
    const [remoteResult, branchResult] = await Promise.all([
      $`git -C ${repoPath} remote get-url origin`.text(),
      $`git -C ${repoPath} branch --show-current`.text(),
    ])

    const remote = remoteResult.trim()
    if (!remote) {
      return null
    }

    return {
      path: repoPath,
      remote,
      branch: branchResult.trim() || "main",
    }
  } catch {
    return null
  }
}

function dedupeByPath(items: LocalRepoInfo[]): LocalRepoInfo[] {
  const seen = new Set<string>()
  const output: LocalRepoInfo[] = []

  for (const item of items) {
    if (seen.has(item.path)) {
      continue
    }
    seen.add(item.path)
    output.push(item)
  }

  return output
}

export async function scanLocalRepos(searchPaths: string[]): Promise<LocalRepoInfo[]> {
  const roots = await findGitRoots(searchPaths)
  const maybeRepos = await Promise.all(roots.map((root) => readLocalRepoInfo(root)))
  return dedupeByPath(maybeRepos.filter((repo): repo is LocalRepoInfo => repo !== null))
}

export function matchRemoteToSpec(remote: string): string | null {
  let normalized = remote.trim().replace(/\.git$/, "").replace(/\/$/, "")

  const patterns = [
    /^git@github\.com:([^/]+\/[^/]+)$/,
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/,
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)$/,
    /^git:\/\/github\.com\/([^/]+\/[^/]+)$/,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match?.[1]) {
      return match[1]
    }
  }

  return null
}

export async function findLocalRepoByName(
  searchPaths: string[],
  query: string
): Promise<LocalFindResult[]> {
  const repos = await scanLocalRepos(searchPaths)
  const queryLower = query.trim().toLowerCase()
  const isOwnerRepoQuery = queryLower.includes("/")

  const results: LocalFindResult[] = []

  for (const repo of repos) {
    const spec = matchRemoteToSpec(repo.remote)
    if (!spec) {
      continue
    }

    const specLower = spec.toLowerCase()
    const dirName = basename(repo.path).toLowerCase()

    const matches = isOwnerRepoQuery
      ? specLower === queryLower || specLower.includes(queryLower)
      : specLower.includes(queryLower) || dirName.includes(queryLower)

    if (!matches) {
      continue
    }

    results.push({
      path: repo.path,
      remote: repo.remote,
      branch: repo.branch,
      spec,
    })
  }

  return results
}
