import {
  Agent,
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer, {
  type WebRoute,
  type WebUpgradeRoute,
} from '@deepseek-ai/dsh-host-webserver'
import LoopbackSpoofWebServer from '../src/webserver.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function request(): IncomingMessage {
  const setTimeout = vi.fn(function (this: Socket): Socket {
    return this
  })
  const socket = {
    remoteAddress: '198.51.100.24',
    remoteFamily: 'IPv4',
    setTimeout,
  } as unknown as Socket
  const req = {
    headers: {
      host: 'public.example:8443',
      origin: 'https://public.example:8443',
      'sec-fetch-site': 'cross-site',
      forwarded: 'for=198.51.100.24',
      'x-forwarded-for': '198.51.100.24',
      'x-real-ip': '198.51.100.24',
      'x-preserved': 'yes',
    },
    rawHeaders: [
      'Host', 'public.example:8443',
      'Origin', 'https://public.example:8443',
      'Sec-Fetch-Site', 'cross-site',
      'Forwarded', 'for=198.51.100.24',
      'X-Forwarded-For', '198.51.100.24',
      'X-Real-IP', '198.51.100.24',
      'X-Preserved', 'yes',
    ],
    socket,
  } as unknown as IncomingMessage
  Object.defineProperty(req, 'connection', {
    get: () => req.socket,
  })
  return req
}

function createServer(port = 3080): LoopbackSpoofWebServer {
  vi.spyOn(WebServer.prototype, 'port', 'get').mockReturnValue(port)
  return new LoopbackSpoofWebServer(new Context(), { host: '127.0.0.1', port: 0 })
}

function captureHttpRegistration(): {
  readonly disposer: ReturnType<typeof vi.fn>
  readonly route: () => WebRoute
} {
  let captured: WebRoute | undefined
  const disposer = vi.fn()
  vi.spyOn(WebServer.prototype, 'register').mockImplementation((route) => {
    captured = route
    return disposer
  })
  return {
    disposer,
    route: () => {
      if (captured === undefined) throw new Error('HTTP route was not registered')
      return captured
    },
  }
}

function captureUpgradeRegistration(): {
  readonly disposer: ReturnType<typeof vi.fn>
  readonly route: () => WebUpgradeRoute
} {
  let captured: WebUpgradeRoute | undefined
  const disposer = vi.fn()
  vi.spyOn(WebServer.prototype, 'registerUpgrade').mockImplementation((route) => {
    captured = route
    return disposer
  })
  return {
    disposer,
    route: () => {
      if (captured === undefined) throw new Error('upgrade route was not registered')
      return captured
    },
  }
}

function captureFallbackRegistration(): {
  readonly disposer: ReturnType<typeof vi.fn>
  readonly handler: () => WebRoute['handler']
} {
  let captured: WebRoute['handler'] | undefined
  const disposer = vi.fn()
  vi.spyOn(WebServer.prototype, 'registerFallback').mockImplementation((handler) => {
    captured = handler
    return disposer
  })
  return {
    disposer,
    handler: () => {
      if (captured === undefined) throw new Error('fallback handler was not registered')
      return captured
    },
  }
}

function rawHeaderValues(rawHeaders: readonly string[], expectedName: string): string[] {
  const values: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (name?.toLowerCase() === expectedName && value !== undefined) values.push(value)
  }
  return values
}

function expectLoopbackRequest(req: IncomingMessage, port: number): void {
  const authority = `127.0.0.1:${String(port)}`
  expect(req.headers).toMatchObject({
    host: authority,
    origin: `http://${authority}`,
    'sec-fetch-site': 'same-origin',
    'x-preserved': 'yes',
  })
  expect(req.headers.forwarded).toBeUndefined()
  expect(req.headers['x-forwarded-for']).toBeUndefined()
  expect(req.headers['x-real-ip']).toBeUndefined()
  expect(rawHeaderValues(req.rawHeaders, 'host')).toEqual([authority])
  expect(rawHeaderValues(req.rawHeaders, 'origin')).toEqual([`http://${authority}`])
  expect(rawHeaderValues(req.rawHeaders, 'sec-fetch-site')).toEqual(['same-origin'])
  expect(rawHeaderValues(req.rawHeaders, 'forwarded')).toEqual([])
  expect(rawHeaderValues(req.rawHeaders, 'x-forwarded-for')).toEqual([])
  expect(rawHeaderValues(req.rawHeaders, 'x-real-ip')).toEqual([])
  expect(req.headersDistinct).toMatchObject({
    host: [authority],
    origin: [`http://${authority}`],
    'sec-fetch-site': ['same-origin'],
    'x-preserved': ['yes'],
  })
  expect(req.headersDistinct.forwarded).toBeUndefined()
  expect(req.headersDistinct['x-forwarded-for']).toBeUndefined()
  expect(req.headersDistinct['x-real-ip']).toBeUndefined()
  expect(req.socket.remoteAddress).toBe('127.0.0.1')
  expect(req.socket.remoteFamily).toBe('IPv4')
  expect(req.connection).toBe(req.socket)
}

describe('LoopbackSpoofWebServer', () => {
  it.each([
    ['exact', '/api/events.mux'],
    ['prefix', '/api/'],
  ] as const)('presents a %s HTTP route as loopback', async (kind, path) => {
    const capture = captureHttpRegistration()
    const server = createServer(4312)
    const completion = Promise.resolve()
    const handler: WebRoute['handler'] = vi.fn(() => completion)
    const route: WebRoute = { kind, path, handler }

    expect(server.register(route)).toBe(capture.disposer)
    const req = request()
    const networkSocket = req.socket
    const res = {} as ServerResponse
    expect(capture.route()).not.toBe(route)
    expect(capture.route().handler(req, res)).toBe(completion)
    await completion

    expectLoopbackRequest(req, 4312)
    expect(req.socket).not.toBe(networkSocket)
    expect(networkSocket.remoteAddress).toBe('198.51.100.24')
    expect(req.socket.setTimeout(1000)).toBe(req.socket)
    expect(networkSocket.setTimeout).toHaveBeenCalledWith(1000)
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(req, res)
  })

  it('keeps real IncomingMessage views and keep-alive socket identity consistent', async () => {
    const capture = captureHttpRegistration()
    const server = createServer(4312)
    const seen: Array<{
      headers: IncomingMessage['headers']
      headersDistinct: IncomingMessage['headersDistinct']
      headersDistinctIsOwn: boolean
      headersDistinctIsEnumerable: boolean
      rawHeaders: string[]
      socket: Socket
    }> = []
    server.register({
      kind: 'exact',
      path: '/probe',
      handler(req, res) {
        const distinct = req.headersDistinct
        req.headersDistinct = distinct
        seen.push({
          headers: { ...req.headers },
          headersDistinct: Object.fromEntries(Object.entries(req.headersDistinct).flatMap(([name, values]) => (
            values === undefined ? [] : [[name, [...values]]]
          ))),
          headersDistinctIsOwn: Object.hasOwn(req, 'headersDistinct'),
          headersDistinctIsEnumerable: Object.keys(req).includes('headersDistinct'),
          rawHeaders: [...req.rawHeaders],
          socket: req.socket,
        })
        res.end('ok')
      },
    })

    const transport = createHttpServer((req, res) => {
      try {
        void capture.route().handler(req, res)
      } catch (error) {
        res.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    })
    await new Promise<void>((resolve, reject) => {
      transport.once('error', reject)
      transport.listen(0, '127.0.0.1', resolve)
    })
    const address = transport.address() as AddressInfo
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const send = async (): Promise<void> => new Promise((resolve, reject) => {
      const req = requestHttp({
        agent,
        headers: {
          forwarded: 'for=198.51.100.24',
          host: 'public.example:8443',
          origin: 'https://public.example:8443',
          'sec-fetch-site': 'cross-site',
          'x-forwarded-for': '198.51.100.24',
          'x-preserved': ['one', 'two'],
          'x-real-ip': '198.51.100.24',
        },
        host: '127.0.0.1',
        path: '/probe',
        port: address.port,
      }, (res) => {
        res.resume()
        res.once('end', resolve)
      })
      req.once('error', reject)
      req.end()
    })

    try {
      await send()
      await send()
    } finally {
      agent.destroy()
      await new Promise<void>((resolve, reject) => {
        transport.close((error) => { error === undefined ? resolve() : reject(error) })
      })
    }

    expect(seen).toHaveLength(2)
    const first = seen[0]
    const second = seen[1]
    if (first === undefined || second === undefined) throw new Error('keep-alive probe did not reach both handlers')
    expect(first.socket).toBe(second.socket)
    expect(first.headers).toMatchObject({
      host: '127.0.0.1:4312',
      origin: 'http://127.0.0.1:4312',
      'sec-fetch-site': 'same-origin',
      'x-preserved': 'one, two',
    })
    expect(first.headers.forwarded).toBeUndefined()
    expect(first.headers['x-forwarded-for']).toBeUndefined()
    expect(first.headers['x-real-ip']).toBeUndefined()
    expect(rawHeaderValues(first.rawHeaders, 'host')).toEqual(['127.0.0.1:4312'])
    expect(rawHeaderValues(first.rawHeaders, 'origin')).toEqual(['http://127.0.0.1:4312'])
    expect(rawHeaderValues(first.rawHeaders, 'sec-fetch-site')).toEqual(['same-origin'])
    expect(rawHeaderValues(first.rawHeaders, 'x-preserved')).toEqual(['one', 'two'])
    expect(rawHeaderValues(first.rawHeaders, 'forwarded')).toEqual([])
    expect(first.headersDistinct).toMatchObject({
      host: ['127.0.0.1:4312'],
      origin: ['http://127.0.0.1:4312'],
      'sec-fetch-site': ['same-origin'],
      'x-preserved': ['one', 'two'],
    })
    expect(first.headersDistinct.forwarded).toBeUndefined()
    expect(first.headersDistinctIsOwn).toBe(false)
    expect(first.headersDistinctIsEnumerable).toBe(false)
  })

  it('leaves the static fallback handler and request unchanged', () => {
    const capture = captureFallbackRegistration()
    const server = createServer()
    const handler: WebRoute['handler'] = vi.fn()
    expect(server.registerFallback(handler)).toBe(capture.disposer)
    expect(capture.handler()).toBe(handler)

    const req = request()
    const res = {} as ServerResponse
    capture.handler()(req, res)
    expect(handler).toHaveBeenCalledWith(req, res)
    expect(req.headers.host).toBe('public.example:8443')
    expect(req.headers.origin).toBe('https://public.example:8443')
    expect(req.headers['sec-fetch-site']).toBe('cross-site')
    expect(req.socket.remoteAddress).toBe('198.51.100.24')
  })

  it('presents every upgrade handler with the same loopback socket view', async () => {
    const capture = captureUpgradeRegistration()
    const server = createServer(5099)
    const completion = Promise.resolve()
    const handler: WebUpgradeRoute['handler'] = vi.fn(() => completion)
    const upgrade: WebUpgradeRoute = { path: '/hmr', handler }

    expect(server.registerUpgrade(upgrade)).toBe(capture.disposer)
    const req = request()
    const networkSocket = req.socket
    const head = Buffer.alloc(0)
    expect(capture.route()).not.toBe(upgrade)
    expect(capture.route().handler(req, networkSocket, head)).toBe(completion)
    await completion

    expectLoopbackRequest(req, 5099)
    expect(req.socket).not.toBe(networkSocket)
    expect(networkSocket.remoteAddress).toBe('198.51.100.24')
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(req, req.socket as unknown as Duplex, head)
  })
})
