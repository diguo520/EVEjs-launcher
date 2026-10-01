#!/usr/bin/env node
/**
 * 评价快照的维护者密钥工具（`infra/` 服务配套）。
 *
 * 为什么**必须**与更新清单用两把不同的钥匙：
 *   自更新那把私钥能签出「让启动器替换自己」的清单，泄露 = 别人可以给你推恶意更新。
 *   评价这把私钥要放进 Cloudflare 的 secret（服务的签名是定时任务在隔离环境里做的），
 *   泄露的后果必须止步于「评分能被伪造」，绝不能连坐到代码执行。
 *   所以这里刻意**不复用** `.keys/update-key.pem`。
 *
 * 生命周期三件事（与 `scripts/gen-update-key.mjs` 同一个形状）：
 *   生成 → 私钥进 Cloudflare secret + GitHub Actions Secret → 公钥写进 ratings.rs 常量。
 *
 * 用法：
 *   node scripts/gen-ratings-key.mjs                        # 生成密钥对（默认 .keys/ratings-key.pem）
 *   node scripts/gen-ratings-key.mjs --from <pem>            # 从私钥推导公钥并打印要填的常量
 *   node scripts/gen-ratings-key.mjs --from <pem> --check    # 校验 ratings.rs 里的常量与该私钥一致
 *   node scripts/gen-ratings-key.mjs --secret --from <pem>   # 打印 base64(PKCS8 DER)，给人看的（带标签行）
 *   node scripts/gen-ratings-key.mjs --secret-raw --from <pem>  # 只吐那一行 base64，喂给管道/$(...) 用这个
 *   node scripts/gen-ratings-key.mjs --from <pem> --check-live <url>  # 拿内置常量验线上快照（排查「启动器没星级」）
 *
 * 签名负载：`JSON.stringify(递归按 key 升序(去掉顶层 signature))`，与
 * `infra/src/canonical.js` / Rust `canonical_manifest_json` 逐字节一致。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { verifyPayload } from "../infra/src/canonical.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RATINGS_RS = path.join(ROOT, "src-tauri", "src", "mods", "ratings.rs");
const args = process.argv.slice(2);

const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const rawPublicKey = (publicKey) => publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const publicKeyBase64 = (privateKey) => rawPublicKey(crypto.createPublicKey(privateKey)).toString("base64");

/** keyId = sha256(原始公钥).hex()[..12]（与 Rust key_id_from_raw / infra keyIdFromRaw 相同） */
const keyIdOf = (privateKey) =>
  crypto.createHash("sha256").update(rawPublicKey(crypto.createPublicKey(privateKey))).digest("hex").slice(0, 12);

function readConstants() {
  const source = fs.readFileSync(RATINGS_RS, "utf8");
  const keyId = (source.match(/pub const RATINGS_KEY_ID: &str = "([^"]*)"/) ?? [])[1];
  const pubkey = (source.match(/pub const RATINGS_PUBKEY: &str = "([^"]*)"/) ?? [])[1];
  if (keyId === undefined || pubkey === undefined) {
    throw new Error("ratings.rs 里找不到 RATINGS_KEY_ID / RATINGS_PUBKEY 常量");
  }
  return { keyId, pubkey };
}

function printConstants(keyId, pubkey) {
  console.log("");
  console.log("把下面两行替换进 src-tauri/src/mods/ratings.rs：");
  console.log(`pub const RATINGS_KEY_ID: &str = "${keyId}";`);
  console.log(`pub const RATINGS_PUBKEY: &str = "${pubkey}";`);
  console.log("");
  console.log("同一个 keyId 还要作为 Cloudflare secret 设上去：");
  console.log("  npx wrangler secret put RATINGS_KEY_ID");
  console.log("  npx wrangler secret put RATINGS_SIGNING_KEY   # 值见 --secret 的输出");
}

function generate() {
  const outDir = value("--out", path.join(ROOT, ".keys"));
  const keyPath = path.join(outDir, "ratings-key.pem");
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(keyPath) && !flag("--force")) {
    console.error(`已存在 ${keyPath}（要覆盖请加 --force）`);
    process.exit(1);
  }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`已生成私钥：${keyPath}`);
  console.log(`公钥（base64 raw）：${publicKeyBase64(privateKey)}`);
  printConstants(value("--key-id", "evejs-ratings-" + new Date().toISOString().slice(0, 10)), publicKeyBase64(privateKey));
}

async function fromPrivate() {
  const pemPath = value("--from");
  const privateKey = crypto.createPrivateKey(fs.readFileSync(pemPath));

  // 只吐值本身：`--secret` 的第一行是给人看的标签，用管道取「第一行」会取到中文标签，
  // Worker 里就成了一把坏私钥（而健康检查当时只判非空，照样报 true）。要自动化就用这个。
  if (flag("--secret-raw")) {
    console.log(privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
    return;
  }

  if (flag("--secret")) {
    // Cloudflare secret 用 base64(PKCS8 DER)：WebCrypto 的 importKey("pkcs8", …) 直接吃它，
    // 不用在 Worker 里解析 PEM
    const der = privateKey.export({ type: "pkcs8", format: "der" });
    console.log("RATINGS_SIGNING_KEY（base64 PKCS8 DER，粘贴时不要带换行）：");
    console.log(der.toString("base64"));
    console.log("");
    const current = readConstants();
    console.log(`RATINGS_KEY_ID 应为：${current.keyId || "(尚未配置)"}`);
    return;
  }

  const pubkey = publicKeyBase64(privateKey);
  if (flag("--check")) {
    const current = readConstants();
    console.log(`ratings.rs 内置公钥：${current.pubkey || "(空)"}`);
    console.log(`该私钥对应公钥：   ${pubkey}`);
    if (current.pubkey !== pubkey || current.pubkey === "") {
      console.error("不匹配：内置公钥与该私钥不是一对，或尚未配置。");
      process.exit(1);
    }
    console.log("匹配。");
    console.log(`公钥指纹（核对是不是同一把钥匙用）：${keyIdOf(privateKey)}`);
    console.log(`keyId 推不出来，它只是个名字：ratings.rs 现在写的是「${current.keyId || "(空)"}」，`);
    console.log("Cloudflare 的 RATINGS_KEY_ID 必须与它逐字相同，对不上启动器会判「签名密钥不受信任」。");
    return;
  }

  const liveUrl = value("--check-live");
  if (liveUrl) {
    await checkLive(liveUrl, pubkey);
    return;
  }

  console.log(`公钥（base64 raw）：${pubkey}`);
  printConstants(value("--key-id", readConstants().keyId || keyIdOf(privateKey)), pubkey);
}

/**
 * 线上核对：拿启动器内置的（公钥, keyId）去验 Worker 下发的快照。
 * Worker 的 secret 与 ratings.rs 是两个地方，最容易在这儿对不上；
 * 「启动器不显示星级」先跑这条，能直接判掉「是不是同一对钥匙、keyId 是不是同一个名字」。
 */
async function checkLive(url, pubkey) {
  const expected = readConstants();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    console.error(`取快照失败：HTTP ${response.status} ${url}`);
    process.exit(1);
  }
  const payload = await response.json();
  const liveKeyId = payload?.signature?.keyId ?? "";
  const builtinKeyId = expected.keyId || "";
  console.log(`线上 keyId：${liveKeyId || "(没有 signature 字段)"}`);
  console.log(`内置 keyId：${builtinKeyId || "(空)"}`);
  console.log(`内置公钥：  ${expected.pubkey || "(空)"}`);
  if (liveKeyId !== builtinKeyId) {
    console.error("keyId 对不上：Cloudflare 的 RATINGS_KEY_ID 与 ratings.rs 不是同一个名字，启动器会判「签名密钥不受信任」。");
    process.exit(1);
  }
  if (!(await verifyPayload(pubkey, payload))) {
    console.error("验签失败：线上快照不是这把私钥签的（或者两边规范化规则被改过）。");
    process.exit(1);
  }
  const mods = Object.keys(payload.mods ?? {}).length;
  console.log(`验签通过。generatedAt=${new Date(Number(payload.generatedAt)).toISOString()}，有评分的模组 ${mods} 个。`);
}

if (value("--from")) await fromPrivate();
else generate();