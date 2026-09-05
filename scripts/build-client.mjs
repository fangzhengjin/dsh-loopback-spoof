import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OFFICIAL_CONNECTION_NAME, resolveOfficialHarness } from './official-harness.mjs'

export const UPSTREAM_NAME = OFFICIAL_CONNECTION_NAME

const require = createRequire(import.meta.url)
const projectManifest = /** @type {Record<string, unknown>} */ (require('../package.json'))
if (typeof projectManifest.name !== 'string' || projectManifest.name.length === 0) {
  throw new Error('build client bundle: package.json name must be a non-empty string')
}
if (typeof projectManifest.peerDependencies !== 'object' || projectManifest.peerDependencies === null) {
  throw new Error('build client bundle: package.json peerDependencies must contain the official Connection package')
}
const projectPeers = /** @type {Record<string, unknown>} */ (projectManifest.peerDependencies)
if (typeof projectPeers[UPSTREAM_NAME] !== 'string' || projectPeers[UPSTREAM_NAME].length === 0) {
  throw new Error(`build client bundle: package.json peerDependencies must pin ${UPSTREAM_NAME}`)
}

export const CLIENT_ID = projectManifest.name
export const UPSTREAM_VERSION = projectPeers[UPSTREAM_NAME]

const REGISTRATION_ID = `\tid: "${UPSTREAM_NAME}",`
const REPLACEMENT_REGISTRATION_ID = `\tid: ${JSON.stringify(CLIENT_ID)},`
const PROVIDE_MARKER = '\t\t\tctx.provide("connection", handle);'
const APPLY_EXPORT_MARKER = '\t\texports.apply = apply;'
const LOOPBACK_EXPRESSION = 'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'
const LOOPBACK_REPLACEMENT = 'isLoopback: true,'
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
 * Derive this package's browser provider from the pinned upstream artifact.
 * Replace its identity and loopback classification, then remove the stale
 * upstream source-map footer.
 * @param {string} source
 * @returns {string}
 */
export function transformClientBundle(source) {
  assertUnique(source, REGISTRATION_ID, 'upstream registration id')
  assertUnique(source, LOOPBACK_EXPRESSION, 'connection isLoopback expression')
  assertUnique(source, PROVIDE_MARKER, 'connection provider registration')
  assertUnique(source, APPLY_EXPORT_MARKER, 'client apply export')

  const transformed = source
    .replace(REGISTRATION_ID, REPLACEMENT_REGISTRATION_ID)
    .replace(LOOPBACK_EXPRESSION, LOOPBACK_REPLACEMENT)
    .replace(SOURCE_MAP_LINE, '\n')

  assertUnique(transformed, REPLACEMENT_REGISTRATION_ID, 'replacement registration id')
  if (!transformed.includes(LOOPBACK_REPLACEMENT)) {
    throw new Error('build client bundle: constant loopback provider field is missing after transformation')
  }
  if (transformed.includes(LOOPBACK_EXPRESSION)) {
    throw new Error('build client bundle: hostname expression remained after transformation')
  }
  if (transformed.includes('sourceMappingURL=client.js.map')) {
    throw new Error('build client bundle: stale source-map footer remained after transformation')
  }
  return transformed
}

/**
 * Resolve and validate the pinned dependency's browser artifact path.
 * @returns {Promise<string>}
 */
export async function resolveUpstreamClientPath() {
  return (await resolveOfficialHarness()).connectionClientPath
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
