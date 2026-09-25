/**
 * Finds a free TCP port for Vite's HMR websocket server.
 *
 * Vite's default HMR port (24678) is hardcoded, so running two instances
 * of this app on the same machine (e.g. a second Skill Vault checkout)
 * causes the second instance's HMR websocket server to fail to bind with
 * "WebSocket server error: Port is already in use", which then makes the
 * client-side HMR client reload-loop forever ("server connection lost.
 * Polling for restart..."). Probing for a free port up front and passing
 * it to `hmr.port` avoids the collision entirely.
 */
import net from "node:net";

const DEFAULT_START_PORT = 24678;
const DEFAULT_ATTEMPTS = 50;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    // No host: binds all interfaces (Node dual-stack ::), matching how
    // Vite's HMR server itself binds. A probe bound only to 127.0.0.1
    // would report a port as free even when another instance already
    // holds it on 0.0.0.0/::, since those don't collide with a
    // loopback-only listener on some platforms (observed on Windows).
    tester.listen(port);
  });
}

/**
 * Returns the first free port at or after `startPort`, trying up to
 * `attempts` consecutive ports. Throws if none are free.
 */
export async function findFreePort(
  startPort: number = DEFAULT_START_PORT,
  attempts: number = DEFAULT_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = startPort + i;
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(
    `No free port found in range ${startPort}-${startPort + attempts - 1}`,
  );
}
