import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICIAL_CONNECTION_NAME,
  OFFICIAL_ROOT_NAME,
  resolveOfficialHarness,
} from '../scripts/official-harness.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('official Harness source validation', () => {
  it('rejects missing and relative source roots', async () => {
    await expect(resolveOfficialHarness('')).rejects.toThrow('DSH_HARNESS_ROOT must name')
    await expect(resolveOfficialHarness('../deepseek-harness')).rejects.toThrow('must be absolute')
  })

  it('rejects a source root with the wrong package identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-loopback-harness-invalid-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: '@example/not-dsh',
      version: '0.1.3-alpha.1',
    }), 'utf8')
    await expect(resolveOfficialHarness(root)).rejects.toThrow(
      `DSH root manifest must be ${OFFICIAL_ROOT_NAME}@0.1.3-alpha.1`,
    )
  })

  it('accepts the configured official source and resolves its built Connection exports', async () => {
    const harness = await resolveOfficialHarness()
    expect(harness.version).toBe('0.1.3-alpha.1')
    expect(harness.connectionClientPath).toContain('client.js')
    expect(harness.connectionTypesPath).toContain('index.d.ts')
    expect(OFFICIAL_CONNECTION_NAME).toBe('@deepseek-ai/dsh-client-connection')
  })
})
