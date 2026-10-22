#!/usr/bin/env node
/**
 * 把 PEM 私钥转成 Worker secret 要的形状：base64(PKCS8 DER) + keyId。
 *
 * 用法：
 *   node scripts/gen-license-key.mjs .keys/launcher-license-key.pem
 *   npx wrangler secret put LICENSE_SIGNING_KEY   # 粘第二段输出
 *   npx wrangler secret put LICENSE_KEY_ID        # 粘第三段输出
 *
 * keyId 由公钥算出（sha256(raw 32 字节).hex()[..12]），**不是自取的标签** ——
 * 所以它必须在这里现算，不能手填。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const input = process.argv[2]
if (!input) {
  console.error("用法：node scripts/gen-license-key.mjs <私钥.pem>")
  process.exit(2)
}

const pemPath = path.resolve(input)
const privateKey = crypto.createPrivateKey(fs.readFileSync(pemPath))
if (privateKey.asymmetricKeyType !== "ed25519") {
  console.error("这把不是 Ed25519 密钥：" + String(privateKey.asymmetricKeyType))
  process.exit(2)
}

const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" })
const raw = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12)
const keyId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12)

console.log("私钥来源：" + pemPath)
console.log("LICENSE_SIGNING_KEY=" + pkcs8.toString("base64"))
console.log("LICENSE_KEY_ID=" + keyId)
console.log("公钥（要内置进模组 LAUNCHER_KEYS 的那一段）：" + raw.toString("base64"))
