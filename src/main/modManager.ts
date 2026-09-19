import * as fs from "fs";
import * as path from "path";
import { launcherRuntimeRoot } from "./runtimePaths";

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
}

export interface ModScanResult {
  ok: boolean;
  root: string;
  exists: boolean;
  mods: ModRecord[];
}

export interface LoaderPlan {
  /** 已启用、可注入的 loader.js（已排序，正斜杠路径） */
  paths: string[];
  /** 因为依赖/冲突/校验失败被跳过的模组 */
  skipped: Array<{ id: string; reason: string }>;
}

const MANIFEST_NAME = "evejs-launcher.mod.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const KINDS: ModKind[] = ["loader", "source-integrated", "client-package", "settings"];
const RESTART_VALUES = ["none", "game_server", "client", "launcher"];
const LOADER_ENABLED = "loader.js";
const LOADER_DISABLED = "loader.js.disabled";
const LOADER_DISABLED_ALT = ["loader.js.off", "loader.js.bak"];
const DEPENDENCY_FIELDS = ["requires", "loadAfter", "loadBefore", "conflicts"] as const;

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
    error
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

  record.valid = problems.length === 0;
  record.error = problems.join("；");
  if (!record.valid) record.supported = false;
  return record;
}

/** 扫描 <EveJS 根>/mods */
export function scanMods(repoRoot: string): ModScanResult {
  const root = modsRoot(repoRoot);
  const result: ModScanResult = { ok: true, root, exists: false, mods: [] };
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

  result.mods.sort((a, b) => a.displayName.localeCompare(b.displayName));
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
  const fallbackOrder = [...candidates].sort((a, b) => a.folder.localeCompare(b.folder));
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
/* ------------------------------------------------------------------ */
/* 内置模组制作规范文档：每次启动释放到 _launcher/mods/MOD_AUTHORING.md   */
/* ------------------------------------------------------------------ */

/** 释放目标：<启动器目录>/_launcher/mods/MOD_AUTHORING.md（文件名保持 ASCII） */
export function modAuthoringDocPath(): string {
  return path.join(launcherRuntimeRoot(), "mods", "MOD_AUTHORING.md");
}

/** 打包后的源文件：dist/main/main → dist/renderer/MOD_AUTHORING.md */
function packedAuthoringDocPath(): string {
  return path.join(__dirname, "..", "..", "renderer", "MOD_AUTHORING.md");
}

/**
 * 把内置规范写到 _launcher/mods/ 供模组作者查阅。
 * 内容一致时不写盘，避免每次启动都产生磁盘写入。
 */
export function ensureModAuthoringDoc(): { ok: boolean; path: string; written: boolean; reason?: string } {
  const target = modAuthoringDocPath();
  try {
    const source = fs.readFileSync(packedAuthoringDocPath(), "utf8");
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
