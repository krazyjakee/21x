import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { electronFrame } from './run.mjs'

it('waits for an authenticated frame and owned close when constructing Windows attestor arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), '21x-proof-pipe-test-'))
  try {
    const executableFixture = join(directory, 'owned-exporter.cjs')
    await writeFile(executableFixture, `
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).once('line', line => {
        const request = JSON.parse(line);
        process.stdout.write('21X_PIPE_ATTEST {"version":1,"privatePipes":true}\\n');
        process.stdout.write('21X_CREDENTIAL_FRAME ' + JSON.stringify({
          token: request.token, ok: true, phase: 'source-export',
          attestorArgument: process.argv[2], observedControl: request.operation
        }) + '\\n');
        setTimeout(() => process.exit(0), 100);
      });
    `)
    const helper = join(directory, 'trusted key helper.exe')
    const started = Date.now()
    const response = await electronFrame(process.execPath, helper, executableFixture, { operation: 'generate' }, 'native', process.env, false, 'win32') as { privatePipeAttested: boolean; attestorArgument: string; observedControl: string }
    expect(response.attestorArgument).toBe('--credential-pipe-attestor=' + resolve(helper))
    expect(response.observedControl).toBe('generate')
    expect(response.privatePipeAttested).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
