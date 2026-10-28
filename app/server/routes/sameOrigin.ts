/**
 * Guards for state-changing requests (used by /api/app and /api/setup).
 *
 * A browser marks a request from another site with Sec-Fetch-Site, and always
 * sends Origin on a POST/PUT/DELETE; either one naming someone else means the
 * request came from a page that isn't this app. A request with neither header
 * (curl, tests) isn't from a web page and is allowed.
 */
import type { NextFunction, Request, Response } from "express";

/** The Origin header names the host the request was sent to ("null" and junk never match). */
export function isOwnOrigin(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isCrossSite(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  const origin = req.get("origin");
  return (site !== undefined && site !== "same-origin") || (origin !== undefined && !isOwnOrigin(origin, req.get("host")));
}

/** 403 for cross-site writes (anything but GET / HEAD / OPTIONS). */
export function refuseCrossSiteWrites(req: Request, res: Response, next: NextFunction): void {
  const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (write && isCrossSite(req)) {
    res.status(403).json({ error: "cross-site request refused" });
    return;
  }
  next();
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when the request came from this PC: a loopback socket AND a loopback Host header. */
export function isLoopbackRequest(req: Request): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const host = (req.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_ADDRS.has(addr) && LOOPBACK_HOSTS.has(host);
}
