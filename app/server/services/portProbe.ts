/**
 * Is a TCP port free for the launcher to bind? (server/launcher.ts)
 *
 * On Windows a 127.0.0.1 bind succeeds beside another program's 0.0.0.0,
 * [::] or [::1] listener on the same port (see freePort.ts), and the app
 * would then shadow that program for localhost, or be shadowed by it. So for
 * a loopback host the port also must not accept connections on 127.0.0.1 or
 * ::1. That is checked by connecting, not by binding 0.0.0.0 / ::, because
 * listening on a non-loopback address can raise a Windows Firewall prompt
 * for node.exe.
 */
import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/** A local connect is answered or refused at once; this only guards against a hang. */
const CONNECT_TIMEOUT_MS = 300;

function canBind(p: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(p, host);
  });
}

/** True when something accepts a TCP connection on host:p (errors, e.g. no IPv6, mean no). */
function acceptsConnections(p: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port: p, host });
    const done = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function isPortFree(p: number, host: string): Promise<boolean> {
  if (!(await canBind(p, host))) return false;
  // Port 0 means "let the OS pick", which can't be connected to.
  if (p === 0 || !LOOPBACK.has(host.toLowerCase())) return true;
  return !(await acceptsConnections(p, "127.0.0.1")) && !(await acceptsConnections(p, "::1"));
}
