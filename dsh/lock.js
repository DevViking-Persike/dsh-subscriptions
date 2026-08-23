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
const { lstat, mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
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
 * Whether the lock's owner is provably dead.
 *
 * A lock older than the whole retry deadline settles the question two ways.
 * An EMPTY lock means its owner died between the exclusive create and the pid
 * write — that window is microseconds, so two seconds of emptiness is a
 * corpse. A lock carrying a pid is dead when that pid is gone, which the
 * zero-signal probe reports as ESRCH. A recycled pid still reads as alive, so
 * it falls through to the timeout rather than being stolen.
 *
 * @param {string} lockPath - the lock sibling.
 * @returns {Promise<boolean>}
 */
async function ownerIsDead(lockPath) {
  let text = ''
  try {
    text = (await readFile(lockPath, 'utf8')).trim()
  } catch {
    return false
  }
  if (text.length === 0) return true
  if (!/^\d+$/.test(text)) return false
  const pid = Number(text)
  // Pid 0 and negatives address process groups; never probe them.
  if (pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * Hold the cross-process writer lock around one operation.
 *
 * A contender waits out the retry deadline and fails if the lock is still
 * held; a lock whose owner is provably dead (see {@link ownerIsDead}) is
 * removed and retried once, because a crash must not leave the credential
 * permanently unwritable. File age alone still proves nothing — an occupied
 * lock is never stolen on age.
 *
 * @param {string} filename - the file whose writers this serializes.
 * @param {() => Promise<unknown>} operation - the read-modify-write cycle.
 * @returns {Promise<unknown>} the operation's result; the lock releases either way.
 */
async function withFileLock(filename, operation) {
  const lockPath = `${filename}.lock`
  let recovered = false
  const run = async () => {
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
        // A provably dead owner is removed and retried exactly once; anything
        // less certain still fails, because a live owner must never be stolen.
        if (!recovered && await ownerIsDead(lockPath)) {
          recovered = true
          await rm(lockPath, { force: true })
          return run()
        }
        throw new Error(`dsh-subscriptions: timed out waiting for the writer lock at ${lockPath}`)
      }
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
    }
  }
  // Only a successful acquisition owns the lock: reaching the operation
  // through any failure path must leave another owner's file alone.
  await run()
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}

module.exports = { LOCK_TIMEOUT_MS, ownerIsDead, withFileLock, writeFileAtomic }
