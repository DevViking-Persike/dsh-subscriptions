// Where the credential documents live.
//
// The harness resolves its home the same way; reimplemented rather than
// imported so the plugin carries no harness package.

const { homedir } = require('node:os')
const { join, resolve } = require('node:path')

/**
 * Expand a leading `~` against the user's home directory.
 * @param {string} path - a possibly `~`-prefixed path.
 * @returns {string}
 */
function expandHome(path) {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/**
 * The DSH home directory: an explicit value, else `$DSH_HOME`, else `~/.dsh`.
 * @param {string} [configured] - an explicit override.
 * @returns {string} the absolute directory.
 */
function resolveDshHome(configured) {
  const fromEnv = process.env.DSH_HOME
  const chosen = configured ?? (typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
  return resolve(expandHome(chosen))
}

module.exports = { expandHome, resolveDshHome }
