// Client identity versions for both subscription routes.
//
// Each backend gates on the version its official CLI sends in the user agent,
// and rejects models newer than that version knows ("Claude Code 2.1.220 does
// not support this model; version 2.1.251 or newer is required"). A version
// pinned in source therefore goes stale the day the vendor ships a model. This
// module reads the version from the CLI installed on the host instead, so
// updating the CLI is the whole upgrade: no plugin change, no restart.
//
// Resolution order, per route: the operator's config override, then the
// installed CLI, then the last version this plugin was verified against. The
// installed CLI is read from its install path first (both vendors keep the
// version in the directory name, which costs one `realpath`), and only when
// that fails by running `<cli> --version` with a short timeout. Results are
// memoized briefly so an auto-updated CLI is noticed without a Host restart
// while a request never pays the probe twice.

const { execFileSync } = require('node:child_process')
const { existsSync, realpathSync } = require('node:fs')
const { homedir } = require('node:os')
const { delimiter, join } = require('node:path')

/** A dotted release version, the only shape either backend accepts. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** Versions the shipped identities were last verified against. */
const FALLBACK_CLAUDE_CODE_VERSION = '2.1.268'
const FALLBACK_CODEX_VERSION = '0.153.4'

/** How long a detected version is trusted before the CLI is probed again. */
const DEFAULT_TTL_MS = 60_000
/** Budget for `<cli> --version`; the install path answers first, so this is rare. */
const PROBE_TIMEOUT_MS = 3_000

/**
 * The install layouts that carry the version in the path: the Claude native
 * installer (`~/.local/share/claude/versions/<v>`) and the Codex standalone
 * package (`~/.codex/packages/standalone/releases/<v>-<triple>/bin/codex`).
 */
const PATH_VERSION = /\/(?:versions|releases)\/(\d+\.\d+\.\d+)(?:[-/]|$)/

/**
 * Validate a configured version override.
 *
 * @param {unknown} value - the raw config value.
 * @param {string} field - the field name, for the error.
 * @returns {string | undefined} the version, or undefined when absent.
 */
function versionOverride(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`dsh-subscriptions: ${field} must be a dotted version like "2.1.268"`)
  }
  return value
}

/**
 * Every place the named CLI may live: each PATH entry, then the user-local bin
 * the vendors' installers use, which a service Host's PATH often lacks.
 *
 * @param {string} name - the executable name.
 * @param {NodeJS.ProcessEnv} env - the environment to read PATH from.
 * @returns {string[]} candidate absolute paths, in lookup order.
 */
function defaultCandidates(name, env = process.env) {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  dirs.push(join(homedir(), '.local', 'bin'))
  return [...new Set(dirs.map(dir => join(dir, name)))]
}

/** Extract the first dotted version from a `--version` line. */
function parseVersionOutput(text) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(text))
  return match?.[1]
}

/**
 * Detect the installed version of one CLI.
 *
 * @param {object} spec
 * @param {string[]} spec.candidates - executable paths to try, in order.
 * @param {(path: string) => string} [spec.realpath] - symlink resolver (injectable).
 * @param {(path: string) => string} [spec.exec] - runs `<path> --version` (injectable).
 * @returns {{ version: string, source: string } | undefined} the version and
 *   where it came from, or undefined when no candidate answered.
 */
function detectInstalledVersion({ candidates, realpath = realpathSync, exec = execVersion }) {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let resolved = candidate
    try {
      resolved = realpath(candidate)
    } catch {
      // A dangling symlink: fall through to the probe, which will fail too.
    }
    const fromPath = PATH_VERSION.exec(resolved)?.[1]
    if (fromPath !== undefined) return { version: fromPath, source: `installed ${resolved}` }
    try {
      const fromProbe = parseVersionOutput(exec(candidate))
      if (fromProbe !== undefined) return { version: fromProbe, source: `installed ${candidate} --version` }
    } catch {
      // Not executable here, or too slow: try the next candidate.
    }
  }
  return undefined
}

/** Run `<path> --version` and return its stdout. */
function execVersion(path) {
  return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * Build a memoized resolver for one route's client version.
 *
 * @param {object} spec
 * @param {string | undefined} spec.override - the operator's configured version.
 * @param {string} spec.fallback - the version used when detection fails.
 * @param {string[]} spec.candidates - executable paths to probe.
 * @param {number} [spec.ttlMs] - memo lifetime for a detected version.
 * @param {() => number} [spec.now] - clock (injectable).
 * @param {(path: string) => string} [spec.realpath] - symlink resolver (injectable).
 * @param {(path: string) => string} [spec.exec] - version probe (injectable).
 * @returns {() => { version: string, source: string }} the resolver.
 */
function createVersionResolver({ override, fallback, candidates, ttlMs = DEFAULT_TTL_MS, now = Date.now, realpath, exec }) {
  if (override !== undefined) {
    const pinned = { version: override, source: 'config' }
    return () => pinned
  }
  let cached
  let cachedAt = -Infinity
  return () => {
    const at = now()
    if (cached !== undefined && at - cachedAt < ttlMs) return cached
    cached = detectInstalledVersion({ candidates, realpath, exec }) ?? { version: fallback, source: 'fallback' }
    cachedAt = at
    return cached
  }
}

/**
 * The Claude Code identity resolver for one resolved config.
 *
 * @param {object} config - the resolved plugin config (`claudeCodeVersion`).
 * @param {object} [deps] - injectable `candidates`, `now`, `realpath`, `exec`, `ttlMs`.
 * @returns {() => { version: string, source: string }}
 */
function claudeCodeVersionResolver(config, deps = {}) {
  return createVersionResolver({
    override: config.claudeCodeVersion,
    fallback: FALLBACK_CLAUDE_CODE_VERSION,
    candidates: deps.candidates ?? defaultCandidates('claude'),
    ...deps,
  })
}

/**
 * The Codex CLI identity resolver for one resolved config.
 *
 * @param {object} config - the resolved plugin config (`codexVersion`).
 * @param {object} [deps] - injectable `candidates`, `now`, `realpath`, `exec`, `ttlMs`.
 * @returns {() => { version: string, source: string }}
 */
function codexVersionResolver(config, deps = {}) {
  return createVersionResolver({
    override: config.codexVersion,
    fallback: FALLBACK_CODEX_VERSION,
    candidates: deps.candidates ?? defaultCandidates('codex'),
    ...deps,
  })
}

/** The user agent Claude Code sends on OAuth requests, for one version. */
function claudeCodeUserAgent(version) {
  return `claude-cli/${version} (external, sdk-cli)`
}

/** The user agent the Codex TUI sends, for one version. */
function codexUserAgent(version) {
  return `codex-tui/${version} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; ${version})`
}

module.exports = {
  FALLBACK_CLAUDE_CODE_VERSION,
  FALLBACK_CODEX_VERSION,
  PATH_VERSION,
  VERSION_PATTERN,
  claudeCodeUserAgent,
  claudeCodeVersionResolver,
  codexUserAgent,
  codexVersionResolver,
  createVersionResolver,
  defaultCandidates,
  detectInstalledVersion,
  parseVersionOutput,
  versionOverride,
}
