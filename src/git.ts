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

export function buildGitUrl(owner: string, repo: string): string {
  return `git@github.com:${owner}/${repo}.git`
}

export async function cloneRepo(
  url: string,
  destPath: string,
  options: CloneOptions = {}
): Promise<void> {
  const branch = options.branch || "main"

  try {
    await $`git clone --depth=1 --single-branch --branch ${branch} --config core.hooksPath=/dev/null ${url} ${destPath}`.quiet()
  } catch (error) {
    try {
      await rm(destPath, { recursive: true, force: true })
    } catch {}
    throw error
  }
}

export async function updateRepo(path: string, branch: string = "main"): Promise<void> {
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
