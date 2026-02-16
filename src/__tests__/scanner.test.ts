import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { findLocalRepoByName, matchRemoteToSpec, scanLocalRepos } from "../scanner"

const testRoot = join(tmpdir(), `opencode-repos-scanner-${Date.now()}`)

async function createGitRepo(path: string, remote: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await $`git -C ${path} init -b main`.quiet()
  await $`git -C ${path} remote add origin ${remote}`.quiet()
}

describe("matchRemoteToSpec", () => {
  test("parses SSH remote", () => {
    expect(matchRemoteToSpec("git@github.com:vercel/next.js.git")).toBe("vercel/next.js")
  })

  test("parses HTTPS remote", () => {
    expect(matchRemoteToSpec("https://github.com/vercel/next.js.git")).toBe("vercel/next.js")
  })

  test("parses SSH protocol remote", () => {
    expect(matchRemoteToSpec("ssh://git@github.com/vercel/next.js.git")).toBe("vercel/next.js")
  })

  test("parses git protocol remote", () => {
    expect(matchRemoteToSpec("git://github.com/vercel/next.js.git")).toBe("vercel/next.js")
  })

  test("returns null for unsupported hosts", () => {
    expect(matchRemoteToSpec("https://gitlab.com/vercel/next.js.git")).toBeNull()
  })
})

describe("scanner", () => {
  const repoAPath = join(testRoot, "workspace", "repo-a")
  const repoBPath = join(testRoot, "workspace", "nested", "repo-b")

  beforeEach(async () => {
    await rm(testRoot, { recursive: true, force: true })
    await createGitRepo(repoAPath, "https://github.com/acme/repo-a.git")
    await createGitRepo(repoBPath, "git@github.com:acme/repo-b.git")
  })

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true })
  })

  test("scanLocalRepos discovers repos recursively", async () => {
    const repos = await scanLocalRepos([join(testRoot, "workspace")])
    const paths = repos.map((repo) => repo.path).sort()

    expect(paths).toEqual([repoAPath, repoBPath].sort())
  })

  test("findLocalRepoByName filters by repo name", async () => {
    const results = await findLocalRepoByName([join(testRoot, "workspace")], "repo-b")

    expect(results).toHaveLength(1)
    expect(results[0].spec).toBe("acme/repo-b")
  })

  test("findLocalRepoByName filters by owner/repo", async () => {
    const results = await findLocalRepoByName([join(testRoot, "workspace")], "acme/repo-a")

    expect(results).toHaveLength(1)
    expect(results[0].path).toBe(repoAPath)
  })
})
