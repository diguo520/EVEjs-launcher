import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

/* ------------------------------------------------------------------ */
/* 客户端配置：解析 EvEJSConfig.bat（set "KEY=VALUE" 行）                */
/* ------------------------------------------------------------------ */

export interface ClientConfig {
  clientPath: string;
  clientExe: string;
  caPem: string;
  proxyUrl: string;
  safeGraphics: string;
  safeWindowed: string;
  sourceFile: string;
}

const BAT_VAR_RE = /^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*(.*?)\s*$/;
const parseJson = <T>(text: string): T => JSON.parse(text.replace(/^\uFEFF/, "")) as T;

export function findClientConfigFile(repoRoot: string): string | null {
  const candidates = [
    path.join(repoRoot, "tools", "ClientSETUP", "scripts", "EvEJSConfig.bat"),
    path.join(repoRoot, "EvEJSConfig.bat")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function parseBatVars(file: string, expandRoot?: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = BAT_VAR_RE.exec(line);
    if (!m) continue;
    let value = m[2];
    // 兼容 set "KEY=VALUE" / set KEY="VALUE" 两种引号包裹形式
    if (value.startsWith('"')) value = value.slice(1);
    if (value.endsWith('"')) value = value.slice(0, -1);
    if (expandRoot) value = value.replace(/%EVEJS_REPO_ROOT%/g, expandRoot);
    out[m[1]] = value;
  }
  return out;
}

export function readClientConfig(repoRoot: string): ClientConfig {
  const sourceFile = findClientConfigFile(repoRoot);
  const empty: ClientConfig = {
    clientPath: "",
    clientExe: "",
    caPem: "",
    proxyUrl: "http://127.0.0.1:26002/",
    safeGraphics: "off",
    safeWindowed: "off",
    sourceFile: sourceFile ?? ""
  };
  if (!sourceFile) return empty;
  const vars = parseBatVars(sourceFile, repoRoot);
  return {
    clientPath: vars.EVEJS_CLIENT_PATH ?? "",
    clientExe: vars.EVEJS_CLIENT_EXE ?? "",
    caPem: vars.EVEJS_CA_PEM ?? "",
    proxyUrl: vars.EVEJS_PROXY_URL ?? "http://127.0.0.1:26002/",
    safeGraphics: vars.EVEJS_CLIENT_SAFE_GRAPHICS ?? "off",
    safeWindowed: vars.EVEJS_CLIENT_SAFE_WINDOWED ?? "off",
    sourceFile
  };
}

export type ClientConfigPatch = Partial<
  Pick<ClientConfig, "clientPath" | "clientExe" | "caPem" | "proxyUrl" | "safeWindowed" | "safeGraphics">
>;

/**
 * 回写 EvEJSConfig.bat（Phase 5）：仅更新/新增指定 `set "KEY=VALUE"` 行，
 * 保留其余行与注释。文件为 ASCII 内容，统一以 CRLF + UTF-8 写出。
 */
export function writeClientConfig(repoRoot: string, patch: ClientConfigPatch): ClientConfig {
  const file = findClientConfigFile(repoRoot);
  if (!file) throw new Error("未找到 EvEJSConfig.bat，无法回写配置");
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  const upsert = (key: string, value: string): void => {
    const re = new RegExp(`^\\s*set\\s+"?${key}"?\\s*=`, "i");
    const line = `set "${key}=${value}"`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        lines[i] = line;
        found = true;
        break;
      }
    }
    if (!found) lines.push(line);
  };
  if (patch.clientPath !== undefined) upsert("EVEJS_CLIENT_PATH", patch.clientPath);
  if (patch.clientExe !== undefined) upsert("EVEJS_CLIENT_EXE", patch.clientExe);
  if (patch.caPem !== undefined) upsert("EVEJS_CA_PEM", patch.caPem);
  if (patch.proxyUrl !== undefined) upsert("EVEJS_PROXY_URL", patch.proxyUrl);
  if (patch.safeWindowed !== undefined) upsert("EVEJS_CLIENT_SAFE_WINDOWED", patch.safeWindowed);
  if (patch.safeGraphics !== undefined) upsert("EVEJS_CLIENT_SAFE_GRAPHICS", patch.safeGraphics);
  fs.writeFileSync(file, lines.join("\r\n").replace(/\r\n+$/, "") + "\r\n", "utf-8");
  return readClientConfig(repoRoot);
}

/* ------------------------------------------------------------------ */
/* 服务器配置：config/server.json（端口等，只读展示）                      */
/* ------------------------------------------------------------------ */

export interface ServerConfig {
  ports: { game: number; images: number; gateway: number };
  sourceFile: string;
}

export function readServerConfig(repoRoot: string): ServerConfig {
  const file = path.join(repoRoot, "config", "server.json");
  const fallback: ServerConfig = { ports: { game: 26000, images: 26001, gateway: 26002 }, sourceFile: file };
  try {
    const raw = parseJson<any>(fs.readFileSync(file, "utf-8"));
    return {
      ports: {
        game: raw?.network?.serverPort ?? 26000,
        images: raw?.images?.imageServerUrl ? parseInt(String(raw.images.imageServerUrl).match(/:(\d+)/)?.[1] ?? "26001", 10) : 26001,
        gateway: raw?.gateway?.microservicesPort ?? 26002
      },
      sourceFile: file
    };
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* UI 设置持久化（electron-store 替代：userData/launcher-settings.json） */
/* ------------------------------------------------------------------ */

function settingsFile(): string {
  return path.join(app.getPath("userData"), "launcher-settings.json");
}

export function readSettings(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(settingsFile(), "utf-8");
    const parsed = parseJson<Record<string, unknown>>(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    /* 持久化失败不阻断运行 */
  }
  return next;
}
