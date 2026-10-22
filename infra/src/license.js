/**
 * 启动器许可（grant）签发。
 *
 * 契约冻结在 v1（模组侧改动单 §2、模组侧改动清单 §2）：
 *   - `v` 恒为 1，**永不升版**；加能力只加可选字段
 *   - 许可是**多签数组** `sigs:[{keyId,sig}]`，任一条验过即可（启动器换钥匙时用新旧两把同时签）
 *   - 签名负载 = **去掉 `sigs`** 的规范化 JSON（递归 key 升序、紧凑、UTF-8）
 *   - `keyId = sha256(raw 32 字节公钥).hex()[..12]`
 *
 * 三处刻意的设计：
 *   1. **fail closed**：没配 `LICENSE_SIGNING_KEY` / `LICENSE_KEY_ID` 就 503 ——
 *      接口默认是关的，配了才开（与 `admin.js` 同一条约定）。
 *   2. **版本闸门**：请求里的 `launcherVersion` 低于最低要求就拒绝签发。
 *      于是旧启动器拿不到许可 → 模组在 enforce 下对它失效 →
 *      **必须更新启动器才能用模组**（这就是「强制更新」的实现，不需要模组改行为）。
 *   3. **`mods` 白名单**：许可里**显式**列出授权的 mod id。**不要省略这个字段** ——
 *      模组侧的判定是「`mods` 存在且不含我 → 拒绝」，省略等于授权一切。
 */
import { signGrant } from "./canonical.js"

/** 签发路由。要隐蔽就改这一处（启动器侧 DEFAULT_LICENSE_URL 必须同步）。 */
export const LICENSE_PATH = "/launcher/license"

/** 契约版本，恒为 1 */
export const LICENSE_SCHEMA = 1

export const LAUNCHER_ID = "evejs-launcher"

/** 默认授权范围：主模组 + 作者随包带的三个 parts（各自 gate 自己的 id）。 */
export const DEFAULT_MODS = Object.freeze([
  "evejs-faction-sim",
  "evejs-npc-fleet",
  "evejs-perf-fix",
  "evejs-captains-quarters",
])

/** 低于这个版本一律拒签（强制更新）；可用 LICENSE_MIN_LAUNCHER_VERSION 覆盖。 */
export const DEFAULT_MIN_LAUNCHER_VERSION = "0.5.5"

/**
 * 许可有效期。短一点更安全：泄漏的许可会自己过期。
 *
 * **90 天，不是 30 天**：国内到 ping.5318.cm 的链路实测 8–30 秒、还会偶发超时，
 * 而启动器是「距过期两周内、每次启动试一次」。有效期太短会把偶发的网络失败
 * 放大成「许可过期 → enforce 下模组对该用户失效」。宁可让泄漏窗口长一点。
 */
export const DEFAULT_TTL_DAYS = 90

export const MAX_BODY_BYTES = 4 * 1024

const INSTALL_ID_RE = /^[A-Za-z0-9._-]{8,64}$/
const MACHINE_HASH_RE = /^[0-9a-f]{32}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/

function versionParts(text) {
  const parts = String(text ?? "").trim().split(".")
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) return null
  return parts.map(Number)
}

/** 版本比较：a 严格小于 b 时为真；任一侧读不懂就当「不旧」（不误伤）。 */
export function isOlderThan(version, minimum) {
  const a = versionParts(version)
  const b = versionParts(minimum)
  if (!a || !b) return false
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left < right
  }
  return false
}

/** 私钥与 keyId 的就绪状态；缺任何一项都 fail closed。 */
export function licenseState(env) {
  const signingKey = String(env?.LICENSE_SIGNING_KEY ?? "").trim()
  const keyId = String(env?.LICENSE_KEY_ID ?? "").trim()
  if (!signingKey || !keyId) {
    return {
      ok: false,
      status: 503,
      reason: "许可接口未启用：Worker 里没配 LICENSE_SIGNING_KEY / LICENSE_KEY_ID",
    }
  }
  return { ok: true, signingKey, keyId }
}

/** 授权范围与闸门参数：可用环境变量覆盖，缺省是代码里这份。 */
export function licensePolicy(env) {
  const list = String(env?.LICENSE_MODS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const minLauncherVersion =
    String(env?.LICENSE_MIN_LAUNCHER_VERSION ?? "").trim() || DEFAULT_MIN_LAUNCHER_VERSION
  const parsedTtl = Number(env?.LICENSE_TTL_DAYS ?? DEFAULT_TTL_DAYS)
  const ttlDays = Number.isFinite(parsedTtl) && parsedTtl > 0 ? Math.floor(parsedTtl) : DEFAULT_TTL_DAYS
  return { mods: list.length ? list : DEFAULT_MODS, minLauncherVersion, ttlDays }
}

/** 校验请求体：只收这三个字段，形状不对就带着原因拒掉。 */
export function readLicenseRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "请求体不是一个对象" }
  }
  const installId = String(input.installId ?? "").trim()
  if (!INSTALL_ID_RE.test(installId)) {
    return { ok: false, reason: "installId 形状不对（8-64 位字母数字 . _ -）" }
  }
  const machineHash = String(input.machineHash ?? "").trim().toLowerCase()
  if (!MACHINE_HASH_RE.test(machineHash)) {
    return { ok: false, reason: "machineHash 形状不对（32 位小写 hex）" }
  }
  const launcherVersion = String(input.launcherVersion ?? "").trim()
  if (!VERSION_RE.test(launcherVersion)) {
    return { ok: false, reason: "launcherVersion 形状不对（x.y.z）" }
  }
  return { ok: true, installId, machineHash, launcherVersion }
}

/** 组装待签的许可（不含 sigs）。字段固定，别按请求里的值原样透传。 */
export function buildGrant({ installId, machineHash, launcherVersion, mods, ttlDays, now }) {
  return {
    v: LICENSE_SCHEMA,
    launcher: LAUNCHER_ID,
    launcherVersion,
    installId,
    machineHash,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
    mods: [...mods],
  }
}

/**
 * 签发入口。返回 `{ status, body }`，由 Worker 入口包成 Response（保持这一层可单测）。
 *
 * 状态码：200 签发 / 400 请求体不对 / 403 启动器太旧（强制更新）/ 503 接口未启用。
 */
export async function issueLicense(env, input, now = Date.now()) {
  const state = licenseState(env)
  if (!state.ok) return { status: state.status, body: { ok: false, reason: state.reason } }

  const request = readLicenseRequest(input)
  if (!request.ok) return { status: 400, body: { ok: false, reason: request.reason } }

  const policy = licensePolicy(env)
  if (isOlderThan(request.launcherVersion, policy.minLauncherVersion)) {
    return {
      status: 403,
      body: {
        ok: false,
        reason:
          "启动器版本过旧（" +
          request.launcherVersion +
          " < " +
          policy.minLauncherVersion +
          "）：请先更新启动器，更新后本模组才能使用",
        minLauncherVersion: policy.minLauncherVersion,
      },
    }
  }

  const grant = buildGrant({
    installId: request.installId,
    machineHash: request.machineHash,
    launcherVersion: request.launcherVersion,
    mods: policy.mods,
    ttlDays: policy.ttlDays,
    now,
  })
  const signature = await signGrant(state.signingKey, grant, state.keyId)
  return { status: 200, body: { ...grant, sigs: [signature] } }
}
