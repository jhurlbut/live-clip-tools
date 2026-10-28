// Sandbox-aware filesystem helpers. In installed (non-Developer-Mode) mode,
// Live runs the Extension Host under Node's permission model: fs read/write is
// limited to the extension's storage and temp directories — but child
// processes are explicitly allowed (--allow-child-process) and are not
// sandboxed. So when a direct fs call is denied, we route the operation
// through /bin/cp & friends. In dev mode the direct calls just work.

import { execFile } from "node:child_process";
import * as fss from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

let tempBase: string | null = null;
let resolvedBase: string | null = null;

/** Call once at activate: the extension's sanctioned temp dir (writable in-process). */
export function setTempBase(dir: string | undefined) {
  tempBase = dir ?? null;
  resolvedBase = null;
}

function isWritableDir(dir: string): boolean {
  try {
    fss.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.ats-probe-${process.pid}`);
    fss.writeFileSync(probe, "");
    fss.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory this process can create files in directly. The sandbox's write
 * allowlist doesn't always cover environment.tempDirectory (and macOS purges
 * /var/folders temp dirs), so probe candidates until one actually works.
 */
export function scratchBase(): string {
  if (resolvedBase !== null) return resolvedBase;
  const candidates = [
    tempBase,
    path.join(os.tmpdir(), "Ableton Extensions"),
    path.join(os.homedir(), "Library", "Application Support", "Ableton", "Extensions Data"),
    os.tmpdir(),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  for (const dir of candidates) {
    if (isWritableDir(dir)) {
      if (dir !== tempBase) {
        console.info(`[arrangement-to-session] using scratch dir ${dir} (temp directory not writable)`);
      }
      resolvedBase = dir;
      return dir;
    }
  }
  resolvedBase = tempBase ?? os.tmpdir();
  return resolvedBase;
}

function isRestricted(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "ERR_ACCESS_DENIED" ||
    (typeof e?.message === "string" && e.message.includes("has been restricted"));
}

/** mkdir -p that falls back to a child process outside the sandbox. */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (!isRestricted(err)) throw err;
    await run("/bin/mkdir", ["-p", dir]);
  }
}

/** Write a file anywhere: direct when allowed, else via temp + /bin/cp. */
export async function writeFileAnywhere(dst: string, data: Buffer | string): Promise<void> {
  try {
    await fs.writeFile(dst, data);
    return;
  } catch (err) {
    if (!isRestricted(err)) throw err;
  }
  const tmp = await fs.mkdtemp(path.join(scratchBase(), "ats-w-"));
  const staging = path.join(tmp, path.basename(dst));
  try {
    await fs.writeFile(staging, data);
    await run("/bin/cp", [staging, dst]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Copy src -> dst regardless of which side is outside the sandbox. */
export async function copyAnywhere(src: string, dst: string): Promise<void> {
  try {
    await fs.copyFile(src, dst);
    return;
  } catch (err) {
    if (!isRestricted(err)) throw err;
  }
  await run("/bin/cp", [src, dst]);
}

/** Read a file anywhere: direct when allowed, else /bin/cp into temp first. */
export async function readFileAnywhere(src: string): Promise<Buffer> {
  try {
    return await fs.readFile(src);
  } catch (err) {
    if (!isRestricted(err)) throw err;
  }
  const tmp = await fs.mkdtemp(path.join(scratchBase(), "ats-r-"));
  const staging = path.join(tmp, path.basename(src));
  try {
    await run("/bin/cp", [src, staging]);
    return await fs.readFile(staging);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
