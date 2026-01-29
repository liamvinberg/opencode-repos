import { $ } from "bun"
import { rm } from "node:fs/promises"

export interface RepoSpec {
  owner: string
  repo: string
  branch: string | null
}

export interface RepoInfo {
  remote: string
  branch: string
  commit: string
}

export interface CloneOptions {
  branch?: string
}

export function parseRepoSpec(spec: string): RepoSpec {
  const atIndex = spec.indexOf("@")
  let repoPath: string
  let branch: string | null = null

  if (atIndex !== -1) {
    repoPath = spec.slice(0, atIndex)
    branch = spec.slice(atIndex + 1)
    if (!branch) {
      throw new Error(`Invalid repo spec: branch cannot be empty after @`)
    }
  } else {
    repoPath = spec
  }

  const slashIndex = repoPath.indexOf("/")
  if (slashIndex === -1) {
    throw new Error(`Invalid repo spec: must be in format "owner/repo" or "owner/repo@branch"`)
  }

  const owner = repoPath.slice(0, slashIndex)
  const repo = repoPath.slice(slashIndex + 1)

  if (!owner || !repo) {
    throw new Error(`Invalid repo spec: owner and repo cannot be empty`)
  }

  if (repo.includes("/")) {
    throw new Error(`Invalid repo spec: repo name cannot contain "/"`)
  }

  return { owner, repo, branch }
}

export function buildGitUrl(owner: string, repo: string, useHttps: boolean = false): string {
  if (useHttps) {
    return `https://github.com/${owner}/${repo}.git`
  }
  return `git@github.com:${owner}/${repo}.git`
}

export async function getRemoteDefaultBranch(url: string): Promise<string | null> {
  try {
    const output = await $`git ls-remote --symref ${url} HEAD`.text()
    const match = output.match(/ref: refs\/heads\/(\S+)\s+HEAD/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export async function cloneRepo(
  url: string,
  destPath: string,
  options: CloneOptions = {}
): Promise<{ branch: string }> {
  const requestedBranch = options.branch || "main"

  try {
    await $`git clone --depth=1 --branch ${requestedBranch} --config core.hooksPath=/dev/null ${url} ${destPath}`.quiet()
    return { branch: requestedBranch }
  } catch (firstError) {
    try {
      await rm(destPath, { recursive: true, force: true })
    } catch {}

    if (!options.branch) {
      const defaultBranch = await getRemoteDefaultBranch(url)
      if (defaultBranch && defaultBranch !== requestedBranch) {
        try {
          await $`git clone --depth=1 --branch ${defaultBranch} --config core.hooksPath=/dev/null ${url} ${destPath}`.quiet()
          return { branch: defaultBranch }
        } catch (secondError) {
          try {
            await rm(destPath, { recursive: true, force: true })
          } catch {}
          throw secondError
        }
      }
    }

    throw firstError
  }
}

export async function switchBranch(path: string, branch: string): Promise<void> {
  await $`git -C ${path} fetch origin ${branch} --depth=1`.quiet()
  try {
    await $`git -C ${path} checkout ${branch}`.quiet()
  } catch {
    await $`git -C ${path} checkout -b ${branch} origin/${branch}`.quiet()
  }
  await $`git -C ${path} reset --hard origin/${branch}`.quiet()
}

export async function updateRepo(path: string): Promise<void> {
  const currentBranch = await $`git -C ${path} branch --show-current`.text()
  const branch = currentBranch.trim() || "main"
  await $`git -C ${path} fetch origin ${branch} --depth=1`.quiet()
  await $`git -C ${path} reset --hard origin/${branch}`.quiet()
}

export async function getRepoInfo(path: string): Promise<RepoInfo> {
  const remote = await $`git -C ${path} remote get-url origin`.text()
  const branch = await $`git -C ${path} branch --show-current`.text()
  const commit = await $`git -C ${path} rev-parse HEAD`.text()

  return {
    remote: remote.trim(),
    branch: branch.trim(),
    commit: commit.trim(),
  }
}
