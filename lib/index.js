/**
 * Host Connection half of the loopback-spoof Bundle. The HTTP, WebSocket,
 * transport and request-trust implementation comes from the active DSH
 * installation. Browser-session token and Cookie checks are disabled for the
 * Tailscale-only deployment, while the generated browser half keeps
 * `ctx.connection.isLoopback` fixed to `true`.
 * @module dsh-loopback-spoof
 */
import { apply as applyOfficial, Config, inject, name } from '@deepseek-ai/dsh-client-connection';
/** Apply the official transport while disabling browser-session authentication. */
export async function apply(ctx, config) {
    await applyOfficial(ctx, config);
    ctx.inject(['connection'], (connectionCtx) => {
        const connection = connectionCtx.connection;
        connection.requestRejection = () => undefined;
        connection.authorizeIndex = () => true;
        connection.authenticatedUrl = (baseUrl) => new URL(baseUrl).toString();
    });
}
export { Config, inject, name };
