import { $ } from "bun"
import { dirname } from "node:path"

export interface LocalRepoInfo {
  path: string
  remote: string
  branch: string
}

export async function scanLocalRepos(searchPaths: string[]): Promise<LocalRepoInfo[]> {
  const allGitDirs: string[] = []

  const fdResults = await Promise.all(
    searchPaths.map(async (searchPath) => {
      try {
        const result = await $`fd -H -t d '^.git$' --max-depth 4 ${searchPath}`.text()
        return result.split("\n").filter(Boolean)
      } catch {
        return []
      }
    })
  )

  for (const gitDirs of fdResults) {
    allGitDirs.push(...gitDirs)
  }

  const results = await Promise.all(
    allGitDirs.map(async (gitDir) => {
      const repoPath = dirname(gitDir)
      try {
        const [remote, branch] = await Promise.all([
          $`git -C ${repoPath} remote get-url origin`.text(),
          $`git -C ${repoPath} branch --show-current`.text(),
        ])

        if (!remote.trim()) return null

        return {
          path: repoPath,
          remote: remote.trim(),
          branch: branch.trim() || "main",
        }
      } catch {
        return null
      }
    })
  )

  return results.filter((r): r is LocalRepoInfo => r !== null)
}

export function matchRemoteToSpec(remote: string): string | null {
  let normalized = remote.replace(/\.git$/, "")

  const sshMatch = normalized.match(/git@github\.com:(.+)/)
  if (sshMatch) {
    return sshMatch[1]
  }

  const httpsMatch = normalized.match(/https:\/\/github\.com\/(.+)/)
  if (httpsMatch) {
    return httpsMatch[1]
  }

  return null
}

export interface LocalFindResult {
  path: string
  remote: string
  branch: string
  spec: string
}

export async function findLocalRepoByName(
  searchPaths: string[],
  query: string
): Promise<LocalFindResult[]> {
  const queryLower = query.toLowerCase()
  const queryParts = queryLower.split("/")
  const repoName = queryParts.length > 1 ? queryParts[1] : queryParts[0]

  const fdResults = await Promise.all(
    searchPaths.map(async (searchPath) => {
      try {
        const result = await $`fd -H -t d '^.git$' --max-depth 4 ${searchPath}`.text()
        return result.split("\n").filter(Boolean)
      } catch {
        return []
      }
    })
  )

  const allGitDirs = fdResults.flat()

  const candidates = allGitDirs.filter((gitDir) => {
    const repoPath = dirname(gitDir)
    const dirName = repoPath.split("/").pop()?.toLowerCase() || ""
    return dirName.includes(repoName)
  })

  const results = await Promise.all(
    candidates.map(async (gitDir) => {
      const repoPath = dirname(gitDir)
      try {
        const [remote, branch] = await Promise.all([
          $`git -C ${repoPath} remote get-url origin`.text(),
          $`git -C ${repoPath} branch --show-current`.text(),
        ])

        if (!remote.trim()) return null

        const spec = matchRemoteToSpec(remote.trim())
        if (!spec) return null

        if (queryParts.length > 1) {
          const specLower = spec.toLowerCase()
          if (!specLower.includes(queryLower)) return null
        }

        return {
          path: repoPath,
          remote: remote.trim(),
          branch: branch.trim() || "main",
          spec,
        }
      } catch {
        return null
      }
    })
  )

  return results.filter((r): r is LocalFindResult => r !== null)
}
