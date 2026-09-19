import { execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { app, safeStorage } from "electron";
import { resolveRepoRoot } from "./envDetector";
import { startService } from "./processManager";
import { readSettings, writeSettings } from "./configStore";

export interface AccountRole {
  characterId: string;
  characterName: string;
  securityStatus: number | null;
  isk: number;
  skillPoints: number;
  shipName: string;
  shipTypeID: number | null;
  location: {
    stationID: number | null;
    stationName: string;
    solarSystemID: number | null;
    solarSystemName: string;
    worldSpaceID: number | null;
    label: string;
  };
  /** 游戏内肖像 base64 data URL；未上传肖像时为默认肖像，无默认时为 null */
  avatar?: string | null;
}

export interface AccountInfo {
  accountKey: string;
  accountId: number;
  isGM: boolean;
  banned: boolean;
  hasStoredCredential?: boolean;
  roles: AccountRole[];
}

export interface AccountOpResult {
  ok: boolean;
  data?: AccountInfo[];
  reason?: string;
  output?: string;
}

function credentialMap(): Record<string, string> {
  const value = readSettings().accountCredentials;
  return value && typeof value === "object" ? { ...(value as Record<string, string>) } : {};
}

function rememberAccountPassword(user: string, password: string): boolean {
  try {
    if (!user || !password || !safeStorage.isEncryptionAvailable()) return false;
    const credentials = credentialMap();
    credentials[user] = safeStorage.encryptString(password).toString("base64");
    writeSettings({ accountCredentials: credentials });
    return true;
  } catch {
    return false;
  }
}

function storedAccountPassword(user: string): string | null {
  try {
    const encrypted = credentialMap()[user];
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

function hasStoredCredential(user: string): boolean {
  return !!storedAccountPassword(user);
}

function forgetAccountPassword(user: string): void {
  const credentials = credentialMap();
  if (!Object.prototype.hasOwnProperty.call(credentials, user)) return;
  delete credentials[user];
  writeSettings({ accountCredentials: credentials });
}

/** account-cli.js 位置：打包后随 extraResources 进 resources；开发时在 launcher/scripts */
function cliPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "account-cli.js");
  }
  // dist/main/main -> launcher/scripts/account-cli.js
  return path.join(__dirname, "..", "..", "..", "scripts", "account-cli.js");
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const script = cliPath();
    if (!fs.existsSync(script)) {
      resolve({ stdout: "", stderr: "account-cli.js 不存在: " + script, code: -1 });
      return;
    }
    execFile(
      "node",
      [script, ...args],
      { cwd: resolveRepoRoot(), timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ stdout, stderr, code: err ? (typeof err.code === "number" ? err.code : -1) : 0 });
      }
    );
  });
}

/**
 * 解析角色游戏内肖像（与 EvEJS 服务端 portraitImageStore 一致）：
 * 1) 运行时根 _local\gameStore\images\Character\<id>_<size>.jpg|png
 *    （服务端 resolveRuntimeImagesDir() = <storeRoot>/images，storeRoot = _local\gameStore）
 * 2) legacy 目录 server\src\_secondary\image\generated\Character\<id>_<size>.jpg|png
 * 尺寸优先 128（其次 64/256/512/32/1024）；都无则回退默认肖像 hi.jpg。
 * 返回 base64 data URL。
 */
const PORTRAIT_SIZES = [128, 64, 256, 512, 32, 1024];
const PORTRAIT_EXTS = ["jpg", "png"];

function resolvePortraitDataUrl(root: string, characterId: string): string | null {
  const candidates: string[] = [];
  const runtimeDir = path.join(root, "_local", "gameStore", "images", "Character");
  const legacyDir = path.join(root, "server", "src", "_secondary", "image", "generated", "Character");
  for (const size of PORTRAIT_SIZES) {
    for (const ext of PORTRAIT_EXTS) {
      candidates.push(path.join(runtimeDir, `${characterId}_${size}.${ext}`));
      candidates.push(path.join(legacyDir, `${characterId}_${size}.${ext}`));
    }
  }
  candidates.push(path.join(root, "server", "src", "_secondary", "image", "images", "hi.jpg"));
  candidates.push(path.join(root, "server", "src", "_secondary", "image", "images", "hi.png"));
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) {
        const ext = path.extname(file).slice(1).toLowerCase();
        const mime = ext === "png" ? "image/png" : "image/jpeg";
        return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
      }
    } catch {
      /* 不存在继续 */
    }
  }
  return null;
}

/** 列出全部账号（含角色与游戏内头像） */
export async function listAccounts(): Promise<AccountOpResult> {
  const root = resolveRepoRoot();
  const { stdout, stderr, code } = await runCli(["list", root]);
  if (code !== 0) return { ok: false, reason: (stderr || stdout || "list 失败").trim() };
  try {
    const accounts = JSON.parse(stdout.trim()) as AccountInfo[];
    for (const acc of accounts) {
      acc.hasStoredCredential = hasStoredCredential(acc.accountKey);
      for (const role of acc.roles) {
        role.avatar = resolvePortraitDataUrl(root, role.characterId);
      }
    }
    return { ok: true, data: accounts };
  } catch (e) {
    return { ok: false, reason: "解析账号列表失败: " + (e instanceof Error ? e.message : String(e)) };
  }
}

/** 删除账号：target 为账号 key 或角色名；apply=false 仅预览 */
export async function deleteAccount(
  target: string,
  apply: boolean
): Promise<AccountOpResult> {
  const root = resolveRepoRoot();
  const args = ["delete", root, target];
  if (apply) args.push("--apply");
  const { stdout, stderr, code } = await runCli(args);
  if (code !== 0) return { ok: false, reason: (stderr || stdout || "delete 失败").trim() };
  forgetAccountPassword(target);
  return { ok: true, output: stdout };
}

/** 新建账号：用户名 + 密码 + 是否授权 GM */
export async function createAccount(
  user: string,
  password: string,
  isGM: boolean
): Promise<AccountOpResult> {
  const root = resolveRepoRoot();
  const args = ["create", root, user, password];
  if (isGM) args.push("--gm");
  const { stdout, stderr, code } = await runCli(args);
  if (code !== 0) return { ok: false, reason: (stderr || stdout || "create 失败").trim() };
  rememberAccountPassword(user, password);
  return { ok: true, output: stdout };
}

/** 检测服务是否在运行（决定删除按钮是否可点） */
export async function checkServerRunning(): Promise<{ running: boolean; ports: number[] }> {
  const root = resolveRepoRoot();
  const { stdout, code } = await runCli(["check-running", root]);
  if (code !== 0) return { running: false, ports: [] };
  try {
    return JSON.parse(stdout.trim()) as { running: boolean; ports: number[] };
  } catch {
    return { running: false, ports: [] };
  }
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** 验证账号密码（客户端同款哈希，只读数据库） */
export async function verifyAccount(user: string, password: string): Promise<VerifyResult> {
  const root = resolveRepoRoot();
  const { stdout, code } = await runCli(["verify", root, user, password]);
  if (code !== 0) return { ok: false, reason: (stdout || "验证失败").trim() };
  try {
    const r = JSON.parse(stdout.trim()) as { ok: boolean; reason?: string };
    return { ok: !!r.ok, reason: r.reason };
  } catch {
    return { ok: false, reason: "验证服务异常" };
  }
}

/** 修改密码：先验证旧密码，再写入新密码哈希（热生效，无需重启服务器） */
export async function changeAccountPassword(
  user: string,
  oldPassword: string,
  newPassword: string
): Promise<AccountOpResult> {
  const root = resolveRepoRoot();
  const v = await verifyAccount(user, oldPassword);
  if (!v.ok) return { ok: false, reason: "旧密码验证失败：" + (v.reason ?? "未知错误") };
  if (!newPassword || newPassword.length < 4) return { ok: false, reason: "新密码至少 4 位" };
  const { stdout, stderr, code } = await runCli(["set-password", root, user, newPassword]);
  if (code !== 0) return { ok: false, reason: (stderr || stdout || "修改失败").trim() };
  rememberAccountPassword(user, newPassword);
  return { ok: true, output: stdout };
}

/**
 * 登录并直达所选角色（对齐 EveJS-Launcher-V1 方案）：
 * 1) 本地验证账号密码（客户端同款哈希，只读数据库）
 * 2) 启动客户端并注入客户端原生参数
 *    /noconsole                → 不创建 [CCP] 调试控制台窗口
 *    /login:<user>:<password>  → GetLoginCredentials / TryAutomaticLogin 自动登录
 *    /autoSelectCharacter:<id> → 跳过角色选择，直接进入该角色
 */
export async function launchClientWithLogin(
  user: string,
  password: string,
  remember = false,
  characterId?: string | number
): Promise<AccountOpResult> {
  const v = await verifyAccount(user, password);
  if (!v.ok) return { ok: false, reason: v.reason ?? "账号或密码错误" };
  if (password.includes(":")) return { ok: false, reason: "密码不能包含冒号（客户端 /login: 参数限制）" };
  if (remember) rememberAccountPassword(user, password);
  const res = await startService("client", { login: { user, password, characterId } });
  if (!res.ok) return { ok: false, reason: res.reason ?? "客户端启动失败" };
  return {
    ok: true,
    output: characterId ? "登录成功，客户端直达角色" : "登录成功，客户端自动登录中"
  };
}

/** 使用创建账号时保存的安全凭据启动客户端，不把密码暴露给渲染层。 */
export async function launchStoredAccount(user: string, characterId?: string | number): Promise<AccountOpResult> {
  const password = storedAccountPassword(user);
  if (!password) return { ok: false, reason: "未找到已保存的登录凭据，请手动输入一次密码" };
  return launchClientWithLogin(user, password, false, characterId);
}
