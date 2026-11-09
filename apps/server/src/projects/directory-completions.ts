import { opendir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { expandHomePath } from "../config/home-path.ts";

/** Bounded, non-recursive server filesystem browsing; no Git calls or mutations. */
export async function directoryCompletions(input: string, home: string, signal?: AbortSignal) {
  try {
    return await readDirectories(input, home, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR")
        throw new Error("This server directory does not exist.", { cause: error });
      if (error.code === "EACCES" || error.code === "EPERM")
        throw new Error("Permission denied reading this server directory.", { cause: error });
      if (error.code === "ENAMETOOLONG")
        throw new Error("This server path is too long.", { cause: error });
      if (error.code === "ELOOP")
        throw new Error("This path contains a symbolic link loop.", { cause: error });
    }
    throw error;
  }
}

async function readDirectories(input: string, home: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const written = input === "~" ? "~/" : input;
  if (!written.startsWith("~/") && !isAbsolute(written))
    throw new Error("Use an absolute server path or ~/.");
  const expanded = expandHomePath(written, home);
  const trailing = written.endsWith(sep) || (sep === "\\" && written.endsWith("/"));
  const parent = trailing ? expanded : expandHomePath(dirname(written), home);
  const prefix = trailing ? "" : basename(written);
  const directories: { name: string; path: string }[] = [];
  let scanned = 0;
  let truncated = false;
  const directory = await opendir(parent);
  for await (const entry of directory) {
    signal?.throwIfAborted();
    if (++scanned > 4096 || directories.length >= 200) {
      truncated = true;
      break;
    }
    const matches =
      process.platform === "win32"
        ? entry.name.toLowerCase().startsWith(prefix.toLowerCase())
        : entry.name.startsWith(prefix);
    if (!matches || (entry.name.startsWith(".") && !prefix.startsWith("."))) continue;
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = (await stat(join(parent, entry.name))).isDirectory();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (isDirectory) directories.push({ name: entry.name, path: join(parent, entry.name) + sep });
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));
  return { directories, truncated };
}
