/**
 * Host Connection half of the loopback-spoof Bundle. The HTTP, WebSocket,
 * transport and request-trust implementation comes from the active DSH
 * installation. Browser-session token and Cookie checks are disabled for the
 * Tailscale-only deployment, while the generated browser half keeps
 * `ctx.connection.isLoopback` fixed to `true`.
 * @module dsh-loopback-spoof
 */

import { apply as applyOfficial, Config, inject, name } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionConfig } from '@deepseek-ai/dsh-client-connection'

type HostContext = Parameters<typeof applyOfficial>[0]

/** Apply the official transport while disabling browser-session authentication. */
export async function apply(ctx: HostContext, config?: ConnectionConfig): Promise<void> {
  await applyOfficial(ctx, config)
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection as typeof connectionCtx.connection & {
      requestRejection: (request: unknown) => 401 | 403 | undefined
      authorizeIndex: (request: unknown, response: unknown) => boolean
      authenticatedUrl: (baseUrl: string) => string
    }
    const requestRejection = connection.requestRejection.bind(connection)
    connection.requestRejection = (request) => {
      const rejection = requestRejection(request)
      return rejection === 401 ? undefined : rejection
    }
    connection.authorizeIndex = () => true
    connection.authenticatedUrl = (baseUrl: string) => new URL(baseUrl).toString()
  })
}

export { Config, inject, name }
export type { ConnectionConfig } from '@deepseek-ai/dsh-client-connection'
