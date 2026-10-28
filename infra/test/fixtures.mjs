/**
 * infra 测试的共用夹具（2026-10-29 复核判定「该合但不阻塞」，本轮补做）。
 *
 * `identity()` 在 `admin.test.mjs` / `sponsors.test.mjs` / `worker.test.mjs` 里**逐字相同**
 * （各 9 行）：一对真能用的 Ed25519 身份 —— 公钥 base64、keyId、PKCS8 私钥 base64。
 * 它依赖的两个编码函数在 `../src/canonical.js`，所以这个夹具模块也带上那条 import。
 */
import { bytesToBase64, keyIdFromRaw } from "../src/canonical.js"

/** 一对真能用的 Ed25519 身份：私钥进 env、公钥拿来验签 */
export async function identity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    publicKey: bytesToBase64(raw),
    keyId: await keyIdFromRaw(raw),
    pkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  }
}
