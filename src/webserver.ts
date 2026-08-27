/**
 * DSH WebServer replacement that presents every dynamic HTTP and upgrade
 * handler with consistent loopback headers and socket facts. The inherited
 * static fallback remains unchanged because `registerFallback()` is not
 * overridden.
 * @module dsh-loopback-spoof/webserver
 */

import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_FAMILY = 'IPv4'
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
] as const
const CONTROLLED_HEADERS = new Set([
  'host',
  'origin',
  'sec-fetch-site',
  ...FORWARDING_HEADERS,
])
const socketFacades = new WeakMap<object, object>()

function presentSocketAsLoopback<T extends object>(socket: T): T {
  const cached = socketFacades.get(socket)
  if (cached !== undefined) return cached as T

  let facade: T
  facade = new Proxy(socket, {
    get(target, property) {
      if (property === 'remoteAddress') return LOOPBACK_HOST
      if (property === 'remoteFamily') return LOOPBACK_FAMILY
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args)
        return result === target ? facade : result
      }
    },
  })
  socketFacades.set(socket, facade)
  return facade
}

function headersDistinct(rawHeaders: readonly string[]): Record<string, string[]> {
  const result = Object.create(null) as Record<string, string[]>
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (name === undefined || value === undefined) continue
    const key = name.toLowerCase()
    const values = result[key] ??= []
    values.push(value)
  }
  return result
}

/** Present every standard Node request view consulted by trust fences. */
function presentAsLoopback(req: IncomingMessage, port: number): void {
  const authority = `${LOOPBACK_HOST}:${String(port)}`
  const replacements = [
    ['Host', authority],
    ['Origin', `http://${authority}`],
    ['Sec-Fetch-Site', 'same-origin'],
  ] as const

  req.headers.host = authority
  req.headers.origin = `http://${authority}`
  req.headers['sec-fetch-site'] = 'same-origin'
  for (const header of FORWARDING_HEADERS) delete req.headers[header]

  const rawHeaders: string[] = []
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]
    const value = req.rawHeaders[index + 1]
    if (name === undefined || value === undefined || CONTROLLED_HEADERS.has(name.toLowerCase())) continue
    rawHeaders.push(name, value)
  }
  for (const [name, value] of replacements) rawHeaders.push(name, value)
  req.rawHeaders = rawHeaders
  // Use Node's public setter so the native non-enumerable accessor contract is
  // preserved while bypassing its stale private raw-header count.
  req.headersDistinct = headersDistinct(rawHeaders)
  req.socket = presentSocketAsLoopback<Socket>(req.socket)
}

/**
 * Drop-in `ctx.webServer` provider that preserves the shipped server and route
 * implementation while wrapping every registered HTTP or upgrade handler.
 * Static assets remain untouched because the inherited fallback seat is not
 * overridden.
 */
class LoopbackSpoofWebServer extends WebServer {
  override register(route: WebRoute): () => void {
    return super.register({
      ...route,
      handler: (req, res) => {
        presentAsLoopback(req, this.port)
        return route.handler(req, res)
      },
    })
  }

  /**
   * Register one upgrade route. Its handler receives the same loopback socket
   * view through both the request and the explicit socket argument.
   * @param route - Original upgrade contribution.
   * @returns the original WebServer upgrade-registration disposer.
   * @throws {Error} When the base WebServer rejects a duplicate upgrade route.
   */
  override registerUpgrade(route: WebUpgradeRoute): () => void {
    return super.registerUpgrade({
      ...route,
      handler: (req, _socket, head) => {
        presentAsLoopback(req, this.port)
        return route.handler(req, req.socket as unknown as Duplex, head)
      },
    })
  }
}

export default LoopbackSpoofWebServer
