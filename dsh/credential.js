// The credential document both routes store.
//
// Reading a file is a parser boundary: the document on disk may be truncated,
// hand-edited, or written by an older version, so every field is checked
// before use rather than trusted from a cast.
//
// Every mutation runs inside the writer lock, and a refresh holds it across
// the whole read-check-POST-write cycle. That is what stops a second process
// from burning the refresh token a second time: it blocks, then re-reads and
// finds the token already fresh.

const { readFile, rm, stat } = require('node:fs/promises')
const { SubscriptionError } = require('./errors.js')
const { withFileLock, writeFileAtomic } = require('./lock.js')

/** Refresh this far ahead of expiry, so an in-flight request cannot age out. */
const REFRESH_MARGIN_MS = 300_000

/**
 * Read and validate a credential document.
 *
 * @param {string} filename - the document path.
 * @returns {Promise<object|undefined>} the credential, or undefined when absent.
 */
async function readCredential(filename) {
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw new SubscriptionError(`${filename} is not valid JSON`, 'INVALID_CREDENTIAL')
  }
  const credential = doc === null || typeof doc !== 'object' ? undefined : doc.credential
  if (doc?.version !== 1
    || typeof credential?.access !== 'string'
    || typeof credential.refresh !== 'string'
    || typeof credential.expires !== 'number') {
    throw new SubscriptionError(`${filename} is not a valid credential document`, 'INVALID_CREDENTIAL')
  }
  return {
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    // Labels are tolerant: they are display facts, and a missing one must not
    // invalidate a working token.
    accountId: typeof credential.accountId === 'string' ? credential.accountId : '',
    email: typeof credential.email === 'string' ? credential.email : '',
  }
}

/**
 * Persist a credential atomically with owner-only permissions.
 * @param {string} filename - the document path.
 * @param {object} credential - the credential to store.
 */
async function writeCredential(filename, credential) {
  await writeFileAtomic(
    filename,
    `${JSON.stringify({ version: 1, credential }, null, 2)}\n`,
    { mode: 0o600, dirMode: 0o700 },
  )
}

/** Remove a stored credential; an absent file is already the desired state. */
async function clearCredential(filename) {
  await withFileLock(filename, () => rm(filename, { force: true }))
}

/**
 * Warn when a credential file is readable beyond its owner.
 *
 * A warning rather than a refusal: the token still works, and failing the
 * request would punish the operator for a condition they can only fix outside
 * the plugin.
 *
 * @param {string} filename - the document path.
 * @param {{warn?: (message: string) => void}} log - where to report.
 */
async function warnOnLoosePermissions(filename, log) {
  try {
    const info = await stat(filename)
    if ((info.mode & 0o077) !== 0) {
      log?.warn?.(`dsh-subscriptions: ${filename} is readable beyond its owner; run chmod 600 on it`)
    }
  } catch {
    // Permission reporting is advisory; a stat failure must not break a call
    // whose credential already read successfully.
  }
}

/**
 * Whether a credential needs refreshing before use.
 * @param {object} credential - the stored credential.
 * @param {number} now - current epoch milliseconds.
 * @returns {boolean}
 */
function needsRefresh(credential, now = Date.now()) {
  return credential.expires <= now + REFRESH_MARGIN_MS
}

module.exports = {
  REFRESH_MARGIN_MS,
  clearCredential,
  needsRefresh,
  readCredential,
  warnOnLoosePermissions,
  writeCredential,
}
