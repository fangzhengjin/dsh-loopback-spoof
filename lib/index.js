/**
 * Host Connection half of the combined loopback-spoof Bundle. The HTTP and
 * WebSocket implementation remains the version-pinned upstream Connection
 * plugin; the generated browser half provides the same API with
 * `ctx.connection.isLoopback` fixed to `true`.
 * @module dsh-loopback-spoof
 */
export { Config, apply, inject, name } from '@deepseek-ai/dsh-client-connection';
