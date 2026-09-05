/** Real Profile acceptance for the official Host and patched browser Bundle. */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { resolveOfficialHarness } from '../scripts/official-harness.mjs'

const UPSTREAM_CONNECTION = '@deepseek-ai/dsh-client-connection'
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'
const PLUGIN_NAME = 'dsh-loopback-spoof'
const READY_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^ )\r\n]+)(?: \(LAN: (http:\/\/[^)\r\n]+)\))?\r?\n/
const TEST_API_PATH = '/api/remote.mux'
const TEMP_PREFIX = 'dsh-loopback-combined-'
const PROCESS_OUTPUT_LIMIT = 20_000
const OPERATION_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 10_000

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

/** @returns {string} */
function resolvePluginSource() {
  const input = process.env.DSH_PLUGIN_SOURCE?.trim() ?? ''
  if (input === '') return projectRoot
  if (!isAbsolute(input)) {
    throw new Error(`integration: DSH_PLUGIN_SOURCE must be absolute, got ${JSON.stringify(input)}`)
  }
  const source = resolve(input)
  if (!existsSync(source)) throw new Error(`integration: DSH_PLUGIN_SOURCE does not exist: ${source}`)
  return source
}

/** @typedef {{ root: string, nodeArgs: string[], require: NodeJS.Require }} Harness */
/** @typedef {{ child: ReturnType<typeof spawn>, stdout: string, stderr: string }} Runtime */
/** @typedef {{ localUrl: string, port: number, lanUrl?: string, lanHost?: string, lanPort?: number }} Ready */
/** @typedef {Record<string, unknown> & { id: string, url: string, rev: string }} BootEntry */
/** @typedef {Record<string, unknown> & { phase: 'bootstrap' | 'application', url: string, rev: string, entries: string[] }} BootBatch */
/** @typedef {{ rev: string, entries: BootEntry[], batches: BootBatch[] }} BootGraph */
/** @typedef {{ isLoopback: boolean, rpc: unknown }} ConnectionHandle */

/** @param {string} path @param {string} label @returns {Record<string, unknown>} */
function readJsonObject(path, label) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`integration: failed to read ${label} at ${path}: ${String(error)}`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`integration: ${label} at ${path} must contain a JSON object`)
  }
  return /** @type {Record<string, unknown>} */ (parsed)
}

/** @param {Record<string, unknown>} value @param {string} key @param {string} label @returns {Record<string, unknown>} */
function objectField(value, key, label) {
  const field = value[key]
  if (field === null || typeof field !== 'object' || Array.isArray(field)) {
    throw new Error(`integration: ${label}.${key} must contain an object`)
  }
  return /** @type {Record<string, unknown>} */ (field)
}

/** @returns {Promise<Harness>} */
async function resolveHarness() {
  const official = await resolveOfficialHarness()
  for (const output of ['index.js', 'client.js']) {
    if (!existsSync(join(projectRoot, 'lib', output))) {
      throw new Error(`integration: lib/${output} is missing; run pnpm run build before the integration test`)
    }
  }

  const manifestPath = join(official.root, 'package.json')
  const binPath = join(official.root, 'apps', 'cli', 'src', 'bin.ts')
  const distIndex = join(official.root, 'apps', 'web', 'dist', 'index.html')
  if (!existsSync(binPath) || !existsSync(distIndex)) {
    throw new Error(`integration: official DSH workspace lacks the source CLI or built Web app: ${official.root}`)
  }
  const harnessRequire = createRequire(manifestPath)
  const gatewayManifestPath = join(official.root, 'packages', 'api', 'gateway', 'package.json')
  if (!existsSync(gatewayManifestPath)) {
    throw new Error(`integration: official DSH workspace lacks the API Gateway manifest: ${official.root}`)
  }
  let tsxImport
  try {
    tsxImport = pathToFileURL(harnessRequire.resolve('tsx/esm')).href
  } catch (error) {
    throw new Error(`integration: official DSH workspace cannot resolve tsx/esm: ${String(error)}`, { cause: error })
  }
  return {
    root: official.root,
    nodeArgs: ['--import', tsxImport, binPath],
    require: createRequire(gatewayManifestPath),
  }
}

/** @param {string} dshHome @returns {NodeJS.ProcessEnv} */
function childEnvironment(dshHome) {
  const environment = { ...process.env }
  delete environment.DSH_SESSION_ID
  delete environment.DSH_SHELL
  delete environment.DSH_WEB_URL
  return {
    ...environment,
    DSH_AGENTS_HOME: join(dshHome, 'agents'),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
  }
}

/** @param {Harness} harness @param {string[]} args @returns {string[]} */
function dshNodeArguments(harness, args) {
  return [...harness.nodeArgs, ...args]
}

/** @param {string} value @returns {string} */
function redactLaunchTokens(value) {
  return value.replace(/([?&]token=)[^ )\r\n]+/gu, '$1<redacted>')
}

/** @param {string} stdout @param {string} stderr @returns {string} */
function formatProcessOutput(stdout, stderr) {
  return [
    stdout === '' ? undefined : `stdout:\n${redactLaunchTokens(stdout)}`,
    stderr === '' ? undefined : `stderr:\n${redactLaunchTokens(stderr)}`,
  ].filter(Boolean).join('\n')
}

/**
 * @param {Harness} harness
 * @param {NodeJS.ProcessEnv} environment
 * @param {string[]} args
 * @param {string} operation
 * @returns {string}
 */
function runDsh(harness, environment, args, operation) {
  const result = spawnSync(process.execPath, dshNodeArguments(harness, args), {
    cwd: harness.root,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
    timeout: OPERATION_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error !== undefined) {
    const code = /** @type {{ code?: unknown }} */ (result.error).code
    const message = code === 'ETIMEDOUT'
      ? `integration: ${operation} timed out after ${String(OPERATION_TIMEOUT_MS)}ms`
      : `integration: ${operation} failed to start: ${String(result.error)}`
    throw new Error(message, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(
      `integration: ${operation} exited with ${String(result.status ?? result.signal)}\n`
      + formatProcessOutput(result.stdout, result.stderr),
    )
  }
  return result.stdout
}

/** @param {string} current @param {unknown} chunk @returns {string} */
function appendOutput(current, chunk) {
  if (current.length >= PROCESS_OUTPUT_LIMIT) return current
  return (current + String(chunk)).slice(0, PROCESS_OUTPUT_LIMIT)
}

/** @param {Harness} harness @param {NodeJS.ProcessEnv} environment @param {boolean} [usePatchDefaultHost] @returns {Runtime} */
function startProfile(harness, environment, usePatchDefaultHost = false) {
  const args = ['--profile', 'web', '--no-open', '--port', '0']
  if (!usePatchDefaultHost) args.push('--host', '127.0.0.1')
  const child = spawn(process.execPath, dshNodeArguments(harness, args), {
    cwd: harness.root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const runtime = { child, stdout: '', stderr: '' }
  child.stdout?.on('data', chunk => { runtime.stdout = appendOutput(runtime.stdout, chunk) })
  child.stderr?.on('data', chunk => { runtime.stderr = appendOutput(runtime.stderr, chunk) })
  return runtime
}

/** @param {RegExpExecArray} match @returns {Ready} */
function parseReady(match) {
  const localText = match[1]
  if (localText === undefined) {
    throw new Error('integration: DSH web readiness output omitted the loopback URL')
  }
  let local
  let lan
  try {
    local = new URL(localText)
    lan = match[2] === undefined ? undefined : new URL(match[2])
  } catch (error) {
    throw new Error('integration: DSH web readiness output contains an invalid authenticated URL', { cause: error })
  }
  const launchProof = local.searchParams.get('token')
  const port = Number(local.port)
  if (local.hostname !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1
    || launchProof === null || launchProof === '') {
    throw new Error('integration: DSH web readiness output lacks a valid loopback token URL')
  }
  if (lan === undefined) return { localUrl: local.href, port }
  const lanPort = Number(lan.port)
  if (!Number.isSafeInteger(lanPort) || lanPort < 1 || lan.searchParams.get('token') !== launchProof) {
    throw new Error('integration: DSH web LAN readiness URL must reuse the loopback port token')
  }
  return {
    localUrl: local.href,
    port,
    lanUrl: lan.href,
    lanHost: lan.hostname,
    lanPort,
  }
}

/** @param {Runtime} runtime @returns {Promise<Ready>} */
function waitForReady(runtime) {
  const ready = READY_PATTERN.exec(runtime.stdout)
  if (ready !== null) return Promise.resolve(parseReady(ready))
  return new Promise((resolveReady, rejectReady) => {
    const stdout = runtime.child.stdout
    if (stdout === null) {
      rejectReady(new Error('integration: DSH web profile has no stdout stream'))
      return
    }
    /** @param {() => void} callback */
    const finish = (callback) => {
      clearTimeout(timer)
      stdout.off('data', onData)
      runtime.child.off('error', onError)
      runtime.child.off('exit', onExit)
      callback()
    }
    const onData = () => {
      const match = READY_PATTERN.exec(runtime.stdout)
      if (match !== null) finish(() => resolveReady(parseReady(match)))
    }
    /** @param {Error} error */
    const onError = error => finish(() => rejectReady(new Error(
      `integration: DSH web profile failed to start: ${String(error)}`,
      { cause: error },
    )))
    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    const onExit = (code, signal) => finish(() => rejectReady(new Error(
      `integration: DSH web profile exited before readiness with ${String(code ?? signal)}\n`
      + formatProcessOutput(runtime.stdout, runtime.stderr),
    )))
    const timer = setTimeout(() => finish(() => rejectReady(new Error(
      `integration: DSH web profile did not become ready within ${String(OPERATION_TIMEOUT_MS)}ms\n`
      + formatProcessOutput(runtime.stdout, runtime.stderr),
    ))), OPERATION_TIMEOUT_MS)
    stdout.on('data', onData)
    runtime.child.once('error', onError)
    runtime.child.once('exit', onExit)
    onData()
  })
}

/** @param {Runtime} runtime @param {number} timeoutMs @returns {Promise<void>} */
function waitForExit(runtime, timeoutMs) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit, rejectExit) => {
    /** @param {() => void} callback */
    const finish = (callback) => {
      clearTimeout(timer)
      runtime.child.off('error', onError)
      runtime.child.off('exit', onExit)
      callback()
    }
    /** @param {Error} error */
    const onError = error => finish(() => rejectExit(new Error(
      `integration: DSH web profile shutdown failed: ${String(error)}`,
      { cause: error },
    )))
    const onExit = () => finish(resolveExit)
    const timer = setTimeout(() => finish(() => rejectExit(new Error(
      `integration: DSH web profile did not exit within ${String(timeoutMs)}ms`,
    ))), timeoutMs)
    runtime.child.once('error', onError)
    runtime.child.once('exit', onExit)
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) onExit()
  })
}

/** @param {Runtime} runtime @returns {Promise<void>} */
async function stopProfile(runtime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return
  runtime.child.kill('SIGTERM')
  try {
    await waitForExit(runtime, SHUTDOWN_TIMEOUT_MS)
  } catch (gracefulError) {
    runtime.child.kill('SIGKILL')
    try {
      await waitForExit(runtime, SHUTDOWN_TIMEOUT_MS)
    } catch (forcedError) {
      throw new AggregateError([gracefulError, forcedError], 'integration: failed to stop the DSH web profile')
    }
  }
}

/** @param {number} port @param {string} [connectHost] @returns {Promise<number>} */
function requestFromExternalAuthority(port, connectHost = '127.0.0.1') {
  return new Promise((resolveResponse, rejectResponse) => {
    const authority = `external.invalid:${String(port)}`
    const request = http.request({
      host: connectHost,
      port,
      path: TEST_API_PATH,
      method: 'GET',
      headers: {
        host: authority,
        origin: `http://${authority}`,
        'sec-fetch-site': 'cross-site',
      },
    }, (response) => {
      response.resume()
      response.once('end', () => resolveResponse(response.statusCode ?? 0))
      response.once('error', rejectResponse)
    })
    request.setTimeout(5_000, () => request.destroy(new Error(
      `integration: request to ${TEST_API_PATH} timed out after 5000ms`,
    )))
    request.once('error', rejectResponse)
    request.end()
  })
}

/** @typedef {{ close(): void, once(event: string, listener: (...args: unknown[]) => void): void, terminate(): void }} WebSocketHandle */

/** @param {Harness} harness @returns {Function} */
function webSocketConstructor(harness) {
  let wsModule
  try {
    wsModule = harness.require('ws')
  } catch (error) {
    throw new Error('integration: official DSH workspace cannot resolve ws', { cause: error })
  }
  return /** @type {Function} */ (wsModule.WebSocket ?? wsModule)
}

/** @param {Harness} harness @param {number} port @param {string} [connectHost] @returns {Promise<void>} */
function verifyRejectedWebSocket(harness, port, connectHost = '127.0.0.1') {
  const WebSocketClient = webSocketConstructor(harness)
  const authority = `external.invalid:${String(port)}`

  return new Promise((resolveSocket, rejectSocket) => {
    const socket = /** @type {WebSocketHandle} */ (Reflect.construct(WebSocketClient, [
      `ws://${connectHost}:${String(port)}${TEST_API_PATH}`,
      {
        headers: {
          host: authority,
          origin: `http://${authority}`,
          'sec-fetch-site': 'cross-site',
        },
      },
    ]))
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.terminate()
      rejectSocket(new Error(`integration: WebSocket ${TEST_API_PATH} timed out after 5000ms`))
    }, 5_000)
    /** @param {Error | undefined} error */
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error === undefined) {
        resolveSocket()
      } else {
        socket.terminate()
        rejectSocket(error)
      }
    }
    socket.once('open', () => {
      finish(new Error(`integration: unauthenticated external WebSocket ${TEST_API_PATH} unexpectedly opened`))
    })
    socket.once('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
    socket.once('unexpected-response', (_request, response) => {
      const statusCode = /** @type {{ statusCode?: unknown }} */ (response).statusCode
      if (typeof /** @type {{ resume?: unknown }} */ (response).resume === 'function') {
        /** @type {{ resume(): void }} */ (response).resume()
      }
      finish(statusCode === 403
        ? undefined
        : new Error(`integration: external WebSocket ${TEST_API_PATH} returned HTTP ${String(statusCode ?? 'unknown')}`))
    })
  })
}

/** @param {Harness} harness @param {string} launchUrl @param {string} cookie @returns {Promise<void>} */
function verifyAuthenticatedWebSocket(harness, launchUrl, cookie) {
  const WebSocketClient = webSocketConstructor(harness)
  const target = new URL(TEST_API_PATH, launchUrl)
  target.protocol = 'ws:'
  target.search = ''

  return new Promise((resolveSocket, rejectSocket) => {
    const socket = /** @type {WebSocketHandle} */ (Reflect.construct(WebSocketClient, [target.href, {
      headers: {
        cookie,
        origin: new URL(launchUrl).origin,
      },
    }]))
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.terminate()
      rejectSocket(new Error(`integration: authenticated WebSocket ${TEST_API_PATH} timed out after 5000ms`))
    }, 5_000)
    /** @param {Error | undefined} error */
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error === undefined) {
        socket.close()
        resolveSocket()
      } else {
        socket.terminate()
        rejectSocket(error)
      }
    }
    socket.once('open', () => { finish(undefined) })
    socket.once('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
    socket.once('unexpected-response', (_request, response) => {
      const statusCode = /** @type {{ statusCode?: unknown }} */ (response).statusCode
      finish(new Error(`integration: authenticated WebSocket ${TEST_API_PATH} returned HTTP ${String(statusCode ?? 'unknown')}`))
    })
  })
}

/** @param {string} launchUrl @param {string} [cookie] @returns {Promise<number>} */
async function indexStatus(launchUrl, cookie) {
  const init = cookie === undefined
    ? { redirect: /** @type {const} */ ('manual') }
    : { headers: { cookie }, redirect: /** @type {const} */ ('manual') }
  const response = await fetch(new URL('/', launchUrl), init)
  await response.body?.cancel()
  return response.status
}

/** @param {string} launchUrl @returns {Promise<{ cookie: string, html: string }>} */
async function authenticateIndex(launchUrl) {
  let target
  try {
    target = new URL(launchUrl)
  } catch (error) {
    throw new Error('integration: cannot authenticate an invalid DSH launch URL', { cause: error })
  }
  const launchProof = target.searchParams.get('token')
  if (target.protocol !== 'http:' || target.pathname !== '/'
    || launchProof === null || launchProof === '') {
    throw new Error('integration: DSH launch URL must be an HTTP root URL carrying a token')
  }

  let exchange
  try {
    exchange = await fetch(target, { redirect: 'manual' })
  } catch (error) {
    throw new Error(`integration: token exchange failed for ${target.origin}`, { cause: error })
  }
  if (exchange.status !== 303) {
    await exchange.body?.cancel()
    throw new Error(`integration: token exchange for ${target.origin} returned HTTP ${String(exchange.status)}`)
  }
  const setCookie = exchange.headers.get('set-cookie')
  await exchange.body?.cancel()
  const cookie = setCookie?.split(';', 1)[0]?.trim()
  if (cookie === undefined || cookie === '' || !cookie.includes('=')) {
    throw new Error(`integration: token exchange for ${target.origin} omitted the browser cookie`)
  }

  const index = await fetch(new URL('/', target), {
    headers: { cookie },
    redirect: 'manual',
  })
  if (index.status !== 200) {
    await index.body?.cancel()
    throw new Error(`integration: authenticated index for ${target.origin} returned HTTP ${String(index.status)}`)
  }
  return { cookie, html: await index.text() }
}

/** @param {number} port @param {string} path @returns {Promise<string>} */
async function fetchText(port, path) {
  const response = await fetch(new URL(path, `http://127.0.0.1:${String(port)}`))
  if (!response.ok) throw new Error(`integration: GET ${path} returned HTTP ${String(response.status)}`)
  return response.text()
}

/** @param {string} html @returns {string[]} */
function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1] ?? '')
}

/** @param {string} html @returns {{ queueScript: string, graph: BootGraph }} */
function bootInputs(html) {
  const scripts = inlineScripts(html)
  const queueScript = scripts.find(script => script.includes('window.__ModuleLoader__='))
  if (queueScript === undefined) throw new Error('integration: rendered index lacks the client module-loader facade')
  const assignment = 'globalThis["__DSH_BOOT__"] = '
  const graphScript = scripts.find(script => script.includes(assignment))
  if (graphScript === undefined) throw new Error('integration: rendered index lacks __DSH_BOOT__')
  const serialized = graphScript.slice(graphScript.indexOf(assignment) + assignment.length).trim().replace(/;$/, '')
  const parsed = JSON.parse(serialized)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('integration: __DSH_BOOT__ must contain an object')
  }
  const graph = /** @type {Record<string, unknown>} */ (parsed)
  if (typeof graph.rev !== 'string' || !Array.isArray(graph.entries) || !Array.isArray(graph.batches)) {
    throw new Error('integration: __DSH_BOOT__ must carry string rev, entries, and batches')
  }
  const entries = graph.entries.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('integration: __DSH_BOOT__ entry must contain an object')
    }
    const entry = /** @type {Record<string, unknown>} */ (value)
    if (typeof entry.id !== 'string' || typeof entry.url !== 'string' || typeof entry.rev !== 'string') {
      throw new Error('integration: __DSH_BOOT__ entry must carry string id, url, and rev')
    }
    return /** @type {BootEntry} */ (entry)
  })
  const batches = graph.batches.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('integration: __DSH_BOOT__ batch must contain an object')
    }
    const batch = /** @type {Record<string, unknown>} */ (value)
    if ((batch.phase !== 'bootstrap' && batch.phase !== 'application')
      || typeof batch.url !== 'string' || typeof batch.rev !== 'string'
      || !Array.isArray(batch.entries) || batch.entries.some(id => typeof id !== 'string')) {
      throw new Error('integration: __DSH_BOOT__ batch must carry a valid phase, url, rev, and entries')
    }
    return /** @type {BootBatch} */ (batch)
  })
  return { queueScript, graph: { rev: graph.rev, entries, batches } }
}

/** @param {number} port @param {string} queueScript @param {BootGraph} graph @returns {Promise<void>} */
async function verifyBrowserLoader(port, queueScript, graph) {
  const sandbox = /** @type {Record<string, unknown>} */ ({
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    crypto: {
      /** @param {Uint8Array<ArrayBuffer>} array */
      getRandomValues(array) { return globalThis.crypto.getRandomValues(array) },
    },
    document: { querySelectorAll: () => [] },
    EventTarget,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    clearTimeout,
    console,
    fetch,
    location: { hostname: 'dsh.example', origin: 'http://dsh.example', search: '' },
    queueMicrotask,
    setTimeout,
    structuredClone,
    __DSH_TRANSPORT__: {
      fetch,
    },
  })
  sandbox.window = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(queueScript, context, { filename: 'module-loader-facade.js' })
  const modulesRow = graph.entries.find(entry => entry.id === CLIENT_MODULES_ID)
  if (modulesRow === undefined) throw new Error(`integration: boot graph lacks ${CLIENT_MODULES_ID}`)
  vm.runInContext(await fetchText(port, modulesRow.url), context, { filename: `${CLIENT_MODULES_ID}/client.js` })

  const target = /** @type {{ create?: (options: Record<string, unknown>) => unknown }} */ (sandbox.__ModuleLoader__)
  if (typeof target?.create !== 'function') throw new Error('integration: module-loader facade did not expose create()')
  const modules = /** @type {{ import(specifier: string): Promise<Record<string, unknown>> }} */ (target.create({
    boot: graph,
    staticModules: {},
    /** @param {string} url */
    loadBundle: async (url) => {
      vm.runInContext(await fetchText(port, String(url)), context, { filename: String(url) })
    },
  }))
  const plugin = await modules.import(PLUGIN_NAME)
  if (typeof plugin.apply !== 'function') throw new Error('integration: loaded client Bundle exports no apply()')

  let connection
  plugin.apply({
    /** @param {string} name @param {unknown} value */
    provide(name, value) {
      if (name !== 'connection') throw new Error(`integration: unexpected provided service ${String(name)}`)
      connection = value
    },
  })
  const handle = /** @type {ConnectionHandle | undefined} */ (connection)
  assert.ok(handle !== undefined, 'integration: loaded provider must publish ctx.connection')
  assert.equal(handle.isLoopback, true, 'integration: remote hostname must receive loopback classification')
  assert.ok(handle.rpc !== undefined, 'integration: provider must preserve the official RPC surface')
}

/** @param {string} dshHome @returns {string[]} */
function profileBundles(dshHome) {
  const manifest = readJsonObject(join(dshHome, 'profiles', 'web', 'package.json'), 'generated profile manifest')
  const dsh = objectField(manifest, 'dsh', 'generated profile manifest')
  const profile = objectField(dsh, 'profile', 'generated profile manifest.dsh')
  if (!Array.isArray(profile.bundles) || profile.bundles.some(value => typeof value !== 'string')) {
    throw new Error('integration: generated profile bundles must be a string array')
  }
  return /** @type {string[]} */ (profile.bundles)
}

/** @param {string} dshHome @param {string} dump */
function assertInstalledProfile(dshHome, dump) {
  assert.ok(profileBundles(dshHome).includes(PLUGIN_NAME), 'integration: generated profile must include this Bundle')
  assert.doesNotMatch(dump, /name: dsh-loopback-spoof\/webserver/, 'integration: composed profile must not replace the official WebServer')
  assert.match(dump, /id: webserver[\s\S]*?host: !!js ctx\.webStartup\.host \?\? '0\.0\.0\.0'/, 'integration: official WebServer must receive the declared default 0.0.0.0 bind expression')
  assert.match(dump, /id: webserver[\s\S]*?compression: gzip/, 'integration: official WebServer must retain explicit gzip configuration')
  assert.match(dump, /name: dsh-loopback-spoof(?:\r?\n|$)/, 'integration: composed profile must mount the root Connection')
  assert.match(dump, /name: '@deepseek-ai\/dsh-client-connection'[\s\S]*?disabled: true/, 'integration: stock Connection must be disabled')
}

/** @param {string} dshHome @param {string} dump */
function assertRemovedProfile(dshHome, dump) {
  assert.ok(!profileBundles(dshHome).includes(PLUGIN_NAME), 'integration: generated profile must remove this Bundle')
  assert.doesNotMatch(dump, /name: dsh-loopback-spoof(?:\r?\n|$)/, 'integration: composed profile must remove the replacement Connection')
}

/** @param {string} dshHome @param {string} temporaryRoot */
function validateTemporaryHome(dshHome, temporaryRoot) {
  if (dirname(dshHome) !== temporaryRoot || !basename(dshHome).startsWith(TEMP_PREFIX)) {
    throw new Error(`integration: refusing to remove unexpected directory ${dshHome}`)
  }
}

export async function runProfileIntegration() {
  const harness = await resolveHarness()
  const pluginSource = resolvePluginSource()
  const temporaryRoot = resolve(tmpdir())
  const dshHome = await mkdtemp(join(temporaryRoot, TEMP_PREFIX))
  const environment = childEnvironment(dshHome)
  /** @type {Runtime | undefined} */
  let runtime
  let operationError

  try {
    runDsh(harness, environment, ['--profile', 'web', '--dump-config'], 'stock profile preparation')

    runtime = startProfile(harness, environment)
    let ready = await waitForReady(runtime)
    assert.equal(ready.lanHost, undefined, 'stock DSH with explicit 127.0.0.1 must not announce a LAN listener')
    let port = ready.port
    assert.equal(await requestFromExternalAuthority(port), 403, 'stock DSH must reject the external authority')
    assert.equal(await indexStatus(ready.localUrl), 401, 'stock DSH must reject an unauthenticated index request')
    let authenticated = await authenticateIndex(ready.localUrl)
    let graph = bootInputs(authenticated.html).graph
    assert.ok(graph.entries.some(entry => entry.id === UPSTREAM_CONNECTION), 'stock boot graph must contain the upstream Connection')
    assert.ok(!graph.entries.some(entry => entry.id === PLUGIN_NAME), 'stock boot graph must omit this Bundle')
    await stopProfile(runtime)
    runtime = undefined

    runDsh(harness, environment, ['plugin', '--profile', 'web', 'add', pluginSource], 'combined Bundle installation')
    const installedDump = runDsh(harness, environment, ['--profile', 'web', '--dump-config'], 'installed profile dump')
    assertInstalledProfile(dshHome, installedDump)

    runtime = startProfile(harness, environment, true)
    ready = await waitForReady(runtime)
    assert.ok(ready.lanHost !== undefined && ready.lanUrl !== undefined, 'official WebServer default must announce an authenticated LAN URL')
    assert.equal(ready.lanPort, ready.port, 'LAN listener must use the ready port')
    port = ready.port
    assert.equal(await requestFromExternalAuthority(port, ready.lanHost), 403, 'LAN traffic must preserve the official Host and Origin trust fence')
    assert.equal(await requestFromExternalAuthority(port), 403, 'loopback transport must not bypass the official external-authority fence')
    await verifyRejectedWebSocket(harness, port, ready.lanHost)
    assert.equal(await indexStatus(ready.lanUrl), 401, 'LAN index must reject requests without authentication')
    authenticated = await authenticateIndex(ready.lanUrl)
    assert.equal(await indexStatus(ready.localUrl, authenticated.cookie), 401, 'LAN browser cookie must remain bound to its request authority')
    await verifyAuthenticatedWebSocket(harness, ready.lanUrl, authenticated.cookie)
    const installedBoot = bootInputs(authenticated.html)
    graph = installedBoot.graph
    assert.ok(graph.entries.some(entry => entry.id === PLUGIN_NAME), 'installed boot graph must contain this Bundle')
    assert.ok(!graph.entries.some(entry => entry.id === UPSTREAM_CONNECTION), 'installed boot graph must omit the disabled upstream Connection')
    await verifyBrowserLoader(port, installedBoot.queueScript, graph)
    await stopProfile(runtime)
    runtime = undefined

    runtime = startProfile(harness, environment)
    ready = await waitForReady(runtime)
    assert.equal(ready.lanHost, undefined, 'explicit --host 127.0.0.1 must suppress the official WebServer LAN listener')
    authenticated = await authenticateIndex(ready.localUrl)
    graph = bootInputs(authenticated.html).graph
    assert.ok(graph.entries.some(entry => entry.id === PLUGIN_NAME), 'explicit loopback bind must keep the installed browser Bundle')
    await stopProfile(runtime)
    runtime = undefined

    runDsh(harness, environment, ['plugin', '--profile', 'web', 'remove', PLUGIN_NAME], 'combined Bundle removal')
    const removedDump = runDsh(harness, environment, ['--profile', 'web', '--dump-config'], 'removed profile dump')
    assertRemovedProfile(dshHome, removedDump)

    runtime = startProfile(harness, environment)
    ready = await waitForReady(runtime)
    assert.equal(ready.lanHost, undefined, 'removed profile with explicit 127.0.0.1 must not announce a LAN listener')
    port = ready.port
    assert.equal(await requestFromExternalAuthority(port), 403, 'removal must restore the stock Host trust fence')
    assert.equal(await indexStatus(ready.localUrl), 401, 'removal must preserve stock browser authentication')
    authenticated = await authenticateIndex(ready.localUrl)
    graph = bootInputs(authenticated.html).graph
    assert.ok(graph.entries.some(entry => entry.id === UPSTREAM_CONNECTION), 'removal must restore the upstream browser Connection')
    assert.ok(!graph.entries.some(entry => entry.id === PLUGIN_NAME), 'removal must remove the combined browser module')
    await stopProfile(runtime)
    runtime = undefined

    process.stdout.write('DSH integration passed: the Bundle preserves official authentication and Host trust while switching browser loopback classification and the default LAN bind.\n')
  } catch (error) {
    operationError = error
  }

  const cleanupErrors = []
  if (runtime !== undefined) {
    try {
      await stopProfile(runtime)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    validateTemporaryHome(dshHome, temporaryRoot)
    await rm(dshHome, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], 'integration: verification and cleanup both failed')
  }
  if (operationError !== undefined) throw operationError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'integration: cleanup failed')
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invoked === import.meta.url) {
  try {
    await runProfileIntegration()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
