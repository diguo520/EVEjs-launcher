import * as fs from "fs";
import * as path from "path";
import { app, safeStorage } from "electron";
import { ensureLauncherRuntimePaths } from "./runtimePaths";

/**
 * GitHub 令牌（PAT）的存取。
 *
 * 设计（见 docs/mod-signing-and-marketplace-plan.md §5.4）：
 *  - 优先用 Electron `safeStorage`（Windows 走 DPAPI，绑定当前用户）加密后落盘；
 *  - `safeStorage` 不可用时**不落盘**，只保存在内存里（当次会话有效），并明确告知；
 *  - 令牌只用于「提交模组」（fork → 分支 → 提交分片 → 开 PR），不参与任何下载与更新。
 */

const TOKEN_FILE = "github-token.bin";

/** safeStorage 不可用时的内存兜底 */
let memoryToken = "";
let memoryOnly = false;

function tokenPath(): string {
  return path.join(ensureLauncherRuntimePaths().userData, TOKEN_FILE);
}

export interface TokenStatus {
  hasToken: boolean;
  /** true = 已加密落盘；false = 仅内存（退出即失效） */
  encrypted: boolean;
  path: string;
  reason?: string;
}

export function tokenStatus(): TokenStatus {
  const file = tokenPath();
  const onDisk = fs.existsSync(file);
  return {
    hasToken: !!getToken() || onDisk,
    encrypted: onDisk,
    path: file
  };
}

export function getToken(): string {
  const file = tokenPath();
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file);
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(raw);
      }
      // 文件存在但当前环境解不开：不静默失败，交给上层提示
      return "";
    } catch {
      return "";
    }
  }
  return memoryToken;
}

export function saveToken(token: string): { ok: boolean; encrypted: boolean; reason?: string } {
  const value = String(token || "").trim();
  if (!value) return { ok: false, encrypted: false, reason: "令牌不能为空" };

  let encrypted = false;
  let reason: string | undefined;
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(value);
      fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
      fs.writeFileSync(tokenPath(), buf);
      encrypted = true;
      memoryToken = "";
      memoryOnly = false;
    } else {
      memoryToken = value;
      memoryOnly = true;
      reason = "当前环境不支持加密存储（safeStorage 不可用），令牌只保存在内存里，退出启动器后需要重新填写";
    }
  } catch (e) {
    memoryToken = value;
    memoryOnly = true;
    reason = "加密失败（" + (e instanceof Error ? e.message : String(e)) + "），令牌只保存在内存里";
  }
  return { ok: true, encrypted, reason };
}

export function clearToken(): { ok: boolean; reason?: string } {
  memoryToken = "";
  memoryOnly = false;
  try {
    if (fs.existsSync(tokenPath())) fs.rmSync(tokenPath(), { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 仅用于 UI 展示：内存模式标记 */
export function isMemoryOnly(): boolean {
  return memoryOnly;
}

/** 在已就绪的 app 里调用一次，确保 userData 路径已生效 */
export function ensureTokenReady(): void {
  if (!app.isReady()) return;
  try {
    ensureLauncherRuntimePaths();
  } catch {
    /* 忽略：取不到路径时 getToken 仍会走内存兜底 */
  }
}