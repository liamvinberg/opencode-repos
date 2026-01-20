import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  parseRepoSpec,
  buildGitUrl,
  cloneRepo,
  updateRepo,
  getRepoInfo,
} from "../git"

describe("parseRepoSpec", () => {
  test("parses owner/repo without branch", () => {
    const result = parseRepoSpec("vercel/next.js")
    expect(result).toEqual({
      owner: "vercel",
      repo: "next.js",
      branch: null,
    })
  })

  test("parses owner/repo@branch", () => {
    const result = parseRepoSpec("vercel/next.js@canary")
    expect(result).toEqual({
      owner: "vercel",
      repo: "next.js",
      branch: "canary",
    })
  })

  test("handles branch with special characters", () => {
    const result = parseRepoSpec("owner/repo@feature/my-branch")
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "feature/my-branch",
    })
  })

  test("throws on missing slash", () => {
    expect(() => parseRepoSpec("invalid")).toThrow(
      'Invalid repo spec: must be in format "owner/repo"'
    )
  })

  test("throws on empty owner", () => {
    expect(() => parseRepoSpec("/repo")).toThrow(
      "Invalid repo spec: owner and repo cannot be empty"
    )
  })

  test("throws on empty repo", () => {
    expect(() => parseRepoSpec("owner/")).toThrow(
      "Invalid repo spec: owner and repo cannot be empty"
    )
  })

  test("throws on empty branch after @", () => {
    expect(() => parseRepoSpec("owner/repo@")).toThrow(
      "Invalid repo spec: branch cannot be empty after @"
    )
  })

  test("throws on repo with extra slash", () => {
    expect(() => parseRepoSpec("owner/repo/extra")).toThrow(
      'Invalid repo spec: repo name cannot contain "/"'
    )
  })
})

describe("buildGitUrl", () => {
  test("builds SSH URL by default", () => {
    const url = buildGitUrl("vercel", "next.js")
    expect(url).toBe("git@github.com:vercel/next.js.git")
  })

  test("builds HTTPS URL when useHttps is true", () => {
    const url = buildGitUrl("vercel", "next.js", true)
    expect(url).toBe("https://github.com/vercel/next.js.git")
  })

  test("handles various owner/repo names", () => {
    expect(buildGitUrl("facebook", "react")).toBe(
      "git@github.com:facebook/react.git"
    )
    expect(buildGitUrl("microsoft", "TypeScript")).toBe(
      "git@github.com:microsoft/TypeScript.git"
    )
  })
})

describe("git operations (integration)", () => {
  const testDir = join(tmpdir(), `opencode-repos-test-${Date.now()}`)
  const repoPath = join(testDir, "test-repo")

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test("cloneRepo clones a public repository", async () => {
    await cloneRepo(
      "https://github.com/octocat/Hello-World.git",
      repoPath,
      { branch: "master" }
    )

    const exists = await Bun.file(join(repoPath, ".git/config")).exists()
    expect(exists).toBe(true)
  })

  test("getRepoInfo returns correct information", async () => {
    const info = await getRepoInfo(repoPath)

    expect(info.remote).toBe("https://github.com/octocat/Hello-World.git")
    expect(info.branch).toBe("master")
    expect(info.commit).toMatch(/^[a-f0-9]{40}$/)
  })

  test("updateRepo fetches and resets", async () => {
    await updateRepo(repoPath)
    const infoAfter = await getRepoInfo(repoPath)

    expect(infoAfter.branch).toBe("master")
    expect(infoAfter.commit).toMatch(/^[a-f0-9]{40}$/)
  })

  test("cloneRepo cleans up on failure", async () => {
    const badPath = join(testDir, "bad-clone")

    try {
      await cloneRepo(
        "https://github.com/nonexistent-user-12345/nonexistent-repo-67890.git",
        badPath
      )
      expect(true).toBe(false)
    } catch {
      const exists = await Bun.file(badPath).exists()
      expect(exists).toBe(false)
    }
  })
})
