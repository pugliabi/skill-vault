/**
 * --log-file: a server started hidden by scripts/launch.ps1 has no console,
 * so its stdout/stderr are also appended to a file, rotated before it would
 * pass maxBytes into <file>.1 … <file>.<keep>.
 */
import fs from "node:fs";
import path from "node:path";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

export function rotateLog(file: string, keep: number): void {
  fs.rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
}

export function createLogSink(
  file: string,
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
): (chunk: string | Uint8Array) => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* new file */
  }
  return (chunk) => {
    const len = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    try {
      if (size > 0 && size + len > maxBytes) {
        rotateLog(file, keep);
        size = 0;
      }
      fs.appendFileSync(file, chunk);
      size += len;
    } catch {
      /* logging must never take the server down */
    }
  };
}

/** Tee process.stdout and process.stderr into a rotating log file. */
export function installLogFile(file: string): void {
  const sink = createLogSink(file);
  sink(`\n=== ${new Date().toISOString()} pid ${process.pid} ===\n`);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(chunk);
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}
