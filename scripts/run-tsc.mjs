/** Run TypeScript against the official unpublished DSH workspace types. */

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OFFICIAL_CONNECTION_NAME, resolveOfficialHarness } from './official-harness.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const temporaryRoot = resolve(tmpdir())
const TEMP_PREFIX = 'dsh-loopback-tsc-'

/** @param {'build' | 'typecheck'} mode @returns {Promise<void>} */
async function run(mode) {
  const harness = await resolveOfficialHarness()
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, TEMP_PREFIX))
  let operationError
  try {
    const baseConfig = resolve(projectRoot, mode === 'build' ? 'tsconfig.build.json' : 'tsconfig.json')
    const temporaryConfig = resolve(temporaryDirectory, 'tsconfig.json')
    await writeFile(temporaryConfig, JSON.stringify({
      extends: baseConfig,
      compilerOptions: {
        paths: {
          [OFFICIAL_CONNECTION_NAME]: [harness.connectionTypesPath],
        },
        typeRoots: [
          resolve(projectRoot, 'node_modules', '@types'),
          resolve(projectRoot, 'node_modules'),
        ],
      },
    }, undefined, 2) + '\n', 'utf8')
    const require = createRequire(import.meta.url)
    const arguments_ = [require.resolve('typescript/bin/tsc'), '-p', temporaryConfig]
    if (mode === 'typecheck') arguments_.push('--noEmit')
    const result = spawnSync(process.execPath, arguments_, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error !== undefined) {
      throw new Error(`TypeScript ${mode}: failed to start: ${String(result.error)}`, { cause: result.error })
    }
    if (result.status !== 0) {
      throw new Error(`TypeScript ${mode}: exited with ${String(result.status ?? result.signal)}`)
    }
  } catch (error) {
    operationError = error
  }

  let cleanupError
  try {
    if (dirname(temporaryDirectory) !== temporaryRoot || !temporaryDirectory.startsWith(join(temporaryRoot, TEMP_PREFIX))) {
      throw new Error(`TypeScript ${mode}: refusing to remove unexpected directory ${temporaryDirectory}`)
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
  } catch (error) {
    cleanupError = error
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([operationError, cleanupError], `TypeScript ${mode} and cleanup both failed`)
  }
  if (operationError !== undefined) throw operationError
  if (cleanupError !== undefined) throw cleanupError
}

const mode = process.argv[2]
if (mode !== 'build' && mode !== 'typecheck') {
  throw new Error(`TypeScript runner: expected build or typecheck, received ${JSON.stringify(mode)}`)
}
await run(mode)
