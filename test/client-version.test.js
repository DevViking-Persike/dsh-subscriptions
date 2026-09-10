// Client identity versions: config pin, installed CLI, fallback, and memo.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  FALLBACK_CLAUDE_CODE_VERSION,
  FALLBACK_CODEX_VERSION,
  claudeCodeUserAgent,
  claudeCodeVersionResolver,
  codexUserAgent,
  codexVersionResolver,
  createVersionResolver,
  detectInstalledVersion,
  parseVersionOutput,
  versionOverride,
} = require('../dsh/client-version.js')
const { resolveConfig } = require('../dsh/config.js')

/** A throwaway install tree; returns paths and a cleanup. */
function installTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subscriptions-cli-'))
  return { root, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('a configured version wins and is never probed', () => {
  const config = resolveConfig({ claudeCodeVersion: '9.9.9', codexVersion: '8.8.8' })
  let probes = 0
  const exec = () => { probes += 1; return '1.1.1' }

  assert.deepEqual(claudeCodeVersionResolver(config, { exec, candidates: ['/nope'] })(), { version: '9.9.9', source: 'config' })
  assert.deepEqual(codexVersionResolver(config, { exec, candidates: ['/nope'] })(), { version: '8.8.8', source: 'config' })
  assert.equal(probes, 0)
})

test('a malformed pin fails at load, naming the field', () => {
  assert.throws(() => resolveConfig({ claudeCodeVersion: '2.1' }), /claudeCodeVersion must be a dotted version/)
  assert.throws(() => resolveConfig({ codexVersion: 153 }), /codexVersion must be a dotted version/)
  assert.equal(versionOverride(undefined, 'x'), undefined)
})

test('the Claude native installer layout yields the version from the symlink target', () => {
  const tree = installTree()
  try {
    const versions = join(tree.root, 'share', 'claude', 'versions')
    mkdirSync(versions, { recursive: true })
    mkdirSync(join(tree.root, 'bin'), { recursive: true })
    writeFileSync(join(versions, '2.1.300'), '')
    symlinkSync(join(versions, '2.1.300'), join(tree.root, 'bin', 'claude'))
    const exec = () => { throw new Error('must not probe when the path answers') }

    const found = detectInstalledVersion({ candidates: [join(tree.root, 'bin', 'claude')], exec })

    assert.equal(found.version, '2.1.300')
    assert.match(found.source, /^installed .*versions\/2\.1\.300$/)
  } finally { tree.close() }
})

test('the Codex standalone layout yields the version from the release directory', () => {
  const tree = installTree()
  try {
    const bin = join(tree.root, 'releases', '0.160.2-aarch64-apple-darwin', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'codex'), '')
    mkdirSync(join(tree.root, 'local'), { recursive: true })
    symlinkSync(join(bin, 'codex'), join(tree.root, 'local', 'codex'))

    const found = detectInstalledVersion({ candidates: [join(tree.root, 'local', 'codex')], exec: () => { throw new Error('no') } })

    assert.equal(found.version, '0.160.2')
  } finally { tree.close() }
})

test('an install without the version in its path is probed with --version', () => {
  const tree = installTree()
  try {
    const bin = join(tree.root, 'claude')
    writeFileSync(bin, '')
    const probed = []
    const exec = (path) => { probed.push(path); return '2.1.301 (Claude Code)\n' }

    const found = detectInstalledVersion({ candidates: ['/definitely/missing', bin], exec })

    assert.deepEqual(probed, [bin])
    assert.equal(found.version, '2.1.301')
    assert.match(found.source, /--version$/)
  } finally { tree.close() }
})

test('a failing probe moves on to the next candidate, and none found means undefined', () => {
  const tree = installTree()
  try {
    const first = join(tree.root, 'broken'); writeFileSync(first, '')
    const second = join(tree.root, 'codex'); writeFileSync(second, '')
    const exec = (path) => { if (path === first) throw new Error('EACCES'); return 'codex-cli 0.170.0' }

    assert.equal(detectInstalledVersion({ candidates: [first, second], exec }).version, '0.170.0')
    assert.equal(detectInstalledVersion({ candidates: [first], exec }), undefined)
  } finally { tree.close() }
})

test('without any CLI the last verified version is the fallback', () => {
  const claude = claudeCodeVersionResolver(resolveConfig({}), { candidates: ['/no/claude'] })()
  const codex = codexVersionResolver(resolveConfig({}), { candidates: ['/no/codex'] })()

  assert.deepEqual(claude, { version: FALLBACK_CLAUDE_CODE_VERSION, source: 'fallback' })
  assert.deepEqual(codex, { version: FALLBACK_CODEX_VERSION, source: 'fallback' })
})

test('a detected version is memoized for the ttl, then re-read so an updated CLI is noticed', () => {
  const tree = installTree()
  try {
    const bin = join(tree.root, 'claude'); writeFileSync(bin, '')
    let clock = 0
    let current = '2.1.268'
    let probes = 0
    const exec = () => { probes += 1; return current }
    const resolve = createVersionResolver({ fallback: '0.0.0', candidates: [bin], ttlMs: 1000, now: () => clock, exec })

    assert.equal(resolve().version, '2.1.268')
    clock = 500
    assert.equal(resolve().version, '2.1.268')
    assert.equal(probes, 1)

    current = '2.1.270'
    clock = 1500
    assert.equal(resolve().version, '2.1.270')
    assert.equal(probes, 2)
  } finally { tree.close() }
})

test('user agents carry the resolved version in every slot the CLIs fill', () => {
  assert.equal(claudeCodeUserAgent('2.1.268'), 'claude-cli/2.1.268 (external, sdk-cli)')
  assert.equal(codexUserAgent('0.153.4'), 'codex-tui/0.153.4 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.153.4)')
  assert.equal(parseVersionOutput('codex-cli 0.153.4\n'), '0.153.4')
  assert.equal(parseVersionOutput('garbage'), undefined)
})
