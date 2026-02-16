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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const result: string[] = []
  for (const value of values) {
    if (!value) continue
    if (!result.includes(value)) {
      result.push(value)
    }
  }
  return result
}

async function cleanupClonePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined)
}

async function cloneWithBranch(url: string, destPath: string, branch: string): Promise<void> {
  await $`git clone --depth=1 --single-branch --branch ${branch} --config core.hooksPath=/dev/null ${url} ${destPath}`.quiet()
}

async function cloneDefault(url: string, destPath: string): Promise<string> {
  await $`git clone --depth=1 --single-branch --config core.hooksPath=/dev/null ${url} ${destPath}`.quiet()
  const checkedOutBranch = (await $`git -C ${destPath} branch --show-current`.text()).trim()
  return checkedOutBranch || "main"
}

export function parseRepoSpec(spec: string): RepoSpec {
  const trimmed = spec.trim()
  const atIndex = trimmed.indexOf("@")
  const repoPath = atIndex === -1 ? trimmed : trimmed.slice(0, atIndex)
  const branch = atIndex === -1 ? null : trimmed.slice(atIndex + 1)

  if (atIndex !== -1 && !branch) {
    throw new Error("Invalid repo spec: branch cannot be empty after @")
  }

  const slashIndex = repoPath.indexOf("/")
  if (slashIndex === -1) {
    throw new Error("Invalid repo spec: must be in format \"owner/repo\" or \"owner/repo@branch\"")
  }

  const owner = repoPath.slice(0, slashIndex)
  const repo = repoPath.slice(slashIndex + 1)

  if (!owner || !repo) {
    throw new Error("Invalid repo spec: owner and repo cannot be empty")
  }

  if (repo.includes("/")) {
    throw new Error("Invalid repo spec: repo name cannot contain \"/\"")
  }

  return { owner, repo, branch }
}

export function buildGitUrl(owner: string, repo: string, useHttps: boolean = false): string {
  if (useHttps) {
    return `https://github.com/${owner}/${repo}.git`
  }
  return `git@github.com:${owner}/${repo}.git`
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const output = await $`git -C ${path} rev-parse --is-inside-work-tree`.text()
    return output.trim() === "true"
  } catch {
    return false
  }
}

export async function getRepoRemote(path: string): Promise<string | null> {
  try {
    const output = await $`git -C ${path} remote get-url origin`.text()
    const remote = output.trim()
    return remote || null
  } catch {
    return null
  }
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
  const requestedBranch = options.branch

  if (requestedBranch) {
    await cleanupClonePath(destPath)
    try {
      await cloneWithBranch(url, destPath, requestedBranch)
      return { branch: requestedBranch }
    } catch (error) {
      await cleanupClonePath(destPath)
      throw new Error(`Clone failed for branch \"${requestedBranch}\": ${getErrorMessage(error)}`)
    }
  }

  const remoteDefault = await getRemoteDefaultBranch(url)
  const branchCandidates = uniqueValues([remoteDefault, "main", "master"])
  const attemptErrors: string[] = []

  for (const branchCandidate of branchCandidates) {
    await cleanupClonePath(destPath)
    try {
      await cloneWithBranch(url, destPath, branchCandidate)
      return { branch: branchCandidate }
    } catch (error) {
      attemptErrors.push(`${branchCandidate}: ${getErrorMessage(error)}`)
    }
  }

  await cleanupClonePath(destPath)
  try {
    const branch = await cloneDefault(url, destPath)
    return { branch }
  } catch (error) {
    await cleanupClonePath(destPath)
    const details = attemptErrors.join(" | ")
    if (details) {
      throw new Error(`Clone failed after branch fallbacks (${details}). Final error: ${getErrorMessage(error)}`)
    }
    throw new Error(`Clone failed: ${getErrorMessage(error)}`)
  }
}

export async function switchBranch(path: string, branch: string): Promise<void> {
  await $`git -C ${path} fetch --depth=1 origin ${branch}`.quiet()

  try {
    await $`git -C ${path} checkout ${branch}`.quiet()
  } catch {
    await $`git -C ${path} checkout -B ${branch} origin/${branch}`.quiet()
  }

  await $`git -C ${path} reset --hard origin/${branch}`.quiet()
}

export async function updateRepo(path: string): Promise<void> {
  const currentBranch = (await $`git -C ${path} branch --show-current`.text()).trim()
  const branch = currentBranch || "main"
  await switchBranch(path, branch)
}

export async function getRepoInfo(path: string): Promise<RepoInfo> {
  const [remote, branch, commit] = await Promise.all([
    $`git -C ${path} remote get-url origin`.text(),
    $`git -C ${path} branch --show-current`.text(),
    $`git -C ${path} rev-parse HEAD`.text(),
  ])

  return {
    remote: remote.trim(),
    branch: branch.trim(),
    commit: commit.trim(),
  }
}
