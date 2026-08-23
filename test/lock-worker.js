// One worker in the cross-process lock test: refresh-like read-modify-write.
const { withFileLock, writeFileAtomic } = require('../dsh/lock.js')
const { readFile } = require('node:fs/promises')

const [, , file, marker] = process.argv
void withFileLock(file, async () => {
  const before = JSON.parse(await readFile(file, 'utf8'))
  // A deliberate gap: without the lock this is where the two writers interleave.
  await new Promise(r => setTimeout(r, 120))
  await writeFileAtomic(
    file,
    `${JSON.stringify({ writers: [...before.writers, marker] }, null, 2)}\n`,
    { mode: 0o600, dirMode: 0o700 },
  )
}).then(() => process.exit(0), (error) => { console.error(String(error)); process.exit(1) })
