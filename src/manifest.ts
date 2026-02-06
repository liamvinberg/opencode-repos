import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir, rename, unlink, stat, open } from "node:fs/promises"

export interface RepoEntry {
  type: "cached" | "local"
  path: string
  clonedAt?: string
  lastAccessed: string
  lastUpdated?: string
  sizeBytes?: number
  currentBranch: string
  shallow: boolean
}

export interface Manifest {
  version: 1
  repos: Record<string, RepoEntry>
  localIndex: Record<string, string>
}

export interface Config {
  localSearchPaths: string[]
}

let cacheDir = join(homedir(), ".cache", "opencode-repos")
let manifestPath = join(cacheDir, "manifest.json")
let manifestTmpPath = join(cacheDir, "manifest.json.tmp")
let lockPath = join(cacheDir, "manifest.lock")
const LOCK_STALE_MS = 30_000

function createEmptyManifest(): Manifest {
  return {
    version: 1,
    repos: {},
    localIndex: {},
  }
}

export async function loadManifest(): Promise<Manifest> {
  const file = Bun.file(manifestPath)
  const exists = await file.exists()

  if (!exists) {
    return createEmptyManifest()
  }

  try {
    const content = await file.text()
    const parsed = JSON.parse(content) as Manifest
    return parsed
  } catch {
    console.warn("[opencode-repos] Manifest corrupted, returning empty manifest")
    return createEmptyManifest()
  }
}

export async function saveManifest(manifest: Manifest): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  await Bun.write(manifestTmpPath, JSON.stringify(manifest, null, 2))
  await rename(manifestTmpPath, manifestPath)
}

async function isLockStale(): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath)
    const age = Date.now() - lockStat.mtimeMs
    return age > LOCK_STALE_MS
  } catch {
    return true
  }
}

async function acquireLock(): Promise<void> {
  const maxAttempts = 150
  const retryDelayMs = 200

  await mkdir(cacheDir, { recursive: true })

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fd = await open(lockPath, "wx")
      await fd.write(String(process.pid))
      await fd.close()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") {
        throw error
      }
    }

    if (await isLockStale()) {
      await unlink(lockPath).catch(() => {})
      continue
    }

    await Bun.sleep(retryDelayMs)
  }

  await unlink(lockPath).catch(() => {})
  throw new Error("Failed to acquire manifest lock after maximum attempts")
}

async function releaseLock(): Promise<void> {
  await unlink(lockPath).catch(() => {})
}

export async function withManifestLock<T>(
  callback: () => Promise<T>
): Promise<T> {
  await acquireLock()
  try {
    return await callback()
  } finally {
    await releaseLock()
  }
}

export function setCacheDir(path: string): void {
  cacheDir = path
  manifestPath = join(cacheDir, "manifest.json")
  manifestTmpPath = join(cacheDir, "manifest.json.tmp")
  lockPath = join(cacheDir, "manifest.lock")
}
