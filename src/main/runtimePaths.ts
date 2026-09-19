import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface LauncherRuntimePaths {
  root: string;
  userData: string;
  sessionData: string;
  cache: string;
  temp: string;
  logs: string;
  crashDumps: string;
}

/** Directory containing the running launcher executable (or the dev project directory). */
export function launcherDirectory(): string {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  return app.isPackaged ? path.dirname(app.getPath("exe")) : process.cwd();
}

/**
 * All launcher-owned mutable data goes below this directory.
 * EVEJS_USER_DATA_DIR is retained for tests and explicitly overrides the whole runtime root.
 */
export function launcherRuntimeRoot(): string {
  if (process.env.EVEJS_USER_DATA_DIR) return path.resolve(process.env.EVEJS_USER_DATA_DIR);
  return path.join(launcherDirectory(), "_launcher");
}

export function ensureLauncherRuntimePaths(): LauncherRuntimePaths {
  const root = launcherRuntimeRoot();
  const legacyOverride = !!process.env.EVEJS_USER_DATA_DIR;
  const paths: LauncherRuntimePaths = {
    root,
    userData: legacyOverride ? root : path.join(root, "data"),
    sessionData: path.join(root, "cache"),
    cache: path.join(root, "cache"),
    temp: path.join(root, "temp"),
    logs: path.join(root, "logs"),
    crashDumps: path.join(root, "crash")
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  return paths;
}

export function launcherTempDir(): string {
  return ensureLauncherRuntimePaths().temp;
}
