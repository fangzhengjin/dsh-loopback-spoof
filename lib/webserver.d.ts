/**
 * DSH WebServer replacement that presents every dynamic HTTP and upgrade
 * handler with consistent loopback headers and socket facts. The inherited
 * static fallback remains unchanged because `registerFallback()` is not
 * overridden.
 * @module dsh-loopback-spoof/webserver
 */
import WebServer from '@deepseek-ai/dsh-host-webserver';
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver';
/**
 * Drop-in `ctx.webServer` provider that preserves the shipped server and route
 * implementation while wrapping every registered HTTP or upgrade handler.
 * Static assets remain untouched because the inherited fallback seat is not
 * overridden.
 */
declare class LoopbackSpoofWebServer extends WebServer {
    register(route: WebRoute): () => void;
    /**
     * Register one upgrade route. Its handler receives the same loopback socket
     * view through both the request and the explicit socket argument.
     * @param route - Original upgrade contribution.
     * @returns the original WebServer upgrade-registration disposer.
     * @throws {Error} When the base WebServer rejects a duplicate upgrade route.
     */
    registerUpgrade(route: WebUpgradeRoute): () => void;
}
export default LoopbackSpoofWebServer;
