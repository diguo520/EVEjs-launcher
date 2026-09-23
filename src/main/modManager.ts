import * as fs from "fs";
import * as path from "path";
import { shell } from "electron";
import { launcherRuntimeRoot } from "./runtimePaths";
import { execFile } from "child_process";
import { promisify } from "util";
import { verifyManifestSignature, signManifestWithAuthorKey, trustPublicKey, type SignatureState } from "./modSigner";
import { getAuthor, readAuthorPrivateKey } from "./authorStore";

/**
 * EveJS 模组（manifest schema 3）扫描与启停。
 *
 * 设计约束：**不改任何服务端文件**。
 *  - kind=loader 的模组通过 NODE_OPTIONS=--require 注入到 Node 服务端进程；
 *  - 启用/禁用只是把 loader.js.disabled ↔ loader.js 改名；
 *  - 服务端源码（server/src）完全不动。
 *
 * 规范参考：<EveJS 根>/_internal/docs/mod-authoring/manifest.md（Launcher 1.0.53+ 定义）
 */

export type ModKind = "loader" | "source-integrated" | "client-package" | "settings";

export interface ModRecord {
  folder: string;
  dir: string;
  manifestPath: string;
  id: string;
  displayName: string;
  version: string;
  description: string;
  kind: ModKind;
  restart: string;
  strategy: string;
  /** M1 是否支持启用/禁用（目前只有 loader + loader_rename） */
  supported: boolean;
  unsupportedReason: string;
  enabled: boolean;
  loaderFile: string | null;
  requires: string[];
  loadAfter: string[];
  loadBefore: string[];
  conflicts: string[];
  missingRequires: string[];
  activeConflicts: string[];
  valid: boolean;
  error: string;
  /** 模组目录占用字节数（递归统计） */
  sizeBytes: number;
  /** 目录内最新的文件改动时间（毫秒）；卡片上的「更新时间」 */
  updatedAt: number;
  /** 静态扫描 loader 里引用到的服务端模块文件名（冲突鉴定用，启发式） */
  modules: string[];
  /** 签名三态：none = 没有 signature 字段（老模组，绝不拦截） */
  signatureState: SignatureState;
  /** 签名失败原因（signatureState==="invalid" 时有值） */
  signatureError: string;
  /** 签名用的 keyId */
  signatureKeyId: string;
  /** 密钥是否命中信任表（false 时只警告不拦截，见 modSigner.ts 注释） */
  signatureTrusted: boolean;
  /** 清单 author.id（认人靠它）；老模组没有就是空串 */
  authorId: string;
  /** 清单 author.name（署名，仅展示） */
  authorName: string;
  /** 清单 category */
  category: string;
  /** 清单 tags */
  tags: string[];
  /** 来源："market" = 从模组市场下载安装；"local" = 本机创建/导入 */
  source: "market" | "local";
  /** 来源详情（source==="market" 时有值） */
  sourceRepo: string;
  sourceVersion: string;
}

/** 冲突种类：declared=清单声明；duplicate-id=重复 id；shared-module=引用同一服务端模块；missing-require=依赖缺失 */
export type ModConflictKind = "declared" | "duplicate-id" | "shared-module" | "missing-require";

export interface ModConflict {
  kind: ModConflictKind;
  /** 涉及的模组目录名 */
  folders: string[];
  /** 给玩家看的一句话说明 */
  detail: string;
  /** 渲染层本地化用：词条 key + 参数（{1} {2}…） */
  i18nKey: string;
  i18nArgs: string[];
  /** 是否两个模组都已启用（只有启用中的冲突才计入统计） */
  active: boolean;
}

export interface ModStats {
  total: number;
  enabled: number;
  disabled: number;
  conflicts: number;
  bytes: number;
}

export interface ModScanResult {
  ok: boolean;
  root: string;
  exists: boolean;
  mods: ModRecord[];
  stats: ModStats;
  conflicts: ModConflict[];
  /** 用户自定义排序（模组目录名数组） */
  order: string[];
}

export interface LoaderPlan {
  /** 已启用、可注入的 loader.js（已排序，正斜杠路径） */
  paths: string[];
  /** 因为依赖/冲突/校验失败被跳过的模组 */
  skipped: Array<{ id: string; reason: string }>;
}

const MANIFEST_NAME = "evejs-launcher.mod.json";
/** 来源标记：从市场安装时写入，用来区分「本机创建」与「模组市场」 */
const MOD_SOURCE_FILE = ".evejs-source.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const KINDS: ModKind[] = ["loader", "source-integrated", "client-package", "settings"];
const RESTART_VALUES = ["none", "game_server", "client", "launcher"];
const LOADER_ENABLED = "loader.js";
const LOADER_DISABLED = "loader.js.disabled";
const LOADER_DISABLED_ALT = ["loader.js.off", "loader.js.bak"];
const DEPENDENCY_FIELDS = ["requires", "loadAfter", "loadBefore", "conflicts"] as const;
const ORDER_FILE = "mod-order.json";
const execFileAsync = promisify(execFile);
/** 统计模块引用时忽略的通用文件名 */
const IGNORED_MODULE_TOKENS = new Set(["index.js", "main.js", "loader.js", "helper.js", "package.json"]);

export function modsRoot(repoRoot: string): string {
  return path.join(repoRoot, "mods");
}

function isPlainText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

/** id 只用于标识与依赖引用：必须是安全、无路径语义的文本 */
function isSafeId(value: unknown): value is string {
  if (!isPlainText(value, 128)) return false;
  const id = (value as string).trim();
  if (/[\\/]/.test(id)) return false;
  if (id === "." || id === "..") return false;
  if (/[\u0000-\u001f]/.test(id)) return false;
  if (/[ .]$/.test(id)) return false;
  return true;
}

function readDependencyArray(manifest: Record<string, unknown>, field: string): { value: string[]; error: string } {
  const raw = manifest[field];
  if (raw === undefined) return { value: [], error: "" };
  if (!Array.isArray(raw) || raw.length > 64) return { value: [], error: field + " 必须是数组且最多 64 项" };
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isPlainText(item, 128)) return { value: [], error: field + " 里的 id 非法" };
    const key = (item as string).trim().toLowerCase();
    if (seen.has(key)) return { value: [], error: field + " 存在重复 id" };
    seen.add(key);
  }
  return { value: raw.map((item) => (item as string).trim()), error: "" };
}

/** 递归统计目录占用字节数 */
/** 一次遍历同时算出占用字节数与「最新改动时间」（卡片上的更新时间用它） */
function dirStats(dir: string): { bytes: number; newest: number } {
  let bytes = 0;
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, newest: 0 };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = dirStats(full);
        bytes += sub.bytes;
        if (sub.newest > newest) newest = sub.newest;
      } else if (entry.isFile()) {
        const st = fs.statSync(full);
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch {
      /* 忽略读不到的条目 */
    }
  }
  return { bytes, newest };
}

/**
 * 启发式扫描 loader 源码：取形如 xxx.js 的字符串字面量。
 * 用于判断多个模组是否都在操作同一个服务端模块（社区模组冲突的主要来源）。
 */
function scanLoaderModules(dir: string): string[] {
  const candidates = [LOADER_ENABLED, ...LOADER_DISABLED_ALT, LOADER_DISABLED].map((name) => path.join(dir, name));
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return [];
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const match of source.matchAll(/["'`]([A-Za-z0-9_.-]+\.js)["'`]/g)) {
    const name = match[1];
    if (name.length < 5) continue;
    if (IGNORED_MODULE_TOKENS.has(name.toLowerCase())) continue;
    found.add(name);
  }
  return [...found].sort();
}

/** 用户自定义排序文件：_launcher/mods/mod-order.json */
function modOrderPath(): string {
  return path.join(launcherRuntimeRoot(), "mods", ORDER_FILE);
}

export function readModOrder(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(modOrderPath(), "utf8").replace(/^\uFEFF/, "")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { order?: unknown } | null)?.order;
    if (Array.isArray(list)) {
      return list.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    }
  } catch {
    /* 还没有自定义顺序 */
  }
  return [];
}

export function setModOrder(folders: string[]): { ok: boolean; reason?: string } {
  try {
    const dir = path.dirname(modOrderPath());
    fs.mkdirSync(dir, { recursive: true });
    const clean = (Array.isArray(folders) ? folders : [])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    fs.writeFileSync(modOrderPath(), JSON.stringify({ order: clean }, null, 2) + "\n", "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 冲突鉴定：声明互斥 + 重复 id + 引用同一服务端模块 + 依赖缺失 */
function detectConflicts(mods: ModRecord[]): ModConflict[] {
  const conflicts: ModConflict[] = [];
  const byId = new Map<string, ModRecord[]>();
  const declaredSeen = new Set<string>();
  for (const mod of mods) {
    const key = mod.id.toLowerCase();
    const list = byId.get(key) || [];
    list.push(mod);
    byId.set(key, list);
  }

  for (const [id, list] of byId) {
    if (list.length > 1) {
      conflicts.push({
        kind: "duplicate-id",
        folders: list.map((item) => item.folder),
        detail: "有 " + list.length + " 个模组使用了同一个 id「" + id + "」",
        i18nKey: "conflict.duplicateId",
        i18nArgs: [String(list.length), id],
        active: list.filter((item) => item.enabled).length > 1
      });
    }
  }

  for (const mod of mods) {
    for (const targetId of mod.conflicts) {
      const target = (byId.get(targetId.toLowerCase()) || [])[0];
      if (!target) continue;
      const pairKey = [mod.folder, target.folder].sort().join("|");
      if (declaredSeen.has(pairKey)) continue;
      declaredSeen.add(pairKey);
      conflicts.push({
        kind: "declared",
        folders: [mod.folder, target.folder],
        detail: "清单里声明了互斥",
        i18nKey: "conflict.declared",
        i18nArgs: [],
        active: mod.enabled && target.enabled
      });
    }
  }

  for (let i = 0; i < mods.length; i += 1) {
    for (let j = i + 1; j < mods.length; j += 1) {
      const shared = mods[i].modules.filter((name) => mods[j].modules.includes(name));
      if (shared.length === 0) continue;
      conflicts.push({
        kind: "shared-module",
        folders: [mods[i].folder, mods[j].folder],
        detail: "都引用了服务端模块 " + shared.join(", ") + "（可能互相影响）",
        i18nKey: "conflict.sharedModule",
        i18nArgs: [shared.join(", ")],
        active: mods[i].enabled && mods[j].enabled
      });
    }
  }

  for (const mod of mods) {
    if (mod.enabled && mod.missingRequires.length > 0) {
      conflicts.push({
        kind: "missing-require",
        folders: [mod.folder],
        detail: "缺少依赖 " + mod.missingRequires.join(", "),
        i18nKey: "conflict.missingRequire",
        i18nArgs: [mod.missingRequires.join(", ")],
        active: true
      });
    }
  }

  return conflicts;
}

function emptyRecord(folder: string, dir: string, manifestPath: string, error: string): ModRecord {
  return {
    folder,
    dir,
    manifestPath,
    id: folder,
    displayName: folder,
    version: "",
    description: "",
    kind: "loader",
    restart: "",
    strategy: "",
    supported: false,
    unsupportedReason: "",
    enabled: false,
    loaderFile: null,
    requires: [],
    loadAfter: [],
    loadBefore: [],
    conflicts: [],
    missingRequires: [],
    activeConflicts: [],
    valid: false,
    error,
    sizeBytes: 0,
    updatedAt: 0,
    modules: [],
    signatureState: "none",
    signatureError: "",
    signatureKeyId: "",
    signatureTrusted: false,
    source: "local",
    sourceRepo: "",
    sourceVersion: "",
    authorId: "",
    authorName: "",
    category: "",
    tags: []
  };
}

function readManifest(dir: string, manifestPath: string): { manifest: Record<string, unknown> | null; error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(manifestPath);
  } catch {
    return { manifest: null, error: "缺少 " + MANIFEST_NAME };
  }
  if (!stat.isFile()) return { manifest: null, error: MANIFEST_NAME + " 不是文件" };
  if (stat.size > MAX_MANIFEST_BYTES) return { manifest: null, error: MANIFEST_NAME + " 超过 1 MiB" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return { manifest: null, error: "清单 JSON 解析失败: " + (e instanceof Error ? e.message : String(e)) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { manifest: null, error: "清单必须是 JSON 对象" };
  return { manifest: parsed as Record<string, unknown>, error: "" };
}

/** 读取单个模组目录（校验 manifest schema 3） */
/** 读取市场安装标记（不存在就是本机创建/导入） */
function readModSource(dir: string): { source: "market" | "local"; sourceRepo: string; sourceVersion: string } {
  const fallback = { source: "local" as const, sourceRepo: "", sourceVersion: "" };
  try {
    const file = path.join(dir, MOD_SOURCE_FILE);
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    if (!parsed || parsed.source !== "market") return fallback;
    return {
      source: "market",
      sourceRepo: typeof parsed.repo === "string" ? parsed.repo : "",
      sourceVersion: typeof parsed.version === "string" ? parsed.version : ""
    };
  } catch {
    return fallback;
  }
}

export function readModDir(folder: string, dir: string): ModRecord {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  const { manifest, error } = readManifest(dir, manifestPath);
  if (!manifest) return emptyRecord(folder, dir, manifestPath, error);

  const record = emptyRecord(folder, dir, manifestPath, "");
  const problems: string[] = [];

  if (manifest.schemaVersion !== 3) problems.push("schemaVersion 必须是 3（当前 " + JSON.stringify(manifest.schemaVersion) + "）");
  if (!isSafeId(manifest.id)) problems.push("id 缺失或非法（≤128 字符、不能含路径分隔符）");
  if (!isPlainText(manifest.displayName, 100)) problems.push("displayName 缺失或超长（≤100）");
  if (!isPlainText(manifest.version, 64)) problems.push("version 缺失或超长（≤64）");
  if (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > 1000)) {
    problems.push("description 超长（≤1000）");
  }
  if (typeof manifest.kind !== "string" || !KINDS.includes(manifest.kind as ModKind)) {
    problems.push("kind 必须是 " + KINDS.join(" / "));
  }
  if (typeof manifest.restart !== "string" || !RESTART_VALUES.includes(manifest.restart)) {
    problems.push("restart 必须是 " + RESTART_VALUES.join(" / "));
  }
  const activation = manifest.activation;
  if (!activation || typeof activation !== "object" || Array.isArray(activation) || typeof (activation as Record<string, unknown>).strategy !== "string") {
    problems.push("缺少 activation.strategy");
  }

  const deps: Record<string, string[]> = {};
  for (const field of DEPENDENCY_FIELDS) {
    const result = readDependencyArray(manifest, field);
    if (result.error) problems.push(result.error);
    deps[field] = result.value;
  }

  record.id = isSafeId(manifest.id) ? (manifest.id as string).trim() : folder;
  record.displayName = isPlainText(manifest.displayName, 100) ? (manifest.displayName as string).trim() : folder;
  record.version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  record.description = typeof manifest.description === "string" ? manifest.description.trim() : "";
  record.kind = KINDS.includes(manifest.kind as ModKind) ? (manifest.kind as ModKind) : "loader";
  record.restart = typeof manifest.restart === "string" ? manifest.restart : "";
  record.strategy = activation && typeof activation === "object" ? String((activation as Record<string, unknown>).strategy || "") : "";
  record.requires = deps.requires;
  record.loadAfter = deps.loadAfter;
  record.loadBefore = deps.loadBefore;
  record.conflicts = deps.conflicts;

  for (const field of DEPENDENCY_FIELDS) {
    if (deps[field].some((value) => value.toLowerCase() === record.id.toLowerCase())) {
      problems.push(field + " 不能引用自己");
    }
  }

  const enabledLoader = path.join(dir, LOADER_ENABLED);
  const hasEnabled = fs.existsSync(enabledLoader);
  const disabledName = [LOADER_DISABLED, ...LOADER_DISABLED_ALT].find((name) => fs.existsSync(path.join(dir, name)));
  record.enabled = record.kind === "loader" ? hasEnabled : false;

  // M1 只实现 loader + loader_rename；其它 kind 明确标注"暂不支持"，绝不假装成功
  if (record.kind === "loader") {
    if (record.strategy !== "loader_rename") {
      record.supported = false;
      record.unsupportedReason = "activation.strategy 必须是 loader_rename";
    } else if (!hasEnabled && !disabledName) {
      record.supported = false;
      record.unsupportedReason = "缺少 loader.js / loader.js.disabled";
    } else {
      record.supported = true;
    }
    if (hasEnabled) record.loaderFile = enabledLoader;
  } else {
    record.supported = false;
    record.unsupportedReason =
      record.kind === "settings"
        ? "settings 类型需要 launcher 1.0.x 的 settings 表单（M2）"
        : record.kind === "client-package"
          ? "client-package 需要 helper verify/install（M2）"
          : "source-integrated 需要助手脚本操作服务端源码（M2）";
  }

  const authorBlock = manifest.author && typeof manifest.author === "object" ? (manifest.author as Record<string, unknown>) : null;
  record.authorId = authorBlock && typeof authorBlock.id === "string" ? authorBlock.id.trim() : "";
  record.authorName = authorBlock && typeof authorBlock.name === "string" ? authorBlock.name.trim() : "";
  record.category = typeof manifest.category === "string" ? manifest.category.trim() : "";
  record.tags = Array.isArray(manifest.tags) ? (manifest.tags.filter((t) => typeof t === "string") as string[]) : [];

  // 签名校验（Ed25519）：none 不拦截，invalid 且密钥可信才由 planLoaders 拦下
  // 作者自签名的清单会带上自己的 publicKey（keyId 必须与签名一致）。
  // 先把它注入信任表，下载方才能验证作者签名；没带 publicKey 的旧包仍按原逻辑处理。
  try {
    const sigBlock = manifest.signature && typeof manifest.signature === "object" ? (manifest.signature as Record<string, unknown>) : null;
    const sigKeyId = sigBlock && typeof sigBlock.keyId === "string" ? sigBlock.keyId.trim() : "";
    const authorBlockForTrust = manifest.author && typeof manifest.author === "object" ? (manifest.author as Record<string, unknown>) : null;
    const authorKeyId = authorBlockForTrust && typeof authorBlockForTrust.keyId === "string" ? authorBlockForTrust.keyId.trim() : "";
    const authorPublicKey = authorBlockForTrust && typeof authorBlockForTrust.publicKey === "string" ? authorBlockForTrust.publicKey.trim() : "";
    if (sigKeyId && authorPublicKey && (!authorKeyId || authorKeyId === sigKeyId)) {
      trustPublicKey(sigKeyId, authorPublicKey);
    }
  } catch {
    /* 信任注入失败就按原逻辑校验 */
  }
  const verdict = verifyManifestSignature(manifest);
  record.signatureState = verdict.state;
  record.signatureError = verdict.reason;
  record.signatureKeyId = verdict.keyId;
  record.signatureTrusted = verdict.trusted;

  record.valid = problems.length === 0;
  record.error = problems.join("；");
  if (!record.valid) record.supported = false;
  const dirInfo = dirStats(dir);
  record.sizeBytes = dirInfo.bytes;
  record.updatedAt = dirInfo.newest;
  record.modules = record.kind === "loader" ? scanLoaderModules(dir) : [];
  // 来源：市场下载安装 → market；本机创建/导入 → local
  const origin = readModSource(dir);
  record.source = origin.source;
  record.sourceRepo = origin.sourceRepo;
  record.sourceVersion = origin.sourceVersion;
  return record;
}

/** 扫描 <EveJS 根>/mods */
export function scanMods(repoRoot: string): ModScanResult {
  const root = modsRoot(repoRoot);
  const emptyStats: ModStats = { total: 0, enabled: 0, disabled: 0, conflicts: 0, bytes: 0 };
  const result: ModScanResult = { ok: true, root, exists: false, mods: [], stats: emptyStats, conflicts: [], order: [] };
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return result;
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  result.exists = true;
  const byId = new Map<string, ModRecord>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    // 没有清单的目录不是模组（可能是 .git / 文档 / 杂物目录），忽略
    if (!fs.existsSync(path.join(root, entry.name, MANIFEST_NAME))) continue;
    try {
      const record = readModDir(entry.name, path.join(root, entry.name));
      result.mods.push(record);
      byId.set(record.id.toLowerCase(), record);
    } catch {
      /* 单个目录失败不影响整体 */
    }
  }

  // 依赖/冲突检查（只做提示与注入拦截，M2 再做完整 resolver）
  for (const mod of result.mods) {
    mod.missingRequires = mod.requires.filter((id) => {
      const target = byId.get(id.toLowerCase());
      return !target || !target.valid || !target.enabled;
    });
    mod.activeConflicts = mod.conflicts.filter((id) => {
      const target = byId.get(id.toLowerCase());
      return !!target && target.enabled;
    });
  }

  // 自定义排序优先，其余按显示名
  const order = readModOrder();
  const rank = new Map(order.map((folder, index) => [folder, index]));
  result.mods.sort((a, b) => {
    const ra = rank.has(a.folder) ? (rank.get(a.folder) as number) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.folder) ? (rank.get(b.folder) as number) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.displayName.localeCompare(b.displayName);
  });

  result.order = result.mods.map((mod) => mod.folder);
  result.conflicts = detectConflicts(result.mods);
  result.stats = {
    total: result.mods.length,
    enabled: result.mods.filter((mod) => mod.enabled).length,
    disabled: result.mods.filter((mod) => !mod.enabled).length,
    conflicts: result.conflicts.filter((conflict) => conflict.active).length,
    bytes: result.mods.reduce((sum, mod) => sum + mod.sizeBytes, 0)
  };
  return result;
}

/** 计算要注入的 loader 顺序（loadAfter/loadBefore 拓扑排序，环则退回目录名顺序） */
export function planLoaders(repoRoot: string): LoaderPlan {
  const scan = scanMods(repoRoot);
  const plan: LoaderPlan = { paths: [], skipped: [] };
  const candidates = scan.mods.filter((mod) => {
    if (mod.kind !== "loader") return false;
    if (!mod.enabled) return false;
    if (!mod.valid) {
      plan.skipped.push({ id: mod.id, reason: "清单校验失败: " + mod.error });
      return false;
    }
    // 只有「密钥可信但签名不匹配」才拦截（确定被篡改）；密钥未知时只红标，见 modSigner.ts
    if (mod.signatureState === "invalid" && mod.signatureTrusted) {
      plan.skipped.push({ id: mod.id, reason: "签名校验失败: " + mod.signatureError });
      return false;
    }
    if (mod.missingRequires.length) {
      plan.skipped.push({ id: mod.id, reason: "缺少依赖: " + mod.missingRequires.join(", ") });
      return false;
    }
    if (mod.activeConflicts.length) {
      plan.skipped.push({ id: mod.id, reason: "与已启用模组冲突: " + mod.activeConflicts.join(", ") });
      return false;
    }
    if (!mod.loaderFile || !fs.existsSync(mod.loaderFile)) {
      plan.skipped.push({ id: mod.id, reason: "loader.js 不存在" });
      return false;
    }
    return true;
  });

  const byId = new Map(candidates.map((mod) => [mod.id.toLowerCase(), mod]));
  const edges = new Map<string, Set<string>>(); // key -> 必须先于 key 的集合
  for (const mod of candidates) {
    const key = mod.id.toLowerCase();
    const deps = edges.get(key) || new Set<string>();
    for (const id of mod.loadAfter) {
      const target = byId.get(id.toLowerCase());
      if (target) deps.add(target.id.toLowerCase());
    }
    edges.set(key, deps);
  }
  for (const mod of candidates) {
    for (const id of mod.loadBefore) {
      const target = byId.get(id.toLowerCase());
      if (!target) continue;
      const key = target.id.toLowerCase();
      const deps = edges.get(key) || new Set<string>();
      deps.add(mod.id.toLowerCase());
      edges.set(key, deps);
    }
  }

  const ordered: ModRecord[] = [];
  const state = new Map<string, number>(); // 0=未访问 1=访问中 2=完成
  let cycle = false;
  // candidates 已按 scanMods 的顺序（用户拖拽顺序）排列，保持不动
  const fallbackOrder = [...candidates];
  const visit = (key: string, stack: Set<string>): void => {
    const current = state.get(key);
    if (current === 2) return;
    if (current === 1) {
      cycle = true;
      return;
    }
    state.set(key, 1);
    stack.add(key);
    for (const dep of edges.get(key) || []) {
      if (stack.has(dep)) {
        cycle = true;
        continue;
      }
      visit(dep, stack);
    }
    stack.delete(key);
    state.set(key, 2);
    const mod = byId.get(key);
    if (mod && !ordered.includes(mod)) ordered.push(mod);
  };
  for (const mod of fallbackOrder) visit(mod.id.toLowerCase(), new Set<string>());

  const finalOrder = cycle ? fallbackOrder : ordered;
  plan.paths = finalOrder.map((mod) => (mod.loaderFile as string).replace(/\\/g, "/"));
  return plan;
}

/** 启用/禁用 loader 模组：只做文件改名 */
export interface ModUpdateResult {
  ok: boolean;
  id?: string;
  folder?: string;
  previousVersion?: string;
  newVersion?: string;
  backupDir?: string;
  reason?: string;
}

/** 看起来像「用户私有数据」的文件/目录：更新时要保留旧的（新包里的同名文件另存 .new） */
const USER_DATA_NAMES = ["settings.json", "preferences.json", "user-config.json", "profile", "profiles", "data", "config.json"];

/**
 * 覆盖更新一个已安装的模组（v1 漏掉的关键能力）。
 *
 * 步骤：解包到临时目录读清单 → 备份旧目录 → 导入新包 → 还原启用状态 → 还原用户私有数据 → 还原排序位置。
 * 备份留在 _launcher/temp/mod-backup/，失败可人工回滚。
 */
export async function updateMod(repoRoot: string, zipPath: string): Promise<ModUpdateResult> {
  if (!fs.existsSync(zipPath)) return { ok: false, reason: "ZIP 不存在：" + zipPath };

  // 1) 先解到临时目录，只为读出 id 与版本
  const probeDir = path.join(launcherRuntimeRoot(), "temp", "update-probe-" + Date.now());
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath " + psQuote(zipPath) + " -DestinationPath " + psQuote(probeDir) + " -Force"
    ], { timeout: 120000 });
  } catch (e) {
    return { ok: false, reason: "解包失败：" + (e instanceof Error ? e.message : String(e)) };
  }

  const root = findManifestRoot(probeDir);
  if (!root) {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return { ok: false, reason: "ZIP 里没有 " + MANIFEST_NAME };
  }
  const probe = readModDir(path.basename(root), root);
  const id = probe.id;
  const newVersion = probe.version;
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  if (!id) return { ok: false, reason: "ZIP 里的清单缺少 id" };

  const modsDir = modsRoot(repoRoot);
  const target = path.join(modsDir, id);
  const installed = fs.existsSync(target);

  // 没装过就直接当新装
  if (!installed) {
    const imported = await importModZip(repoRoot, zipPath);
    return { ok: imported.ok, id, folder: imported.folder || id, newVersion, reason: imported.reason };
  }

  const previous = readModDir(id, target);
  const wasEnabled = previous.enabled;
  const order = readModOrder();
  const orderIndex = order.findIndex((f) => f.toLowerCase() === id.toLowerCase());

  // 2) 备份旧目录
  const backupDir = path.join(launcherRuntimeRoot(), "temp", "mod-backup", id + "-" + (previous.version || "0") + "-" + Date.now());
  try {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.cpSync(target, backupDir, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, reason: "备份旧目录失败：" + (e instanceof Error ? e.message : String(e)) };
  }

  // 3) 导入新包（此时目标不存在，importModZip 会成功；它强制禁用）
  const imported = await importModZip(repoRoot, zipPath);
  if (!imported.ok) {
    // 回滚
    try {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(backupDir, target, { recursive: true });
    } catch { /* 回滚失败只能靠备份目录人工恢复 */ }
    return { ok: false, id, folder: id, previousVersion: previous.version, reason: "导入新版本失败（已回滚）：" + (imported.reason || "") };
  }

  // 4) 还原启用状态
  if (wasEnabled) {
    const disabled = path.join(target, LOADER_DISABLED);
    const enabled = path.join(target, LOADER_ENABLED);
    try {
      if (fs.existsSync(disabled) && !fs.existsSync(enabled)) fs.renameSync(disabled, enabled);
    } catch { /* 改名失败就保持禁用 */ }
  }

  // 5) 还原用户私有数据：新包里没有的照搬旧的；两边都有的把新的另存 .new（不覆盖用户改动）
  const restored: string[] = [];
  const keptAsNew: string[] = [];
  for (const name of USER_DATA_NAMES) {
    const oldPath = path.join(backupDir, name);
    if (!fs.existsSync(oldPath)) continue;
    const newPath = path.join(target, name);
    try {
      if (!fs.existsSync(newPath)) {
        fs.cpSync(oldPath, newPath, { recursive: true });
        restored.push(name);
      } else {
        fs.cpSync(newPath, newPath + ".new", { recursive: true });
        fs.rmSync(newPath, { recursive: true, force: true });
        fs.cpSync(oldPath, newPath, { recursive: true });
        keptAsNew.push(name);
      }
    } catch { /* 单个文件失败不影响整体 */ }
  }

  // 6) 还原排序位置（新目录名与 id 一致，只需保证它还在原下标）
  if (orderIndex >= 0) {
    try {
      const current = readModOrder().filter((f) => f.toLowerCase() !== id.toLowerCase());
      current.splice(Math.min(orderIndex, current.length), 0, id);
      setModOrder(current);
    } catch { /* 排序还原失败不影响更新结果 */ }
  }

  return {
    ok: true,
    id,
    folder: imported.folder || id,
    previousVersion: previous.version,
    newVersion,
    backupDir
  };
}

/** 在解包目录里找清单所在的那一层（ZIP 可能多套一层目录） */
function findManifestRoot(dir: string): string | null {
  if (fs.existsSync(path.join(dir, MANIFEST_NAME))) return dir;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    const nested = path.join(dir, dirs[0].name);
    if (fs.existsSync(path.join(nested, MANIFEST_NAME))) return nested;
  }
  return null;
}

/**
 * 读一个模组目录里的 README.md（详情弹窗用）。
 * 只读、限长，读不到就返回空串 —— 详情里没有说明也不是错误。
 */
export function readModReadme(repoRoot: string, folder: string): { ok: boolean; text: string; path: string; reason?: string } {
  const safe = safeFolderName(folder);
  const dir = path.join(modsRoot(repoRoot), safe || folder);
  const target = path.join(dir, "README.md");
  if (!fs.existsSync(dir)) return { ok: false, text: "", path: target, reason: "目录不存在" };
  const candidates = ["README.md", "readme.md", "Readme.md", "README.MD"];
  for (const name of candidates) {
    const file = path.join(dir, name);
    try {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").slice(0, 128 * 1024);
      return { ok: true, text, path: file };
    } catch {
      /* 换下一个候选文件名 */
    }
  }
  return { ok: false, text: "", path: target, reason: "没有 README.md" };
}

export interface ModSignResult {
  ok: boolean;
  keyId?: string;
  manifestPath?: string;
  /** 本次签名顺便把本机作者块写进了清单（原本没有作者块） */
  attachedAuthor?: boolean;
  reason?: string;
}

/**
 * 用本机作者私钥给一个模组目录的清单签名并写回。
 * - 签名前会重跑一遍清单校验，校验不过不给签；
 * - 清单里没有 author 块时补上本机作者（id / 署名 / keyId）；
 * - 写入的是去除旧 signature 后重新签名的结果（可反复执行）。
 */
export function signModFolder(repoRoot: string, folder: string): ModSignResult {
  const safeFolder = safeFolderName(folder);
  if (!safeFolder) return { ok: false, reason: "模组目录名非法" };
  const dir = path.join(modsRoot(repoRoot), safeFolder);
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { ok: false, reason: "找不到 " + MANIFEST_NAME };

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "清单必须是 JSON 对象" };
    }
    manifest = parsed as Record<string, unknown>;
  } catch (e) {
    return { ok: false, reason: "清单 JSON 解析失败: " + (e instanceof Error ? e.message : String(e)) };
  }

  const record = readModDir(safeFolder, dir);
  if (!record.valid) return { ok: false, reason: "清单校验失败: " + record.error };

  const privateKey = readAuthorPrivateKey();
  if (!privateKey) {
    return { ok: false, reason: "本机私钥不可用（请先在「作者身份」里建好身份，或导入 .eve-key）" };
  }

  // 归属保护（必须放在主进程）：渲染层的提示可以被绕过，直接调 IPC 也不该能改掉别人的署名
  let me = { id: "", name: "", keyId: "" };
  try {
    const a = getAuthor().author;
    me = { id: a.id, name: a.name, keyId: a.keyId };
  } catch {
    return { ok: false, reason: "读不到本机作者身份" };
  }
  const declared = manifest.author && typeof manifest.author === "object" ? (manifest.author as Record<string, unknown>) : null;
  const declaredAuthorId = declared && typeof declared.id === "string" ? declared.id.trim() : "";
  const declaredKeyId = declared && typeof declared.keyId === "string" ? declared.keyId.trim() : "";
  if (declaredAuthorId && declaredAuthorId !== me.id) {
    return {
      ok: false,
      reason: "这个模组的作者标识是 " + declaredAuthorId + "，不是本机作者（" + me.id + "），不能替别人签名"
    };
  }
  if (declaredKeyId && declaredKeyId !== me.keyId) {
    return {
      ok: false,
      reason: "清单里记的签名密钥（" + declaredKeyId + "）与本机密钥（" + me.keyId + "）不一致，拒绝签名"
    };
  }
  const attachedAuthor = !declared;

  const draft: Record<string, unknown> = { ...manifest };
  delete draft.signature;
  const existingAuthor = draft.author;
  if (!existingAuthor || typeof existingAuthor !== "object" || Array.isArray(existingAuthor)) {
    try {
      const author = getAuthor().author;
      draft.author = { id: author.id, name: author.name, keyId: author.keyId, publicKey: author.publicKey };
    } catch {
      /* 补作者块失败不阻断签名 */
    }
  }

  const signed = signManifestWithAuthorKey(draft, privateKey);
  if (!signed.ok || !signed.signature) return { ok: false, reason: signed.reason || "签名失败" };
  draft.signature = signed.signature;

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  } catch (e) {
    return { ok: false, reason: "写入失败: " + (e instanceof Error ? e.message : String(e)) };
  }
  return { ok: true, keyId: signed.keyId, manifestPath, attachedAuthor };
}

export function setModEnabled(repoRoot: string, folder: string, enabled: boolean): { ok: boolean; reason?: string; mod?: ModRecord } {
  const root = modsRoot(repoRoot);
  const dir = path.join(root, folder);
  if (!dir.startsWith(root)) return { ok: false, reason: "路径非法" };
  const record = readModDir(folder, dir);
  if (!record.valid) return { ok: false, reason: "清单校验失败: " + record.error };
  if (record.kind !== "loader" || record.strategy !== "loader_rename") {
    return { ok: false, reason: "M1 目前只支持 loader（loader_rename）模组的启停" };
  }
  const enabledPath = path.join(dir, LOADER_ENABLED);
  try {
    if (enabled) {
      if (fs.existsSync(enabledPath)) return { ok: true, mod: readModDir(folder, dir) };
      const source = LOADER_DISABLED_ALT.map((name) => path.join(dir, name)).find((p) => fs.existsSync(p))
        || (fs.existsSync(path.join(dir, LOADER_DISABLED)) ? path.join(dir, LOADER_DISABLED) : null);
      if (!source) return { ok: false, reason: "未找到 loader.js.disabled" };
      fs.renameSync(source, enabledPath);
    } else {
      if (!fs.existsSync(enabledPath)) return { ok: true, mod: readModDir(folder, dir) };
      const disabledPath = path.join(dir, LOADER_DISABLED);
      if (fs.existsSync(disabledPath)) return { ok: false, reason: LOADER_DISABLED + " 已存在，未做改动" };
      fs.renameSync(enabledPath, disabledPath);
    }
    return { ok: true, mod: readModDir(folder, dir) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function createModsFolder(repoRoot: string): { ok: boolean; root: string; reason?: string } {
  const root = modsRoot(repoRoot);
  try {
    fs.mkdirSync(root, { recursive: true });
    return { ok: true, root };
  } catch (e) {
    return { ok: false, root, reason: e instanceof Error ? e.message : String(e) };
  }
}
/**
 * 卸载模组：优先移入系统回收站（用户能自己还原），回收站不可用时才直接删除。
 * 只接受简单目录名，防止越权删除 mods/ 之外的目录。
 */
export async function uninstallMod(
  repoRoot: string,
  folder: string
): Promise<{ ok: boolean; folder?: string; dir?: string; trashed?: boolean; reason?: string }> {
  const safe = String(folder || "").trim();
  if (!safe || /[\\/]/.test(safe) || safe === "." || safe === "..") return { ok: false, reason: "目录名非法" };
  const dir = path.join(modsRoot(repoRoot), safe);
  if (!fs.existsSync(dir)) return { ok: false, reason: "目录不存在：" + dir };

  // 先禁用，避免服务端仍按启用状态引用它
  try {
    const enabled = path.join(dir, LOADER_ENABLED);
    if (fs.existsSync(enabled)) fs.renameSync(enabled, path.join(dir, LOADER_DISABLED));
  } catch {
    /* 禁用失败不影响卸载 */
  }

  try {
    await shell.trashItem(dir);
    return { ok: true, folder: safe, dir, trashed: true };
  } catch {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, folder: safe, dir, trashed: false };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e), dir };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 内置模组制作规范文档：每次启动释放到 _launcher/mods/MOD_AUTHORING.md   */
/* ------------------------------------------------------------------ */

/** 释放目标：<启动器目录>/_launcher/mods/MOD_AUTHORING.md（文件名保持 ASCII） */
/** 支持中/英两份：zh → MOD_AUTHORING.md，其它语言 → MOD_AUTHORING.en.md（读不到时回退中文） */
const DOC_LANGS = ["zh", "en"] as const;
type DocLang = (typeof DOC_LANGS)[number];
function normalizeDocLang(lang?: string): DocLang {
  return String(lang || "").toLowerCase() === "zh" ? "zh" : "en";
}
function docFileName(lang?: string): string {
  return normalizeDocLang(lang) === "zh" ? "MOD_AUTHORING.md" : "MOD_AUTHORING.en.md";
}

export function modAuthoringDocPath(lang?: string): string {
  return path.join(launcherRuntimeRoot(), "mods", docFileName(lang));
}

/** 打包后的源文件：dist/main/main → dist/renderer/MOD_AUTHORING*.md */
function packedAuthoringDocPath(lang?: string): string {
  return path.join(__dirname, "..", "..", "renderer", docFileName(lang));
}

/**
 * 把内置规范写到 _launcher/mods/ 供模组作者查阅。
 * 内容一致时不写盘，避免每次启动都产生磁盘写入。
 */
/** 读取文档正文（给启动器内嵌 Markdown 阅读器用） */
export function readModAuthoringDocText(lang?: string): { ok: boolean; text?: string; path?: string; reason?: string } {
  let doc = ensureModAuthoringDoc(lang);
  // 英文文档缺失时回退中文，至少让用户看到内容
  if (!doc.ok && normalizeDocLang(lang) === "en") doc = ensureModAuthoringDoc("zh");
  if (!doc.ok) return { ok: false, reason: doc.reason, path: doc.path };
  try {
    return { ok: true, text: fs.readFileSync(doc.path, "utf8"), path: doc.path };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), path: doc.path };
  }
}

/** 启动时把中/英两份都释放到 _launcher/mods/ */
export function ensureAllModAuthoringDocs(): void {
  for (const lang of DOC_LANGS) {
    try {
      ensureModAuthoringDoc(lang);
    } catch {
      /* 单份失败不影响启动 */
    }
  }
}

export function ensureModAuthoringDoc(lang?: string): { ok: boolean; path: string; written: boolean; reason?: string } {
  const target = modAuthoringDocPath(lang);
  const packed = packedAuthoringDocPath(lang);
  try {
    const source = fs.readFileSync(packed, "utf8");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let current = "";
    try {
      current = fs.readFileSync(target, "utf8");
    } catch {
      /* 首次释放 */
    }
    if (current === source) return { ok: true, path: target, written: false };
    fs.writeFileSync(target, source, "utf8");
    return { ok: true, path: target, written: true };
  } catch (e) {
    return { ok: false, path: target, written: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* ZIP 导入                                                            */
/* ------------------------------------------------------------------ */

export interface ModImportResult {
  ok: boolean;
  folder?: string;
  id?: string;
  displayName?: string;
  disabledAfterImport?: boolean;
  reason?: string;
}

/** PowerShell 单引号字符串转义 */
function psQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** 目录名安全化：把不允许的字符换成 - */
function safeFolderName(value: string): string {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 80);
  return cleaned;
}

/**
 * 从 ZIP 导入模组：
 * 解压 → 定位 evejs-launcher.mod.json → 校验 → 复制到 <EveJS 根>/mods/<id>
 * 导入后强制为「禁用」状态（把 loader.js 改回 loader.js.disabled），避免用户意外启用未知模组。
 */
export async function importModZip(repoRoot: string, zipPath: string): Promise<ModImportResult> {
  const zip = path.resolve(String(zipPath || ""));
  if (!zip || !fs.existsSync(zip)) return { ok: false, reason: "找不到 ZIP 文件" };
  if (path.extname(zip).toLowerCase() !== ".zip") return { ok: false, reason: "只支持 .zip 文件" };

  const tempRoot = path.join(launcherRuntimeRoot(), "temp", "mod-import-" + Date.now());
  try {
    fs.mkdirSync(tempRoot, { recursive: true });
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
       "Expand-Archive -LiteralPath " + psQuote(zip) + " -DestinationPath " + psQuote(tempRoot) + " -Force"],
      { timeout: 180_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );

    // 定位包根：根目录有清单 → 用它；否则找唯一一个含清单的子目录
    let packageRoot = tempRoot;
    if (!fs.existsSync(path.join(packageRoot, MANIFEST_NAME))) {
      const dirs = fs.readdirSync(tempRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "__MACOSX")
        .map((entry) => path.join(tempRoot, entry.name))
        .filter((dir) => fs.existsSync(path.join(dir, MANIFEST_NAME)));
      if (dirs.length !== 1) {
        return { ok: false, reason: dirs.length === 0 ? "ZIP 里没有 evejs-launcher.mod.json" : "ZIP 里有多个模组包，请一次只导入一个" };
      }
      packageRoot = dirs[0];
    }

    const manifestPath = path.join(packageRoot, MANIFEST_NAME);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, reason: "清单 JSON 解析失败: " + (e instanceof Error ? e.message : String(e)) };
    }

    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    const folder = safeFolderName(id) || safeFolderName(path.basename(zip, ".zip")) || "imported-mod";
    const target = path.join(modsRoot(repoRoot), folder);
    if (fs.existsSync(target)) return { ok: false, reason: "已存在同名模组目录：" + folder };

    fs.mkdirSync(modsRoot(repoRoot), { recursive: true });
    fs.cpSync(packageRoot, target, { recursive: true });

    // 强制禁用
    let disabledAfterImport = false;
    const enabledLoader = path.join(target, LOADER_ENABLED);
    const disabledLoader = path.join(target, LOADER_DISABLED);
    if (fs.existsSync(enabledLoader) && !fs.existsSync(disabledLoader)) {
      try {
        fs.renameSync(enabledLoader, disabledLoader);
        disabledAfterImport = true;
      } catch {
        /* 改名失败就保持原状 */
      }
    }

    const record = readModDir(folder, target);
    return { ok: true, folder, id: record.id, displayName: record.displayName, disabledAfterImport };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响导入结果 */
    }
  }
}
