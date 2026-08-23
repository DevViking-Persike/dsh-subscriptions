// The credential lock, proven across real processes.
//
// This is the file that keeps two DSH instances from corrupting a token during
// a concurrent refresh, so it is tested by forking actual processes rather
// than by reasoning about the implementation.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { withFileLock, writeFileAtomic } = require('../dsh/lock.js')

/** A scratch credential file. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  const file = join(dir, 'credential.json')
  writeFileSync(file, `${JSON.stringify({ writers: [] })}\n`, { mode: 0o600 })
  return file
}

/** Run one worker process against the file. */
function worker(file, marker) {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, 'lock-worker.js'), [file, marker], { stdio: 'inherit' })
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${marker} exited ${String(code)}`)))
  })
}

test('two processes writing at once both land, and neither is lost', async () => {
  const file = scratch()

  await Promise.all([worker(file, 'a'), worker(file, 'b')])

  const doc = JSON.parse(readFileSync(file, 'utf8'))
  // Without the lock the second read observes the pre-write state and the
  // first writer's entry disappears.
  assert.equal(doc.writers.length, 2, `expected both writers, got ${JSON.stringify(doc.writers)}`)
  assert.deepEqual([...doc.writers].sort(), ['a', 'b'])
})

test('the file is never observed half written', async () => {
  const file = scratch()
  let malformed = 0
  const reading = setInterval(() => {
    try {
      JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      malformed += 1
    }
  }, 2)

  await Promise.all([worker(file, 'a'), worker(file, 'b')])
  clearInterval(reading)

  // The rename-based commit is what makes readers safe without the lock.
  assert.equal(malformed, 0)
})

test('the lock is released after the operation', async () => {
  const file = scratch()

  await withFileLock(file, () => Promise.resolve())

  assert.equal(existsSync(`${file}.lock`), false)
})

test('the lock is released even when the operation throws', async () => {
  const file = scratch()

  await assert.rejects(withFileLock(file, () => Promise.reject(new Error('boom'))), /boom/)

  assert.equal(existsSync(`${file}.lock`), false)
})

test('a contender times out instead of stealing a foreign lock', async () => {
  const file = scratch()
  writeFileSync(`${file}.lock`, '99999\n', { mode: 0o600 })

  const started = Date.now()
  await assert.rejects(withFileLock(file, () => Promise.resolve()), /timed out waiting for the writer lock/)

  // File age cannot prove the owner died, so the lock stays put.
  assert.ok(Date.now() - started >= 1900, 'should have waited out the deadline')
  assert.equal(existsSync(`${file}.lock`), true)
})

test('an atomic write leaves owner-only permissions', async () => {
  const file = scratch()

  await writeFileAtomic(file, '{"x":1}\n', { mode: 0o600, dirMode: 0o700 })

  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('an atomic write replaces content without leaving a temp file', async () => {
  const file = scratch()

  await writeFileAtomic(file, '{"x":2}\n', { mode: 0o600 })

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { x: 2 })
  assert.equal(existsSync(`${file}.tmp`), false)
})
