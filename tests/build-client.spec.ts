import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_ID,
  resolveUpstreamClientPath,
  transformClientBundle,
  UPSTREAM_NAME,
  UPSTREAM_VERSION,
  validateUpstreamManifest,
} from '../scripts/build-client.mjs'

interface BundleRegistration {
  id: string
  factory(require: (specifier: string) => unknown): { apply(ctx: unknown): void }
}

interface ConnectionHandle {
  api: unknown
  isLoopback: boolean
}

function materialize(source: string, hostname: string, useInjectedTransport = true): {
  apply(ctx: unknown): void
  api: unknown
  fetchMock: ReturnType<typeof vi.fn>
} {
  let registration: BundleRegistration | undefined
  const api = { source: 'test-transport' }
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    throw new Error('test transport stopped after request capture')
  })
  const sandbox: Record<string, unknown> = {
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    crypto: {
      getRandomValues(array: Uint8Array) {
        return webcrypto.getRandomValues(array)
      },
    },
    EventTarget,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    clearTimeout,
    console,
    fetch: fetchMock,
    location: { hostname, origin: `http://${hostname}`, search: '' },
    queueMicrotask,
    setTimeout,
    window: {
      __ModuleLoader__: {
        load(value: BundleRegistration) { registration = value },
      },
    },
  }
  if (useInjectedTransport) {
    sandbox.__DSH_TRANSPORT__ = {
      createApiClient: () => api,
      fetch: vi.fn(),
    }
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  if (registration === undefined) throw new Error('test bundle did not register')
  const exports = registration.factory((specifier) => {
    throw new Error(`unexpected module-table request: ${specifier}`)
  })
  return { apply: exports.apply, api, fetchMock }
}

function connectionFrom(source: string, hostname: string): ConnectionHandle {
  const plugin = materialize(source, hostname)
  let connection: ConnectionHandle | undefined
  plugin.apply({
    provide(name: string, value: ConnectionHandle) {
      if (name !== 'connection') throw new Error(`unexpected service: ${name}`)
      connection = value
    },
  })
  if (connection === undefined) throw new Error('test plugin did not provide connection')
  expect(connection.api).toBe(plugin.api)
  return connection
}

describe('browser bundle derivation', () => {
  it('rejects unexpected dependency identity', () => {
    expect(() => validateUpstreamManifest({
      name: '@example/not-the-connection',
      version: UPSTREAM_VERSION,
    })).toThrow(`expected upstream name ${UPSTREAM_NAME}`)
    expect(() => validateUpstreamManifest({
      name: UPSTREAM_NAME,
      version: '0.1.1-rc.3',
    })).toThrow(`expected upstream version ${UPSTREAM_VERSION}`)
  })

  it('fails loudly when the generated-code markers drift', () => {
    expect(() => transformClientBundle('window.__ModuleLoader__.load({})'))
      .toThrow('expected exactly one upstream registration id')
  })

  it.each([
    [
      'function randomUuid() {',
      'function driftedRandomUuid() {',
      'insecure-origin-compatible randomUuid definition',
    ],
    [
      'globalThis.crypto.getRandomValues(new Uint8Array(16))',
      'new Uint8Array(16)',
      'randomUuid getRandomValues implementation',
    ],
  ])('rejects upstream drift in the required %s marker', async (marker, replacement, description) => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    expect(() => transformClientBundle(upstream.replace(marker, replacement)))
      .toThrow(`expected exactly one ${description}`)
  })

  it('limits derivation to the declared replacements and source-map footer removal', async () => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    const transformed = transformClientBundle(upstream)
    const normalized = transformed.replace(`\tid: "${CLIENT_ID}",`, `\tid: "${UPSTREAM_NAME}",`)
      .replace('isLoopback: true,', 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),')
      .replace('return RpcId(randomUuid());', 'return RpcId(crypto.randomUUID());')
    expect(normalized).toBe(upstream.replace('\n//# sourceMappingURL=client.js.map', '\n'))
  })

  it('sets remote-hostname connections to loopback and preserves the injected API', async () => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    expect(connectionFrom(upstream, 'dsh.example').isLoopback).toBe(false)
    expect(connectionFrom(transformClientBundle(upstream), 'dsh.example').isLoopback).toBe(true)
    expect(connectionFrom(transformClientBundle(upstream), '192.0.2.23').isLoopback).toBe(true)
  })

  it('mints RPC ids when crypto.randomUUID is unavailable', async () => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    const plugin = materialize(transformClientBundle(upstream), 'dsh.example', false)
    let connection: {
      api: { settings: { describe(payload: unknown): Promise<unknown> } }
    } | undefined
    plugin.apply({
      provide(name: string, value: typeof connection) {
        if (name !== 'connection') throw new Error(`unexpected service: ${name}`)
        connection = value
      },
    })
    if (connection === undefined) throw new Error('test plugin did not provide connection')

    await expect(connection.api.settings.describe({}))
      .rejects.toThrow('test transport stopped after request capture')
    expect(plugin.fetchMock).toHaveBeenCalledOnce()
    const requestInit = plugin.fetchMock.mock.calls[0]?.[1]
    if (requestInit === undefined) throw new Error('test transport did not receive request init')
    const envelope = JSON.parse(String(requestInit.body)) as { rpcId?: unknown }
    expect(envelope.rpcId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
