import { open, rename, stat, unlink, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface RepoEntry {
  type: "cached" | "local"
  path: string
  currentBranch: string
  lastAccessed: string
  clonedAt?: string
  lastUpdated?: string
  sizeBytes?: number
  shallow?: boolean
  remote?: string
}

export interface Manifest {
  version: 1
  repos: Record<string, RepoEntry>
  localIndex: Record<string, string>
}

let cacheDir = join(homedir(), ".cache", "opencode-repos")
let manifestPath = join(cacheDir, "manifest.json")
let manifestTmpPath = join(cacheDir, "manifest.json.tmp")
let lockPath = join(cacheDir, "manifest.lock")

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_DELAY_MS = 100
const LOCK_MAX_ATTEMPTS = 300

function createEmptyManifest(): Manifest {
  return {
    version: 1,
    repos: {},
    localIndex: {},
  }
}

function normalizeRepoEntry(value: unknown): RepoEntry | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const raw = value as Record<string, unknown>
  const type = raw.type
  const path = raw.path
  const currentBranch = raw.currentBranch
  const lastAccessed = raw.lastAccessed

  if ((type !== "cached" && type !== "local") || typeof path !== "string") {
    return null
  }

  return {
    type,
    path,
    currentBranch: typeof currentBranch === "string" && currentBranch ? currentBranch : "main",
    lastAccessed:
      typeof lastAccessed === "string" && lastAccessed ? lastAccessed : new Date().toISOString(),
    clonedAt: typeof raw.clonedAt === "string" ? raw.clonedAt : undefined,
    lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : undefined,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : undefined,
    shallow: typeof raw.shallow === "boolean" ? raw.shallow : undefined,
    remote: typeof raw.remote === "string" ? raw.remote : undefined,
  }
}

function normalizeManifest(value: unknown): Manifest {
  const empty = createEmptyManifest()
  if (!value || typeof value !== "object") {
    return empty
  }

  const raw = value as Record<string, unknown>
  const reposValue = raw.repos
  const localIndexValue = raw.localIndex

  const repos: Record<string, RepoEntry> = {}
  if (reposValue && typeof reposValue === "object") {
    for (const [key, entryValue] of Object.entries(reposValue as Record<string, unknown>)) {
      const entry = normalizeRepoEntry(entryValue)
      if (entry) {
        repos[key] = entry
      }
    }
  }

  const localIndex: Record<string, string> = {}
  if (localIndexValue && typeof localIndexValue === "object") {
    for (const [remote, path] of Object.entries(localIndexValue as Record<string, unknown>)) {
      if (typeof path === "string") {
        localIndex[remote] = path
      }
    }
  }

  return {
    version: 1,
    repos,
    localIndex,
  }
}

export async function loadManifest(): Promise<Manifest> {
  const file = Bun.file(manifestPath)
  if (!(await file.exists())) {
    return createEmptyManifest()
  }

  try {
    const content = await file.text()
    return normalizeManifest(JSON.parse(content))
  } catch {
    return createEmptyManifest()
  }
}

export async function saveManifest(manifest: Manifest): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const normalized = normalizeManifest(manifest)
  await Bun.write(manifestTmpPath, JSON.stringify(normalized, null, 2))
  await rename(manifestTmpPath, manifestPath)
}

async function isLockStale(): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath)
    return Date.now() - lockStat.mtimeMs > LOCK_STALE_MS
  } catch {
    return true
  }
}

async function acquireLock(): Promise<void> {
  await mkdir(cacheDir, { recursive: true })

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = await open(lockPath, "wx")
      await fd.write(`${process.pid}`)
      await fd.close()
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") {
        throw error
      }
    }

    if (await isLockStale()) {
      await unlink(lockPath).catch(() => undefined)
      continue
    }

    await Bun.sleep(LOCK_RETRY_DELAY_MS)
  }

  await unlink(lockPath).catch(() => undefined)
  throw new Error("Failed to acquire manifest lock")
}

async function releaseLock(): Promise<void> {
  await unlink(lockPath).catch(() => undefined)
}

export async function withManifestLock<T>(callback: () => Promise<T>): Promise<T> {
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
