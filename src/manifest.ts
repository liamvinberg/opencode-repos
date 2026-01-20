import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir, rename, unlink, stat } from "node:fs/promises"

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

const CACHE_DIR = join(homedir(), ".cache", "opencode-repos")
const MANIFEST_PATH = join(CACHE_DIR, "manifest.json")
const MANIFEST_TMP_PATH = join(CACHE_DIR, "manifest.json.tmp")
const LOCK_PATH = join(CACHE_DIR, "manifest.lock")
const LOCK_STALE_MS = 5 * 60 * 1000

function createEmptyManifest(): Manifest {
  return {
    version: 1,
    repos: {},
    localIndex: {},
  }
}

export async function loadManifest(): Promise<Manifest> {
  const file = Bun.file(MANIFEST_PATH)
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
  await mkdir(CACHE_DIR, { recursive: true })
  await Bun.write(MANIFEST_TMP_PATH, JSON.stringify(manifest, null, 2))
  await rename(MANIFEST_TMP_PATH, MANIFEST_PATH)
}

async function isLockStale(): Promise<boolean> {
  try {
    const lockStat = await stat(LOCK_PATH)
    const age = Date.now() - lockStat.mtimeMs
    return age > LOCK_STALE_MS
  } catch {
    return true
  }
}

async function acquireLock(): Promise<void> {
  const maxAttempts = 50
  const retryDelayMs = 100

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const lockFile = Bun.file(LOCK_PATH)
    const exists = await lockFile.exists()

    if (exists) {
      if (await isLockStale()) {
        await unlink(LOCK_PATH).catch(() => {})
      } else {
        await Bun.sleep(retryDelayMs)
        continue
      }
    }

    try {
      await mkdir(CACHE_DIR, { recursive: true })
      await Bun.write(LOCK_PATH, String(Date.now()))
      return
    } catch {
      await Bun.sleep(retryDelayMs)
    }
  }

  throw new Error("Failed to acquire manifest lock after maximum attempts")
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_PATH).catch(() => {})
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
