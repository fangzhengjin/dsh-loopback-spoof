import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const UPSTREAM_NAME = '@deepseek-ai/dsh-client-connection'

const require = createRequire(import.meta.url)
const projectManifest = /** @type {Record<string, unknown>} */ (require('../package.json'))
if (typeof projectManifest.name !== 'string' || projectManifest.name.length === 0) {
  throw new Error('build client bundle: package.json name must be a non-empty string')
}
if (typeof projectManifest.dependencies !== 'object' || projectManifest.dependencies === null) {
  throw new Error('build client bundle: package.json dependencies must contain the upstream client package')
}
const projectDependencies = /** @type {Record<string, unknown>} */ (projectManifest.dependencies)
if (typeof projectDependencies[UPSTREAM_NAME] !== 'string' || projectDependencies[UPSTREAM_NAME].length === 0) {
  throw new Error(`build client bundle: package.json dependencies must pin ${UPSTREAM_NAME}`)
}

export const CLIENT_ID = projectManifest.name
export const UPSTREAM_VERSION = projectDependencies[UPSTREAM_NAME]

const REGISTRATION_ID = `\tid: "${UPSTREAM_NAME}",`
const REPLACEMENT_REGISTRATION_ID = `\tid: ${JSON.stringify(CLIENT_ID)},`
const PROVIDE_MARKER = '\t\t\tctx.provide("connection", handle);'
const APPLY_EXPORT_MARKER = '\t\texports.apply = apply;'
const LOOPBACK_EXPRESSION = 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'
const LOOPBACK_REPLACEMENT = 'isLoopback: true,'
const RPC_ID_EXPRESSION = 'return RpcId(crypto.randomUUID());'
const RPC_ID_REPLACEMENT = 'return RpcId(randomUuid());'
const RANDOM_UUID_DEFINITION = 'function randomUuid() {'
const RANDOM_VALUES_EXPRESSION = 'globalThis.crypto.getRandomValues(new Uint8Array(16))'
const SOURCE_MAP_LINE = '\n//# sourceMappingURL=client.js.map'

/**
 * Count non-overlapping exact occurrences in a generated artifact.
 * @param {string} source
 * @param {string} needle
 * @returns {number}
 */
function occurrences(source, needle) {
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

/**
 * Require exactly one generated-code marker before transforming the pinned
 * upstream artifact into this package's copy.
 * @param {string} source
 * @param {string} marker
 * @param {string} description
 * @returns {void}
 */
function assertUnique(source, marker, description) {
  const count = occurrences(source, marker)
  if (count !== 1) {
    throw new Error(`build client bundle: expected exactly one ${description}, found ${String(count)}`)
  }
}

/**
 * Validate the installed upstream package identity pinned by this project.
 * Node's resolver remains the single source for the exported browser subpath.
 * @param {unknown} value
 * @returns {void}
 */
export function validateUpstreamManifest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('build client bundle: upstream package.json must contain an object')
  }
  const manifest = /** @type {Record<string, unknown>} */ (value)
  if (manifest.name !== UPSTREAM_NAME) {
    throw new Error(`build client bundle: expected upstream name ${UPSTREAM_NAME}, received ${String(manifest.name)}`)
  }
  if (manifest.version !== UPSTREAM_VERSION) {
    throw new Error(`build client bundle: expected upstream version ${UPSTREAM_VERSION}, received ${String(manifest.version)}`)
  }
}

/**
 * Derive this package's browser provider from the pinned upstream artifact.
 * Replace its identity, loopback classification, and secure-context-only RPC ID call,
 * then remove the stale upstream source-map footer.
 * @param {string} source
 * @returns {string}
 */
export function transformClientBundle(source) {
  assertUnique(source, REGISTRATION_ID, 'upstream registration id')
  assertUnique(source, LOOPBACK_EXPRESSION, 'connection isLoopback hostname expression')
  assertUnique(source, RPC_ID_EXPRESSION, 'secure-context-only API rpcId generator')
  assertUnique(source, RANDOM_UUID_DEFINITION, 'insecure-origin-compatible randomUuid definition')
  assertUnique(source, RANDOM_VALUES_EXPRESSION, 'randomUuid getRandomValues implementation')
  assertUnique(source, PROVIDE_MARKER, 'connection provider registration')
  assertUnique(source, APPLY_EXPORT_MARKER, 'client apply export')

  const transformed = source
    .replace(REGISTRATION_ID, REPLACEMENT_REGISTRATION_ID)
    .replace(LOOPBACK_EXPRESSION, LOOPBACK_REPLACEMENT)
    .replace(RPC_ID_EXPRESSION, RPC_ID_REPLACEMENT)
    .replace(SOURCE_MAP_LINE, '\n')

  assertUnique(transformed, REPLACEMENT_REGISTRATION_ID, 'replacement registration id')
  if (!transformed.includes(LOOPBACK_REPLACEMENT)) {
    throw new Error('build client bundle: constant loopback provider field is missing after transformation')
  }
  assertUnique(transformed, RPC_ID_REPLACEMENT, 'insecure-origin-compatible API rpcId generator')
  if (transformed.includes(LOOPBACK_EXPRESSION)) {
    throw new Error('build client bundle: hostname expression remained after transformation')
  }
  if (transformed.includes('sourceMappingURL=client.js.map')) {
    throw new Error('build client bundle: stale source-map footer remained after transformation')
  }
  if (transformed.includes(RPC_ID_EXPRESSION)) {
    throw new Error('build client bundle: secure-context-only API rpcId generator remained after transformation')
  }
  return transformed
}

/**
 * Resolve and validate the pinned dependency's browser artifact path.
 * @returns {Promise<string>}
 */
export async function resolveUpstreamClientPath() {
  const manifestPath = require.resolve(`${UPSTREAM_NAME}/package.json`)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`build client bundle: cannot read upstream package.json: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  validateUpstreamManifest(manifest)
  try {
    return require.resolve(`${UPSTREAM_NAME}/client`)
  } catch (error) {
    throw new Error(`build client bundle: cannot resolve ${UPSTREAM_NAME}/client through Node package exports: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/**
 * Build `lib/client.js` through a checked temporary file before replacing the output.
 * @returns {Promise<string>}
 */
export async function buildClientBundle() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outputDir = resolve(projectRoot, 'lib')
  const outputPath = resolve(outputDir, 'client.js')
  const temporaryPath = resolve(outputDir, `.client.${String(process.pid)}.tmp`)
  const clientPath = await resolveUpstreamClientPath()
  let source
  try {
    source = await readFile(clientPath, 'utf8')
  } catch (error) {
    throw new Error(`build client bundle: cannot read ${clientPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const transformed = transformClientBundle(source)
  await mkdir(outputDir, { recursive: true })
  try {
    await writeFile(temporaryPath, transformed, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, outputPath)
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true })
    } catch (cleanupError) {
      const writeReason = error instanceof Error ? error.message : String(error)
      const cleanupReason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      throw new AggregateError(
        [error, cleanupError],
        `build client bundle: cannot write ${outputPath}: ${writeReason}; cannot remove ${temporaryPath}: ${cleanupReason}`,
      )
    }
    throw new Error(`build client bundle: cannot write ${outputPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return outputPath
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invoked === import.meta.url) {
  buildClientBundle().then(
    output => { console.log(`built ${output}`) },
    error => {
      console.error(error)
      process.exitCode = 1
    },
  )
}
