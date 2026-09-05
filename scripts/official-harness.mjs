/** Resolve and validate the official DSH source workspace used for builds. */

import { access, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OFFICIAL_ROOT_NAME = '@deepseek-ai/dsh-root'
export const OFFICIAL_CONNECTION_NAME = '@deepseek-ai/dsh-client-connection'
export const OFFICIAL_WEBSERVER_NAME = '@deepseek-ai/dsh-host-webserver'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const pluginManifestPath = resolve(projectRoot, 'package.json')

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`official harness: ${label} must contain an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {string} path @param {string} label @returns {Promise<Record<string, unknown>>} */
async function readManifest(path, label) {
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`official harness: cannot read ${label} at ${path}: ${reason}`, { cause: error })
  }
  return object(value, label)
}

/** @param {Record<string, unknown>} manifest @param {string} name @param {string} version @param {string} label */
function validateIdentity(manifest, name, version, label) {
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(
      `official harness: ${label} must be ${name}@${version}, received `
      + `${String(manifest.name)}@${String(manifest.version)}`,
    )
  }
}

/** @returns {Promise<string>} */
async function expectedVersion() {
  const manifest = await readManifest(pluginManifestPath, 'plugin manifest')
  const peers = object(manifest.peerDependencies, 'plugin manifest peerDependencies')
  const version = peers[OFFICIAL_CONNECTION_NAME]
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`official harness: plugin peer ${OFFICIAL_CONNECTION_NAME} must be one exact version`)
  }
  return version
}

/**
 * Resolve one package export to a file contained by that package.
 * @param {string} packageDir
 * @param {Record<string, unknown>} manifest
 * @param {string} subpath
 * @param {string} condition
 * @returns {Promise<string>}
 */
async function exportedFile(packageDir, manifest, subpath, condition) {
  const exportsField = object(manifest.exports, `${String(manifest.name)} exports`)
  const entry = exportsField[subpath]
  const target = typeof entry === 'string'
    ? entry
    : object(entry, `${String(manifest.name)} export ${subpath}`)[condition]
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`official harness: ${String(manifest.name)} export ${subpath}.${condition} must be a relative file`)
  }
  const path = resolve(packageDir, target)
  const inside = relative(packageDir, path)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`official harness: ${String(manifest.name)} export ${subpath}.${condition} escapes its package`)
  }
  try {
    await access(path)
  } catch (error) {
    throw new Error(`official harness: exported file does not exist: ${path}`, { cause: error })
  }
  return path
}

/**
 * Validate the source checkout that owns the plugin's runtime peers and generated client input.
 * @param {string | undefined} [input]
 * @returns {Promise<{root: string, version: string, connectionClientPath: string, connectionTypesPath: string}>}
 */
export async function resolveOfficialHarness(input = process.env.DSH_HARNESS_ROOT) {
  const value = input?.trim()
  if (value === undefined || value === '') {
    throw new Error('official harness: DSH_HARNESS_ROOT must name the official deepseek-harness source workspace')
  }
  if (!isAbsolute(value)) {
    throw new Error(`official harness: DSH_HARNESS_ROOT must be absolute, received ${JSON.stringify(value)}`)
  }

  const root = resolve(value)
  const version = await expectedVersion()
  const rootManifest = await readManifest(resolve(root, 'package.json'), 'DSH root manifest')
  validateIdentity(rootManifest, OFFICIAL_ROOT_NAME, version, 'DSH root manifest')

  const connectionDir = resolve(root, 'packages', 'client', 'connection')
  const connectionManifest = await readManifest(resolve(connectionDir, 'package.json'), 'Connection manifest')
  validateIdentity(connectionManifest, OFFICIAL_CONNECTION_NAME, version, 'Connection manifest')

  const webserverDir = resolve(root, 'packages', 'host', 'webserver')
  const webserverManifest = await readManifest(resolve(webserverDir, 'package.json'), 'WebServer manifest')
  validateIdentity(webserverManifest, OFFICIAL_WEBSERVER_NAME, version, 'WebServer manifest')

  return {
    root,
    version,
    connectionClientPath: await exportedFile(connectionDir, connectionManifest, './client', 'default'),
    connectionTypesPath: await exportedFile(connectionDir, connectionManifest, '.', 'types'),
  }
}
