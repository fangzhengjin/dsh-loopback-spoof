/** Install the actual publish tarball into the real temporary DSH Profile test. */

import { spawnSync } from 'node:child_process'
import { readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProfileIntegration } from './dsh-profile.integration.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const temporaryRoot = resolve(tmpdir())
const TEMP_PREFIX = 'dsh-loopback-tarball-'
const OPERATION_TIMEOUT_MS = 180_000

/** @param {string} command @param {string[]} args @param {string} operation @param {NodeJS.ProcessEnv} [env] */
function run(command, args, operation, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    timeout: OPERATION_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error !== undefined) {
    const code = /** @type {{ code?: unknown }} */ (result.error).code
    const message = code === 'ETIMEDOUT'
      ? `tarball integration: ${operation} timed out after ${String(OPERATION_TIMEOUT_MS)}ms`
      : `tarball integration: ${operation} failed to start: ${String(result.error)}`
    throw new Error(message, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`tarball integration: ${operation} exited with ${String(result.status ?? result.signal)}`)
  }
}

/** @param {string} destination */
function pack(destination) {
  const pnpmCli = process.env.npm_execpath
  if (pnpmCli === undefined || !isAbsolute(pnpmCli)) {
    throw new Error('tarball integration: run this test through pnpm run test:tarball so npm_execpath identifies the pnpm CLI')
  }
  run(process.execPath, [pnpmCli, 'pack', '--pack-destination', destination], 'pnpm pack')
}

async function main() {
  const temporaryDirectory = await mkdtemp(join(temporaryRoot, TEMP_PREFIX))
  let operationError
  try {
    pack(temporaryDirectory)
    const tarballs = (await readdir(temporaryDirectory)).filter(name => name.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`tarball integration: expected one .tgz, found ${String(tarballs.length)}`)
    }
    const tarballName = tarballs[0]
    if (tarballName === undefined) throw new Error('tarball integration: packed tarball name is missing')
    const previousPluginSource = process.env.DSH_PLUGIN_SOURCE
    process.env.DSH_PLUGIN_SOURCE = join(temporaryDirectory, tarballName)
    try {
      await runProfileIntegration()
    } finally {
      if (previousPluginSource === undefined) delete process.env.DSH_PLUGIN_SOURCE
      else process.env.DSH_PLUGIN_SOURCE = previousPluginSource
    }
  } catch (error) {
    operationError = error
  }

  let cleanupError
  try {
    if (dirname(temporaryDirectory) !== temporaryRoot || !basename(temporaryDirectory).startsWith(TEMP_PREFIX)) {
      throw new Error(`tarball integration: refusing to remove unexpected directory ${temporaryDirectory}`)
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
  } catch (error) {
    cleanupError = error
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([operationError, cleanupError], 'tarball integration: verification and cleanup both failed')
  }
  if (operationError !== undefined) throw operationError
  if (cleanupError !== undefined) throw cleanupError
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
