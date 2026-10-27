/**
 * Is a TCP port free for the launcher to bind? (server/launcher.ts)
 *
 * On Windows a 127.0.0.1 bind succeeds beside another program's 0.0.0.0 or
 * [::] listener on the same port (see freePort.ts), and the app would then
 * shadow that program for localhost. So for a loopback host the port also
 * has to be bindable on 0.0.0.0 and on :: to count as free.
 */
import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/** Binding :: fails like this where IPv6 is missing or disabled: nothing can be listening there. */
const NO_IPV6 = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL"]);

function canBind(p: number, host: string, noIpv6IsFree = false): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => resolve(noIpv6IsFree && NO_IPV6.has(err.code ?? "")));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(p, host);
  });
}

export async function isPortFree(p: number, host: string): Promise<boolean> {
  if (!(await canBind(p, host))) return false;
  if (!LOOPBACK.has(host.toLowerCase())) return true;
  return (await canBind(p, "0.0.0.0")) && (await canBind(p, "::", true));
}
