import { $ } from "bun"
import { dirname } from "node:path"

export interface LocalRepoInfo {
  path: string
  remote: string
  branch: string
}

export async function scanLocalRepos(searchPaths: string[]): Promise<LocalRepoInfo[]> {
  const repos: LocalRepoInfo[] = []

  for (const searchPath of searchPaths) {
    try {
      const result = await $`fd -H -t d '^.git$' --max-depth 4 ${searchPath}`.text()
      const gitDirs = result.split("\n").filter(Boolean)

      for (const gitDir of gitDirs) {
        const repoPath = dirname(gitDir)

        try {
          const remote = await $`git -C ${repoPath} remote get-url origin`.text()
          if (!remote.trim()) continue

          const branch = await $`git -C ${repoPath} branch --show-current`.text()

          repos.push({
            path: repoPath,
            remote: remote.trim(),
            branch: branch.trim() || "main",
          })
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }

  return repos
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
