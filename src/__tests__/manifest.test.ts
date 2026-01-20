import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { loadManifest, saveManifest, withManifestLock, type Manifest } from "../manifest"

const originalCacheDir = join(homedir(), ".cache", "opencode-repos")

describe("loadManifest", () => {
  beforeEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  test("creates empty manifest if file does not exist", async () => {
    const manifest = await loadManifest()

    expect(manifest).toEqual({
      version: 1,
      repos: {},
      localIndex: {},
    })
  })

  test("returns existing manifest when file exists", async () => {
    await mkdir(originalCacheDir, { recursive: true })

    const existingManifest: Manifest = {
      version: 1,
      repos: {
        "owner/repo@main": {
          type: "cached",
          path: "/some/path",
          lastAccessed: "2024-01-01T00:00:00.000Z",
          defaultBranch: "main",
          shallow: true,
        },
      },
      localIndex: {
        "https://github.com/owner/repo.git": "/local/path",
      },
    }

    await Bun.write(
      join(originalCacheDir, "manifest.json"),
      JSON.stringify(existingManifest, null, 2)
    )

    const manifest = await loadManifest()

    expect(manifest).toEqual(existingManifest)
  })

  test("handles corrupted JSON gracefully", async () => {
    await mkdir(originalCacheDir, { recursive: true })
    await Bun.write(join(originalCacheDir, "manifest.json"), "{ invalid json }")

    const manifest = await loadManifest()

    expect(manifest).toEqual({
      version: 1,
      repos: {},
      localIndex: {},
    })
  })
})

describe("saveManifest", () => {
  beforeEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  test("creates directory if it does not exist", async () => {
    const manifest: Manifest = {
      version: 1,
      repos: {},
      localIndex: {},
    }

    await saveManifest(manifest)

    const file = Bun.file(join(originalCacheDir, "manifest.json"))
    expect(await file.exists()).toBe(true)
  })

  test("writes manifest atomically using tmp file", async () => {
    const manifest: Manifest = {
      version: 1,
      repos: {
        "test/repo@main": {
          type: "cached",
          path: "/test/path",
          lastAccessed: "2024-01-01T00:00:00.000Z",
          defaultBranch: "main",
          shallow: false,
        },
      },
      localIndex: {},
    }

    await saveManifest(manifest)

    const savedContent = await Bun.file(join(originalCacheDir, "manifest.json")).text()
    const savedManifest = JSON.parse(savedContent)

    expect(savedManifest).toEqual(manifest)

    const tmpFile = Bun.file(join(originalCacheDir, "manifest.json.tmp"))
    expect(await tmpFile.exists()).toBe(false)
  })

  test("overwrites existing manifest", async () => {
    const manifest1: Manifest = {
      version: 1,
      repos: { "first/repo@main": { type: "cached", path: "/first", lastAccessed: "2024-01-01T00:00:00.000Z", defaultBranch: "main", shallow: true } },
      localIndex: {},
    }

    const manifest2: Manifest = {
      version: 1,
      repos: { "second/repo@main": { type: "local", path: "/second", lastAccessed: "2024-02-01T00:00:00.000Z", defaultBranch: "main", shallow: false } },
      localIndex: { "url": "/path" },
    }

    await saveManifest(manifest1)
    await saveManifest(manifest2)

    const savedContent = await Bun.file(join(originalCacheDir, "manifest.json")).text()
    const savedManifest = JSON.parse(savedContent)

    expect(savedManifest).toEqual(manifest2)
  })
})

describe("withManifestLock", () => {
  beforeEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  test("executes callback and returns result", async () => {
    const result = await withManifestLock(async () => {
      return "test-result"
    })

    expect(result).toBe("test-result")
  })

  test("releases lock after callback completes", async () => {
    await withManifestLock(async () => {
      return "done"
    })

    const lockFile = Bun.file(join(originalCacheDir, "manifest.lock"))
    expect(await lockFile.exists()).toBe(false)
  })

  test("releases lock even if callback throws", async () => {
    try {
      await withManifestLock(async () => {
        throw new Error("test error")
      })
    } catch {
      // expected
    }

    const lockFile = Bun.file(join(originalCacheDir, "manifest.lock"))
    expect(await lockFile.exists()).toBe(false)
  })

  test("prevents concurrent access", async () => {
    const results: number[] = []

    const task1 = withManifestLock(async () => {
      results.push(1)
      await Bun.sleep(50)
      results.push(2)
      return "task1"
    })

    await Bun.sleep(10)

    const task2 = withManifestLock(async () => {
      results.push(3)
      return "task2"
    })

    await Promise.all([task1, task2])

    expect(results).toEqual([1, 2, 3])
  })

  test("handles stale lock by removing it", async () => {
    await mkdir(originalCacheDir, { recursive: true })

    const staleTime = Date.now() - (6 * 60 * 1000)
    await Bun.write(join(originalCacheDir, "manifest.lock"), String(staleTime))

const { utimes } = await import("node:fs/promises")
    const staleDate = new Date(staleTime)
    await utimes(join(originalCacheDir, "manifest.lock"), staleDate, staleDate)

    const result = await withManifestLock(async () => {
      return "acquired-after-stale"
    })

    expect(result).toBe("acquired-after-stale")
  })
})

describe("integration", () => {
  beforeEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(originalCacheDir, { recursive: true, force: true })
  })

  test("load, modify, and save manifest with lock", async () => {
    await withManifestLock(async () => {
      const manifest = await loadManifest()

      manifest.repos["new/repo@main"] = {
        type: "cached",
        path: "/new/path",
        lastAccessed: new Date().toISOString(),
        defaultBranch: "main",
        shallow: true,
      }

      await saveManifest(manifest)
    })

    const loaded = await loadManifest()
    expect(loaded.repos["new/repo@main"]).toBeDefined()
    expect(loaded.repos["new/repo@main"].type).toBe("cached")
  })
})
