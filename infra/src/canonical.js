/**
 * canonical JSON + Ed25519 签名 / 验签（只用 WebCrypto，Workers 与 Node 都能跑，零依赖）。
 *
 * 负载必须与 Rust 侧**逐字节一致**，否则启动器一定验签失败：
 *   - 规范化与取签名负载：`src-tauri/src/mods/sign.rs` 的 `canonicalize` / `canonical_manifest_json`
 *   - 验签：`src-tauri/src/mods/sign.rs` 的 `verify_signature_with_key`
 *   - 约定对齐的先例：`scripts/gen-update-key.mjs`（更新清单，同一套规则）
 *
 * 规则：摘掉顶层 `signature` → 递归按 key 升序 → `JSON.stringify`（紧凑、无空格）。
 *
 * ⚠️ 有两条隐含前提，改的时候别踩：
 *   1. key 必须是 ASCII。Rust 按 UTF-8 字节序排，JS 按 UTF-16 码元排，非 ASCII key 会分叉。
 *      本服务所有 key 都是硬编码的 ASCII 字面量。
 *   2. 数值只放整数（epoch 毫秒、人数）和两位小数以内的平均分。两种运行时都按
 *      「最短往返」格式化 double，常见取值一致；再精细的小数不去赌。
 */

/** Ed25519 SubjectPublicKeyInfo 前缀（OID 1.3.101.112）+ 32 字节原始公钥 */
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

const encoder = new TextEncoder()

/** Uint8Array → base64（不依赖 Buffer，Workers 里没有） */
export function bytesToBase64(bytes) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(text) {
  const binary = atob(String(text ?? "").trim())
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index)
  }
  return out
}

/** 递归按 key 升序（数组保持原序）——与 Rust 的 canonicalize 一一对应 */
export function canonicalize(node) {
  if (Array.isArray(node)) return node.map(canonicalize)
  if (node && typeof node === "object") {
    const out = {}
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key])
    return out
  }
  return node
}

/** 去掉顶层 signature 之后的规范化 JSON —— 这就是签名 / 验签的负载 */
export function canonicalJson(payload) {
  const clone = { ...payload }
  delete clone.signature
  return JSON.stringify(canonicalize(clone))
}

/** keyId = sha256(原始公钥).hex()[..12]，与 Rust `key_id_from_raw` 相同 */
export async function keyIdFromRaw(rawPublicKey) {
  const digest = await crypto.subtle.digest("SHA-256", rawPublicKey)
  const bytes = new Uint8Array(digest)
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex.slice(0, 12)
}

/**
 * 摊平导入公钥：Workers / Node 的 WebCrypto 都不收「裸 32 字节」，要自己拼 SPKI。
 * `crypto.subtle.importKey("raw", …)` 的 Ed25519 支持面还不够广，不用。
 */
async function importPublicKey(rawPublicKeyBase64) {
  const raw = base64ToBytes(rawPublicKeyBase64)
  if (raw.length !== 32) throw new Error("公钥必须是 32 字节 base64（Ed25519 raw）")
  const spki = new Uint8Array(SPKI_PREFIX.length + raw.length)
  spki.set(SPKI_PREFIX, 0)
  spki.set(raw, SPKI_PREFIX.length)
  return crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"])
}

async function importPrivateKey(privateKeyBase64) {
  return crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(privateKeyBase64),
    { name: "Ed25519" },
    false,
    ["sign"]
  )
}

/** 签名：返回可直接塞进负载的 `signature` 字段 */
export async function signPayload(privateKeyBase64, payload, keyId) {
  const key = await importPrivateKey(privateKeyBase64)
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    encoder.encode(canonicalJson(payload))
  )
  return {
    alg: "ed25519",
    keyId,
    sig: bytesToBase64(new Uint8Array(signature)),
  }
}

/** 给负载补上 signature 字段并返回新对象（不改入参） */
export async function signDocument(privateKeyBase64, payload, keyId) {
  const signature = await signPayload(privateKeyBase64, payload, keyId)
  return { ...payload, signature }
}

/** 验签：只校验「是不是这把公钥签的」，与 Rust `verify_signature_with_key` 同语义 */
export async function verifyPayload(rawPublicKeyBase64, payload) {
  const field = payload?.signature
  if (!field || field.alg !== "ed25519" || typeof field.sig !== "string") return false
  try {
    const key = await importPublicKey(rawPublicKeyBase64)
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      base64ToBytes(field.sig),
      encoder.encode(canonicalJson(payload))
    )
  } catch {
    return false
  }
}