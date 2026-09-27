#!/usr/bin/env node
/**
 * 更新器维护者密钥工具（S3/A1 配套）。
 *
 * 背景：A1 要求「清单必须由编译进二进制的维护者公钥验签」，
 * 于是密钥生命周期变成三件事：生成 → 私钥进 CI Secret → 公钥写进 updater.rs 常量。
 * 这个脚本把三件事都做掉，并提供签名/验签用于本地升级演练（配合 EVEJS_UPDATE_ALLOW_LOCAL=1）。
 *
 * 用法：
 *   node scripts/gen-update-key.mjs                          # 生成密钥对（默认写 .keys/）
 *   node scripts/gen-update-key.mjs --from .keys/update-key.pem   # 从私钥推导公钥并打印常量
 *   node scripts/gen-update-key.mjs --from <pem> --check     # 校验 updater.rs 里的常量与该私钥一致
 *   node scripts/gen-update-key.mjs --sign manifest.json --key <pem> [--out signed.json]
 *   node scripts/gen-update-key.mjs --verify signed.json --key-id <id> --pubkey <base64>
 *
 * 签名负载（必须与 Rust 侧 canonical_manifest_json 逐字节一致）：
 *   JSON.stringify(递归按 key 排序(去掉顶层 signature 字段))
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const UPDATER_RS = path.join(ROOT, "src-tauri/src/updater.rs");
const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}
function value(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

/* ---------- 签名负载（与 Rust 逐字节对齐） ---------- */
function canonicalize(node) {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
}
function canonicalManifestJson(manifest) {
  const clone = { ...manifest };
  delete clone.signature;
  return JSON.stringify(canonicalize(clone));
}

/* ---------- 密钥编解码 ---------- */
const rawPublicKey = (publicKey) =>
  publicKey.export({ type: "spki", format: "der" }).subarray(-32);

function publicKeyBase64(privateKey) {
  return rawPublicKey(crypto.createPublicKey(privateKey)).toString("base64");
}
function publicKeyFromBase64(base64) {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 32) throw new Error("公钥必须是 32 字节 base64（Ed25519 raw）");
  // SPKI 前缀：Ed25519 OID + 32 字节原始公钥
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}
const signManifest = (privateKey, manifest) =>
  crypto.sign(null, Buffer.from(canonicalManifestJson(manifest), "utf8"), privateKey).toString("base64");
const verifyManifest = (publicKey, manifest) => {
  const signature = manifest?.signature?.sig;
  if (typeof signature !== "string") return false;
  const clone = { ...manifest };
  delete clone.signature;
  return crypto.verify(
    null,
    Buffer.from(canonicalManifestJson(clone), "utf8"),
    publicKey,
    Buffer.from(signature, "base64")
  );
};

function readConstants() {
  const source = fs.readFileSync(UPDATER_RS, "utf8");
  const keyId = (source.match(/pub const UPDATE_KEY_ID: &str = "([^"]*)"/) ?? [])[1];
  const pubkey = (source.match(/pub const UPDATE_PUBKEY: &str = "([^"]*)"/) ?? [])[1];
  if (keyId === undefined || pubkey === undefined) {
    throw new Error("updater.rs 里找不到 UPDATE_KEY_ID / UPDATE_PUBKEY 常量");
  }
  return { keyId, pubkey };
}

function printConstants(keyId, pubkey) {
  console.log("");
  console.log("把下面两行替换进 src-tauri/src/updater.rs：");
  console.log(`pub const UPDATE_KEY_ID: &str = "${keyId}";`);
  console.log(`pub const UPDATE_PUBKEY: &str = "${pubkey}";`);
  console.log("");
  console.log("私钥务必只放进 GitHub Actions Secret（例如 EVEJS_UPDATE_SIGNING_KEY），不要提交进仓库。");
}

/* ---------- 子命令 ---------- */
function generate() {
  const outDir = value("--out", path.join(ROOT, ".keys"));
  fs.mkdirSync(outDir, { recursive: true });
  const keyPath = path.join(outDir, "update-key.pem");
  if (fs.existsSync(keyPath) && !flag("--force")) {
    console.error(`已存在 ${keyPath}（要覆盖请加 --force）`);
    process.exit(1);
  }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  fs.writeFileSync(keyPath, pem, { encoding: "utf8", mode: 0o600 });
  const pubkey = publicKeyBase64(privateKey);
  const keyId = value("--key-id", "evejs-release-" + new Date().toISOString().slice(0, 10));
  console.log(`已生成私钥：${keyPath}`);
  console.log(`公钥（base64 raw）：${pubkey}`);
  printConstants(keyId, pubkey);
}

function fromPrivate() {
  const pemPath = value("--from");
  const privateKey = crypto.createPrivateKey(fs.readFileSync(pemPath));
  const pubkey = publicKeyBase64(privateKey);
  if (flag("--check")) {
    const current = readConstants();
    const ok = current.pubkey === pubkey && current.pubkey !== "";
    console.log(`updater.rs 内置公钥：${current.pubkey || "(空)"}`);
    console.log(`该私钥对应公钥：   ${pubkey}`);
    if (!ok) {
      console.error("不匹配：内置公钥与该私钥不是一对，或尚未配置。");
      process.exit(1);
    }
    console.log("匹配：可以用这把私钥签发更新清单。");
    return;
  }
  console.log(`公钥（base64 raw）：${pubkey}`);
  printConstants(value("--key-id", readConstants().keyId || "evejs-release"), pubkey);
}

function sign() {
  const manifestPath = value("--sign");
  const keyPath = value("--key", path.join(ROOT, ".keys/update-key.pem"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const keyId = value("--key-id", readConstants().keyId);
  if (!keyId) {
    console.error("缺少 keyId：请传 --key-id，或先在 updater.rs 配好 UPDATE_KEY_ID");
    process.exit(1);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const signed = {
    ...manifest,
    signature: { alg: "ed25519", keyId, sig: signManifest(privateKey, manifest) },
  };
  const outPath = value("--out", manifestPath.replace(/\.json$/, "") + ".signed.json");
  fs.writeFileSync(outPath, JSON.stringify(signed, null, 2) + "\n", "utf8");
  console.log(`已签名：${outPath}`);
  console.log(`  keyId=${keyId}`);
  console.log(`  sig=${signed.signature.sig.slice(0, 24)}…`);
}

function verify() {
  const manifestPath = value("--verify");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const keyId = value("--key-id", readConstants().keyId);
  const pubkey = value("--pubkey", readConstants().pubkey);
  if (!pubkey) {
    console.error("没有公钥：请传 --pubkey，或在 updater.rs 里配置 UPDATE_PUBKEY");
    process.exit(1);
  }
  const actualKeyId = manifest?.signature?.keyId;
  if (actualKeyId !== keyId) {
    console.error(`keyId 不匹配：清单是 ${actualKeyId}，期望 ${keyId}`);
    process.exit(1);
  }
  const ok = verifyManifest(publicKeyFromBase64(pubkey), manifest);
  console.log(ok ? "验签通过" : "验签失败：清单已被修改或不是该私钥签名");
  if (!ok) process.exit(1);
}

if (flag("--sign")) sign();
else if (flag("--verify")) verify();
else if (value("--from")) fromPrivate();
else generate();