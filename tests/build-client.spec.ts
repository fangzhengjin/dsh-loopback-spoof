import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_ID,
  resolveUpstreamClientPath,
  transformClientBundle,
  UPSTREAM_NAME,
} from '../scripts/build-client.mjs'

interface BundleRegistration {
  id: string
  factory(require: (specifier: string) => unknown): { apply(ctx: unknown): void }
}

interface ConnectionHandle {
  isLoopback: boolean
  rpc: unknown
}

function materialize(source: string, hostname: string, ownsHost = false): {
  apply(ctx: unknown): void
} {
  let registration: BundleRegistration | undefined
  const sandbox: Record<string, unknown> = {
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    crypto: {
      getRandomValues(array: Uint8Array<ArrayBuffer>) {
        return globalThis.crypto.getRandomValues(array)
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
    fetch: vi.fn(),
    location: { hostname, origin: `http://${hostname}`, search: '' },
    queueMicrotask,
    setTimeout,
    window: {
      __ModuleLoader__: {
        load(value: BundleRegistration) { registration = value },
      },
    },
    __DSH_TRANSPORT__: {
      fetch: vi.fn(),
      ownsHost,
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  if (registration === undefined) throw new Error('test bundle did not register')
  const exports = registration.factory((specifier) => {
    throw new Error(`unexpected module-table request: ${specifier}`)
  })
  return { apply: exports.apply }
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
  expect(connection.rpc).toBeDefined()
  return connection
}

describe('browser bundle derivation', () => {
  it('fails loudly when the generated-code markers drift', () => {
    expect(() => transformClientBundle('window.__ModuleLoader__.load({})'))
      .toThrow('expected exactly one upstream registration id')
  })

  it('rejects upstream drift in the loopback marker', async () => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    const marker = 'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'
    expect(() => transformClientBundle(upstream.replace(marker, 'isLoopback: false,')))
      .toThrow('expected exactly one connection isLoopback expression')
  })

  it('limits derivation to the declared replacements and source-map footer removal', async () => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    const transformed = transformClientBundle(upstream)
    const normalized = transformed.replace(`\tid: "${CLIENT_ID}",`, `\tid: "${UPSTREAM_NAME}",`)
      .replace('isLoopback: true,', 'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),')
    expect(normalized).toBe(upstream.replace('\n//# sourceMappingURL=client.js.map', '\n'))
  })

  it('sets remote-hostname connections to loopback and preserves the official RPC surface', async () => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    expect(connectionFrom(upstream, 'dsh.example').isLoopback).toBe(false)
    expect(connectionFrom(transformClientBundle(upstream), 'dsh.example').isLoopback).toBe(true)
    expect(connectionFrom(transformClientBundle(upstream), '192.0.2.23').isLoopback).toBe(true)
  })

  it('leaves the official transport-owned Host classification intact', async () => {
    const clientPath = await resolveUpstreamClientPath()
    const upstream = await readFile(clientPath, 'utf8')
    const plugin = materialize(upstream, 'dsh.example', true)
    let connection: ConnectionHandle | undefined
    plugin.apply({
      provide(name: string, value: ConnectionHandle) {
        if (name !== 'connection') throw new Error(`unexpected service: ${name}`)
        connection = value
      },
    })
    if (connection === undefined) throw new Error('test plugin did not provide connection')
    expect(connection.isLoopback).toBe(true)
  })
})
