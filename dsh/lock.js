// Cross-process credential-file protection.
//
// Ported verbatim from the harness's atomic-write utility, including the parts
// that look incidental: they are the protocol, not preferences.
//
// The pairing matters. The lock is a `wx`-created sibling, which is the only
// mutual exclusion that works across processes; the write is a temp file
// renamed into place, which is what keeps readers lock-free. Replace either
// half and a reader can observe a half-written credential.

const { randomBytes } = require('node:crypto')
const { lstat, mkdir, rename, rm, writeFile } = require('node:fs/promises')
const { dirname } = require('node:path')

/**
 * Writer-lock protocol constants. Robustness invariants of the cross-process
 * protocol, not deployment tunables: contention normally resolves inside the
 * deadline, and expiry fails the contender rather than guessing whether the
 * existing lock still has an owner.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const LOCK_TIMEOUT_MS = 2_000

/**
 * Write a file by renaming a fresh sibling into place.
 *
 * The temp file is created `wx` with the final permissions, so replacing a
 * wider-permission file narrows it without a chmod race.
 *
 * @param {string} filename - destination path.
 * @param {string} content - complete file content.
 * @param {{mode?: number, dirMode?: number}} options - permissions.
 */
async function writeFileAtomic(filename, content, options = {}) {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Whether an exclusive create found an existing lock.
 *
 * `EEXIST` is contention directly. `EPERM` is contention only when a fresh
 * `lstat` confirms the path exists — that covers Windows exclusive-create
 * behavior without hiding an unrelated permission failure.
 *
 * @param {unknown} error - the failure from the exclusive create.
 * @param {string} lockPath - the lock sibling.
 * @returns {Promise<boolean>}
 */
async function isLockContention(error, lockPath) {
  const code = error?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/**
 * Hold the cross-process writer lock around one operation.
 *
 * The contender never removes an existing lock: file age cannot prove its
 * owner stopped, so orphan recovery stays an operator action.
 *
 * @param {string} filename - the file whose writers this serializes.
 * @param {() => Promise<unknown>} operation - the read-modify-write cycle.
 * @returns {Promise<unknown>} the operation's result; the lock releases either way.
 */
async function withFileLock(filename, operation) {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(lockPath, `${String(process.pid)}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`dsh-subscriptions: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}

module.exports = { LOCK_TIMEOUT_MS, withFileLock, writeFileAtomic }
