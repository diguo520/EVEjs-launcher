import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ensureLauncherRuntimePaths } from "./runtimePaths";

/**
 * 本机作者身份。
 *
 * 设计要点（见 docs/mod-signing-and-marketplace-plan.md §3）：
 *  - 署名（name）只是给人看的自由文本，谁都能填成别人的名字；
 *  - 认人的是 id（登记标识）与 keyId（Ed25519 公钥指纹）；
 *  - 真正的凭据是本机私钥：私钥只存在 _launcher/data/mod-keys/ 下，永不上传、永不打包；
 *  - 丢失私钥就无法再以同一 keyId 签发更新，所以必须支持「导出 .eve-key 备份 / 导入还原」。
 *
 * 私钥文件与 author.json 一律走 launcherRuntimePaths()，符合"所有产物都进 _launcher"的约定。
 */

export interface AuthorProfile {
  /** 本机首次使用时生成，之后不变。形如 au-<base36 毫秒时间戳><4 位随机尾缀>。 */
  id: string;
  /** 显示用署名，随时可改。 */
  name: string;
  /** 拿到这个身份的时间（毫秒）。 */
  since: number;
  /** Ed25519 公钥指纹前 12 位，签名的 keyId。 */
  keyId: string;
  /** base64 编码的 32 字节 Ed25519 原始公钥。 */
  publicKey: string;
  /** 相对 _launcher/data 的私钥路径，例如 mod-keys/9f3c1a77b2e4.key。 */
  privateKeyPath: string;
}

export interface AuthorState {
  ok: boolean;
  author: AuthorProfile;
  /** 私钥文件是否真的在磁盘上（被手动删掉时用于提示"无法再签名"）。 */
  privateKeyExists: boolean;
  /** 本机作者数据目录（_launcher/data）。 */
  dataDir: string;
  reason?: string;
}

export interface AuthorKeyResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  keyId?: string;
  reason?: string;
}

const AUTHOR_FILE = "author.json";
const KEY_DIR = "mod-keys";
const DEFAULT_NAME = "指挥官";
const ID_PATTERN = /^au-[a-z0-9]{6,32}$/i;
const ED25519_RAW_KEY_BYTES = 32;
const NOISE_WIDTH = 4;

function dataDir(): string {
  return ensureLauncherRuntimePaths().userData;
}

function authorFilePath(): string {
  return path.join(dataDir(), AUTHOR_FILE);
}

function keyDirPath(): string {
  return path.join(dataDir(), KEY_DIR);
}

export function authorDataDir(): string {
  return dataDir();
}

function mintAuthorId(): string {
  const stamp = Date.now().toString(36);
  const noise = Math.floor(Math.random() * Math.pow(36, NOISE_WIDTH))
    .toString(36)
    .padStart(NOISE_WIDTH, "0");
  return "au-" + stamp + noise;
}

/** 取 Ed25519 公钥的 32 字节原始值（SPKI DER 末尾就是原始公钥） */
function rawPublicKey(publicKey: crypto.KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return Buffer.from(spki.subarray(spki.length - ED25519_RAW_KEY_BYTES));
}

function keyIdFromRaw(raw: Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读私钥 PEM；读不到返回 "" */
function readPrivateKeyPem(profile: AuthorProfile | null): string {
  if (!profile || !profile.privateKeyPath) return "";
  const file = path.join(dataDir(), profile.privateKeyPath);
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 供后续阶段（签名）使用：拿到本机私钥的 KeyObject；失败返回 null */
export function readAuthorPrivateKey(): crypto.KeyObject | null {
  const profile = readAuthorFile();
  const pem = readPrivateKeyPem(profile);
  if (!pem) return null;
  try {
    return crypto.createPrivateKey(pem);
  } catch {
    return null;
  }
}

function readAuthorFile(): AuthorProfile | null {
  try {
    const raw = fs.readFileSync(authorFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const name = typeof parsed.name === "string" ? parsed.name : "";
    const keyId = typeof parsed.keyId === "string" ? parsed.keyId : "";
    const publicKey = typeof parsed.publicKey === "string" ? parsed.publicKey : "";
    const privateKeyPath = typeof parsed.privateKeyPath === "string" ? parsed.privateKeyPath : "";
    if (!id || !name || !keyId || !publicKey) return null;
    return {
      id,
      name,
      since: typeof parsed.since === "number" && parsed.since > 0 ? parsed.since : Date.now(),
      keyId,
      publicKey,
      privateKeyPath: privateKeyPath || path.join(KEY_DIR, keyId + ".key")
    };
  } catch {
    return null;
  }
}

function writeAuthorFile(profile: AuthorProfile): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(authorFilePath(), JSON.stringify(profile, null, 2) + "\n", "utf8");
}

/** 生成一套新的身份（id + Ed25519 密钥对）并落盘 */
function createAuthorProfile(name: string): AuthorProfile {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = rawPublicKey(publicKey);
  const keyId = keyIdFromRaw(raw);
  const privateKeyPath = path.join(KEY_DIR, keyId + ".key");

  fs.mkdirSync(keyDirPath(), { recursive: true });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  fs.writeFileSync(path.join(dataDir(), privateKeyPath), pem, { encoding: "utf8", mode: 0o600 });

  return {
    id: mintAuthorId(),
    name: (name || DEFAULT_NAME).trim() || DEFAULT_NAME,
    since: Date.now(),
    keyId,
    publicKey: raw.toString("base64"),
    privateKeyPath
  };
}

function toState(profile: AuthorProfile, reason?: string): AuthorState {
  return {
    ok: true,
    author: profile,
    privateKeyExists: readPrivateKeyPem(profile) !== "",
    dataDir: dataDir(),
    reason
  };
}

/** 读本机作者身份；没有就现建一套（id + 密钥对）并落盘 */
export function getAuthor(): AuthorState {
  const existing = readAuthorFile();
  if (existing) return toState(existing);
  const created = createAuthorProfile(DEFAULT_NAME);
  writeAuthorFile(created);
  return toState(created, "created");
}

/** 改署名。署名只是展示，不涉及密钥；注意改署名会让已有签名失效（后续阶段需重签）。 */
export function setAuthorName(name: string): AuthorState & { renamed?: boolean } {
  const state = getAuthor();
  const next = String(name ?? "").trim();
  if (!next) return { ...state, renamed: false, reason: "empty" };
  if (next === state.author.name) return { ...state, renamed: false };
  const updated: AuthorProfile = { ...state.author, name: next.slice(0, 64) };
  writeAuthorFile(updated);
  return { ...toState(updated), renamed: true };
}

/** .eve-key 文件的注释头 + PEM */
function buildKeyFileContent(profile: AuthorProfile, privateKeyPem: string): string {
  return [
    "# EveJS Launcher Author Key v1",
    "# 警告：本文件包含私钥，请勿分享给任何人。",
    "# 丢失后无法再以同一 keyId 签发更新；导入本文件即可在新机器上还原这个身份。",
    "# id: " + profile.id,
    "# name: " + profile.name,
    "# keyId: " + profile.keyId,
    "# since: " + String(profile.since),
    "# createdAt: " + new Date().toISOString(),
    privateKeyPem.trimEnd(),
    ""
  ].join("\n");
}

/** 导出 .eve-key（含私钥）到指定路径 */
export function exportAuthorKey(destPath: string): AuthorKeyResult {
  const state = getAuthor();
  const pem = readPrivateKeyPem(state.author);
  if (!pem) return { ok: false, reason: "私钥文件缺失，无法导出（请重建身份或导入备份）" };
  try {
    const file = /\.eve-key$/i.test(destPath) ? destPath : destPath + ".eve-key";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildKeyFileContent(state.author, pem), "utf8");
    return { ok: true, path: file, keyId: state.author.keyId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

interface ParsedKeyFile {
  pem: string;
  id: string;
  name: string;
  since: number;
  keyId: string;
}

function parseKeyFile(content: string): ParsedKeyFile | null {
  const text = String(content ?? "").replace(/^\uFEFF/, "");
  const begin = text.indexOf("-----BEGIN");
  const end = text.lastIndexOf("-----END");
  if (begin < 0 || end < 0 || end <= begin) return null;
  const lineEnd = text.indexOf("\n", end);
  const pem = text.slice(begin, lineEnd < 0 ? undefined : lineEnd).trim();

  const header = text.slice(0, begin);
  const pick = (key: string): string => {
    const m = new RegExp("^\\s*#\\s*" + key + "\\s*:\\s*(.+)$", "im").exec(header);
    return m ? m[1].trim() : "";
  };
  const sinceRaw = Number(pick("since"));
  return {
    pem,
    id: pick("id"),
    name: pick("name"),
    since: Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : Date.now(),
    keyId: pick("keyId")
  };
}

/** 从 .eve-key 导入并覆盖本机身份；导入前会把旧文件备份成 *.bak */
export function importAuthorKey(srcPath: string): AuthorKeyResult {
  let content = "";
  try {
    content = fs.readFileSync(srcPath, "utf8");
  } catch (error) {
    return { ok: false, reason: "读不到密钥文件：" + (error instanceof Error ? error.message : String(error)) };
  }

  const parsed = parseKeyFile(content);
  if (!parsed) return { ok: false, reason: "不是有效的 .eve-key 文件（缺少 PEM 私钥段）" };

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(parsed.pem);
  } catch (error) {
    return { ok: false, reason: "私钥无法解析：" + (error instanceof Error ? error.message : String(error)) };
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    return { ok: false, reason: "密钥类型不是 ed25519（当前：" + String(privateKey.asymmetricKeyType) + "）" };
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const raw = rawPublicKey(publicKey);
  const derivedKeyId = keyIdFromRaw(raw);
  if (parsed.keyId && parsed.keyId !== derivedKeyId) {
    // 头里的 keyId 和私钥实际指纹不一致：以私钥为准，但明确告知。
    return {
      ok: false,
      reason: "密钥指纹与文件头不一致（头 " + parsed.keyId + "，实际 " + derivedKeyId + "），已拒绝导入"
    };
  }

  // 备份现有文件，导入失败可回滚
  const backup = (file: string): void => {
    try {
      if (fs.existsSync(file)) fs.renameSync(file, file + ".bak");
    } catch {
      /* 备份失败不影响导入 */
    }
  };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(keyDirPath(), { recursive: true });
  backup(authorFilePath());

  const id = ID_PATTERN.test(parsed.id) ? parsed.id : mintAuthorId();
  const privateKeyPath = path.join(KEY_DIR, derivedKeyId + ".key");
  backup(path.join(dataDir(), privateKeyPath));

  const profile: AuthorProfile = {
    id,
    name: parsed.name || DEFAULT_NAME,
    since: parsed.since,
    keyId: derivedKeyId,
    publicKey: raw.toString("base64"),
    privateKeyPath
  };

  try {
    fs.writeFileSync(path.join(dataDir(), privateKeyPath), parsed.pem + "\n", { encoding: "utf8", mode: 0o600 });
    writeAuthorFile(profile);
  } catch (error) {
    return { ok: false, reason: "写入失败：" + (error instanceof Error ? error.message : String(error)) };
  }

  return { ok: true, path: srcPath, keyId: derivedKeyId };
}