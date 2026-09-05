/**
 * Host Connection half of the loopback-spoof Bundle. The HTTP, WebSocket,
 * authentication, and request-trust implementation comes from the active DSH
 * installation; the generated browser half provides the same API with
 * `ctx.connection.isLoopback` fixed to `true`.
 * @module dsh-loopback-spoof
 */
export { Config, apply, inject, name } from '@deepseek-ai/dsh-client-connection';
