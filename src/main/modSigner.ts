import * as crypto from "crypto";
import { getAuthor } from "./authorStore";

/**
 * 模组清单签名校验（Ed25519）。
 *
 * 定位（见 docs/mod-signing-and-marketplace-plan.md §9）：
 *   签名 = 「来源标记 + 完整性校验」，**不是**防恶意模组。
 *   没有"官方 MOD"概念，所有签名者都是社区作者。
 *
 * 信任模型：
 *   - 只有一个**公钥信任表**（keyId -> ed25519 公钥）。私钥永远不进启动器。
 *   - 本机作者自己的公钥自动在表里 —— 所以你改自己模组 manifest 一个字符就会被抓到。
 *   - 后续（阶段 F）由「签名过的 mod-index.json」把各作者公钥注入本表（trustPublicKey）。
 *
 * 三态：
 *   none    —— manifest 没有 signature 字段（老模组 / 手工模组）→ 绝不拦截
 *   valid   —— 密钥可信且签名匹配 → 放行
 *   invalid —— 有签名字段但校验不通过 → 见 trusted 字段决定是否拦截
 *
 * trusted 的含义：
 *   true  —— 用的是**信任表里的密钥**，签名还不匹配 → 确定被篡改 → planLoaders 拦截
 *   false —— 密钥未知（可能是别的作者、也可能被换过密钥）→ 阶段 B 只红标警告，
 *            等阶段 F 索引公钥表接上后再升级为拦截，避免误伤手动安装的第三方签名模组
 */

export type SignatureState = "none" | "valid" | "invalid";

export interface SignatureVerdict {
  state: SignatureState;
  /** 签名里的 keyId（没有签名字段时为空串） */
  keyId: string;
  /** 密钥是否命中信任表 */
  trusted: boolean;
  reason: string;
}

export interface ManifestSignature {
  alg: "ed25519";
  keyId: string;
  /** base64 的 64 字节 Ed25519 签名 */
  sig: string;
  signedAt: string;
}

/**
 * 内置公钥表：**索引签名公钥**放这里（这是整个模组生态的信任根）。
 *
 * 怎么填：在索引仓库跑 node scripts/keygen.mjs --out .keys/index，
 * 脚本会直接打印一行 keyId + publicKeyBase64 —— 粘到下面即可。
 * 私钥不要放这里（也永远不要提交），它只存在你本机与 GitHub 仓库 Secret(INDEX_SIGNING_KEY) 里。
 *
 * 关于「官方」：这里不是「官方模组」认证 —— 它只证明这份 mod-index.json 是索引维护者签发的。
 */
const BUILTIN_PUBKEYS: Record<string, string> = {
  // 索引签名公钥（keygen 生成，2026-09-22）
  "944f9c6ed4b6": "9Q3MNumeqcdGAZuwNRjjWRAwZhrlz1P8HkGraes6+eM=",
};

/** 运行时注册的公钥（本机作者 + 签名索引） */
const runtimeKeys = new Map<string, string>();

/** ed25519 SPKI DER 的固定前缀，拼上 32 字节原始公钥即可还原 KeyObject */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_BYTES = 32;
/** base64 的 64 字节签名 */
const SIG_PATTERN = /^[A-Za-z0-9+/]{80,}={0,2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把一把公钥加进信任表 */
export function trustPublicKey(keyId: string, publicKeyBase64: string): void {
  const id = String(keyId || "").trim();
  const key = String(publicKeyBase64 || "").trim();
  if (!id || !key) return;
  runtimeKeys.set(id, key);
}

export function trustedKeyIds(): string[] {
  return Array.from(new Set([...Object.keys(BUILTIN_PUBKEYS), ...runtimeKeys.keys()]));
}

export function trustedPublicKey(keyId: string): string {
  return runtimeKeys.get(keyId) || BUILTIN_PUBKEYS[keyId] || "";
}

function keyObjectFromRaw(rawBase64: string): crypto.KeyObject | null {
  try {
    const raw = Buffer.from(rawBase64, "base64");
    if (raw.length !== RAW_KEY_BYTES) return null;
    return crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki"
    });
  } catch {
    return null;
  }
}

/** 递归按 key 升序（数组保持原序）——签名与验证必须用同一个函数 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/** manifest 去掉 signature 后的规范化 JSON */
export function canonicalManifestJson(manifest: Record<string, unknown>): string {
  const { signature: _omit, ...rest } = manifest;
  return JSON.stringify(canonicalize(rest));
}

/** 用私钥给 manifest 签名，返回 base64 */
export function signManifest(manifest: Record<string, unknown>, privateKey: crypto.KeyObject): string {
  const data = Buffer.from(canonicalManifestJson(manifest), "utf8");
  return crypto.sign(null, data, privateKey).toString("base64");
}

/** 确保本机作者的密钥在信任表里（失败不影响其它校验） */
function trustLocalAuthor(): void {
  try {
    const state = getAuthor();
    trustPublicKey(state.author.keyId, state.author.publicKey);
  } catch {
    /* 读不到作者身份就跳过 —— 不影响其余密钥的校验 */
  }
}

function readSignatureField(manifest: Record<string, unknown>): { sig: ManifestSignature | null; error: string } {
  const raw = manifest.signature;
  if (raw === undefined || raw === null) return { sig: null, error: "" };
  if (!isPlainObject(raw)) return { sig: null, error: "signature 格式非法（应为 {alg, keyId, sig}）" };
  const alg = typeof raw.alg === "string" ? raw.alg : "";
  const keyId = typeof raw.keyId === "string" ? raw.keyId.trim() : "";
  const sig = typeof raw.sig === "string" ? raw.sig.trim() : "";
  const signedAt = typeof raw.signedAt === "string" ? raw.signedAt : "";
  if (alg !== "ed25519") return { sig: null, error: "signature.alg 必须是 ed25519（当前：" + (alg || "缺失") + "）" };
  if (!keyId) return { sig: null, error: "signature.keyId 缺失" };
  if (!SIG_PATTERN.test(sig)) return { sig: null, error: "signature.sig 格式非法（应为 base64）" };
  return { sig: { alg: "ed25519", keyId, sig, signedAt }, error: "" };
}

/** 校验 manifest 的 signature 字段 */
export function verifyManifestSignature(manifest: Record<string, unknown>): SignatureVerdict {
  trustLocalAuthor();
  const { sig, error } = readSignatureField(manifest);
  if (!sig) {
    if (!error) return { state: "none", keyId: "", trusted: false, reason: "" };
    return { state: "invalid", keyId: "", trusted: false, reason: error };
  }

  // 清单里声明的作者 keyId 必须和签名用的 keyId 一致（防张冠李戴）
  const author = isPlainObject(manifest.author) ? manifest.author : null;
  const declaredKeyId = author && typeof author.keyId === "string" ? author.keyId.trim() : "";
  if (declaredKeyId && declaredKeyId !== sig.keyId) {
    return {
      state: "invalid",
      keyId: sig.keyId,
      trusted: true,
      reason: "清单 author.keyId 与 signature.keyId 不一致（" + declaredKeyId + " ≠ " + sig.keyId + "）"
    };
  }

  const publicKeyBase64 = trustedPublicKey(sig.keyId);
  if (!publicKeyBase64) {
    return {
      state: "invalid",
      keyId: sig.keyId,
      trusted: false,
      reason: "签名密钥不在信任列表（keyId " + sig.keyId + "）"
    };
  }

  const publicKey = keyObjectFromRaw(publicKeyBase64);
  if (!publicKey) {
    return { state: "invalid", keyId: sig.keyId, trusted: false, reason: "信任表里的公钥格式非法" };
  }

  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(canonicalManifestJson(manifest), "utf8"),
      publicKey,
      Buffer.from(sig.sig, "base64")
    );
  } catch (e) {
    return { state: "invalid", keyId: sig.keyId, trusted: true, reason: "签名验证异常：" + (e instanceof Error ? e.message : String(e)) };
  }

  return ok
    ? { state: "valid", keyId: sig.keyId, trusted: true, reason: "" }
    : { state: "invalid", keyId: sig.keyId, trusted: true, reason: "签名不匹配（manifest 已被修改）" };
}

/** 校验 mod-index.json 的官方索引签名 */
export function verifyIndexSignature(index: Record<string, unknown>): { ok: boolean; reason?: string } {
  const verdict = verifyManifestSignature(index);
  if (verdict.state === "valid") return { ok: true };
  if (verdict.state === "none") return { ok: false, reason: "索引没有签名（mod-index.json 必须由维护者签名）" };
  return { ok: false, reason: verdict.reason || "索引签名校验失败" };
}

export interface SignResult {
  ok: boolean;
  signature?: ManifestSignature;
  keyId?: string;
  reason?: string;
}

/** 用本机作者私钥给 manifest 签名（authorStore 负责私钥的读写与权限） */
export function signManifestWithAuthorKey(
  manifest: Record<string, unknown>,
  privateKey: crypto.KeyObject
): SignResult {
  let keyId = "";
  try {
    keyId = getAuthor().author.keyId;
  } catch (e) {
    return { ok: false, reason: "读不到本机作者身份：" + (e instanceof Error ? e.message : String(e)) };
  }
  if (!keyId) return { ok: false, reason: "本机作者身份没有 keyId" };
  try {
    const sig = signManifest(manifest, privateKey);
    return { ok: true, keyId, signature: { alg: "ed25519", keyId, sig, signedAt: new Date().toISOString() } };
  } catch (e) {
    return { ok: false, reason: "签名失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}