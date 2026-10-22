"use strict";
/**
 * 启动器绑定守卫 —— **新模组的模板副本**（「创建模组」时拷进你的 lib/launcherGuard.js）。
 *
 * 它回答一个问题：**这次运行是否来自官方 EveJS Launcher？**
 *   · 官方启动器会往下传一份**已签名的许可**：环境变量 `EVEJS_LAUNCHER_GRANT`；
 *   · 这里用内置公钥验它，再读**你自己清单**里的 `binding` 决定「不通过时要怎样」。
 *
 * 契约冻结在 v1（见 MOD_AUTHORING.md「启动器绑定」一节）：
 *   - 许可 `v` 恒为 1；签名是 `sigs: [{keyId, sig}]`，**任一条验过即可**（启动器换钥匙时双签）；
 *   - 被签的内容 = 去掉 `sigs` 的规范化 JSON（递归 key 升序、紧凑、UTF-8）；
 *   - `keyId = sha256(raw 32 字节公钥).hex()[..12]`。
 *
 * 用法（在模组入口、**做完任何事之前**）：
 *
 *     const guard = require("./lib/launcherGuard.js");
 *     if (guard.gate("你的模组id")) return;   // true = 本次运行不该加载本模组
 *
 * 清单里的开关：
 *
 *     "binding": {
 *       "launcher": "evejs-launcher",
 *       "launcherKeyId": "867242e85fc5",
 *       "enforce": "observe"      // observe = 只记日志（默认）；enforce = 不通过就不工作
 *     }
 *
 * ⚠️ `enforce` 请先留 `observe` 跑一段：日志落在 `server/logs/evejs-mods.log`，
 *    看清「有多少次没通过、为什么」再翻成 enforce。翻之前请确认官方启动器已更新到位 ——
 *    旧启动器拿不到许可，enforce 会把它们一起挡在外面。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const GUARD_VERSION = 1;
const STATE_KEY = Symbol.for("evejs.launcher.guard.v1");
const LAUNCHER_ID = "evejs-launcher";
const MANIFEST_NAME = "evejs-launcher.mod.json";
const CANON_PREFIX = "evejs-machine-v1|";

// keyId → 公钥（raw 32 字节 base64）。**只增不删**：删一条会让所有还在用它的模组版本
// 直接失效。换钥匙时启动器会同时用新旧两把签，你把新的一条加进来、过一段时间再删旧的。
const LAUNCHER_KEYS = Object.freeze({
  "867242e85fc5": "UJXSqYWG/VrWTa03/Ppq3tAgYpOE9VRyQvTyszk5ihg=",
});

/** 递归按 key 升序（与启动器 Rust 侧的 canonicalize 一一对应） */
function canonicalize(node) {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
}

/** 被签的内容：去掉 sigs（顺带去掉 sig，容忍单签写法） */
function canonicalSigned(value) {
  const clone = Object.assign({}, value);
  delete clone.sigs;
  delete clone.sig;
  return JSON.stringify(canonicalize(clone));
}

// Node 的 WebCrypto 不收裸 32 字节 Ed25519 公钥，要自己拼 SPKI 头
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function keyFromRaw(base64) {
  const raw = Buffer.from(String(base64), "base64");
  if (raw.length !== 32) throw new Error("public key is not 32 bytes");
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** 任一条签名通过即可；表里没有的 keyId 只算那一条失败（换钥匙时能双签过渡） */
function verifySigned(value, entries, keys) {
  if (!entries.length) return { ok: false, reason: "no signature" };
  const data = Buffer.from(canonicalSigned(value), "utf8");
  let reason = "signature check failed";
  for (const entry of entries) {
    const keyId = String((entry && entry.keyId) || "").trim();
    const publicKey = keys[keyId];
    if (!publicKey) { reason = "signing key not in the built-in table: " + keyId; continue; }
    let sig;
    try { sig = Buffer.from(String((entry && entry.sig) || ""), "base64"); } catch (_) { continue; }
    if (sig.length !== 64) { reason = "signature is not 64 bytes"; continue; }
    let key;
    try { key = keyFromRaw(publicKey); } catch (_) { reason = "built-in public key is malformed"; continue; }
    let good = false;
    try { good = crypto.verify(null, data, key, sig); } catch (_) { good = false; }
    if (good) return { ok: true, keyId: keyId };
  }
  return { ok: false, reason: reason };
}

function versionParts(text) {
  const parts = String(text || "").trim().split(".");
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.map(Number);
}

function isOlderThan(version, minimum) {
  const a = versionParts(version);
  const b = versionParts(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left < right;
  }
  return false;
}

function machineSource(platform) {
  if (platform === "win32") {
    try {
      const out = require("node:child_process").execFileSync(
        "reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
      if (match) return match[1].trim().toLowerCase();
    } catch (_) { /* 读不到就退回主机名 */ }
  }
  return os.hostname().trim().toLowerCase();
}

/** options 只为单测存在，模组里不要传 */
function createGuard(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const keys = opts.keys || LAUNCHER_KEYS;
  const now = opts.now || (() => Date.now());
  const modId = opts.modId || "";
  const platform = opts.platform || process.platform;
  let cachedHash = null;

  function machineHash() {
    if (cachedHash === null) {
      const source = opts.machineSource ? opts.machineSource() : machineSource(platform);
      cachedHash = crypto
        .createHash("sha256")
        .update(CANON_PREFIX + String(source).trim().toLowerCase())
        .digest("hex")
        .slice(0, 32);
    }
    return cachedHash;
  }

  /** 许可本身通不通过（不管姿态） */
  function verify() {
    const raw = env.EVEJS_LAUNCHER_GRANT;
    if (!raw) return { ok: false, reason: "EVEJS_LAUNCHER_GRANT is not set", missing: true };
    let grant;
    try { grant = JSON.parse(raw); } catch (_) { return { ok: false, reason: "grant is not valid JSON" }; }
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
      return { ok: false, reason: "grant is not an object" };
    }
    if (Number(grant.v) !== 1) return { ok: false, reason: "grant contract version is not 1" };
    if (grant.launcher !== LAUNCHER_ID) {
      return { ok: false, reason: "grant is not from the official launcher" };
    }
    if (modId && Array.isArray(grant.mods) && grant.mods.indexOf(modId) === -1) {
      return { ok: false, reason: "grant does not cover this mod" };
    }
    const signed = verifySigned(grant, Array.isArray(grant.sigs) ? grant.sigs : [], keys);
    if (!signed.ok) return { ok: false, reason: signed.reason };
    const info = {
      launcherVersion: typeof grant.launcherVersion === "string" ? grant.launcherVersion : "",
      installId: typeof grant.installId === "string" ? grant.installId : "",
    };
    const expires = Date.parse(String(grant.expiresAt || ""));
    if (!Number.isFinite(expires)) {
      return Object.assign({ ok: false, reason: "expiresAt cannot be read" }, info);
    }
    if (now() > expires) return Object.assign({ ok: false, reason: "grant has expired" }, info);
    if (grant.machineHash && String(grant.machineHash) !== machineHash()) {
      // 机器标识会漂（重装系统、换网卡、虚拟机）：只有显式开了硬校验才拒绝
      const hard =
        env.EVEJS_LAUNCHER_GUARD_HARD_MACHINE === "1" ||
        env.EVEJS_FACTIONSIM_GUARD_HARD_MACHINE === "1";
      if (hard) {
        return Object.assign(
          { ok: false, reason: "machineHash does not match", machineMismatch: true },
          info,
        );
      }
      return Object.assign(
        { ok: true, reason: "machineHash does not match (soft check, allowed)", machineMismatch: true },
        info,
      );
    }
    return Object.assign({ ok: true, reason: "" }, info);
  }

  /** 降级阀门：**必须是签名令牌**。裸字符串 / 伪造 / 过期一律当没设 —— 否则那是个谁都能开的洞 */
  function valve() {
    const raw = env.EVEJS_LAUNCHER_GUARD_MODE;
    if (!raw) return { mode: "" };
    let token;
    try { token = JSON.parse(raw); } catch (_) { return { mode: "", ignored: "not a signed token" }; }
    if (!token || typeof token !== "object" || token.mode !== "observe") {
      return { mode: "", ignored: "not a signed observe token" };
    }
    const expires = Date.parse(String(token.expiresAt || ""));
    if (!Number.isFinite(expires) || now() > expires) return { mode: "", ignored: "token expired" };
    const signed = verifySigned(token, [{ keyId: token.keyId, sig: token.sig }], keys);
    return signed.ok ? { mode: "observe" } : { mode: "", ignored: signed.reason };
  }

  /** 姿态来自**本模组自己的清单**：binding.enforce 缺省 observe */
  function posture(manifest) {
    const binding = (manifest && manifest.binding) || {};
    const declared = binding.enforce === "enforce" ? "enforce" : "observe";
    const result = verify();
    const token = valve();
    const tooOld = isOlderThan(result.launcherVersion, binding.minLauncherVersion);
    const mode = token.mode === "observe" || tooOld ? "observe" : declared;
    return {
      ok: result.ok,
      reason: result.reason,
      result: result,
      declared: declared,
      posture: mode,
      blocked: !result.ok && mode === "enforce",
      valveIgnored: token.ignored || "",
      tooOld: tooOld,
    };
  }

  return { verify: verify, valve: valve, posture: posture, machineHash: machineHash };
}

/* --------------------------- 进程级实例（模组调用这里） --------------------------- */

function findManifest(start, modId) {
  let dir = start;
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf8"));
      if (!modId || manifest.id === modId) return manifest;
    } catch (_) { /* 不是这一层 */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function appendLog(message) {
  try {
    const root = path.resolve(__dirname, "..", "..");
    const target = path.join(root, "server", "logs", "evejs-mods.log");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, new Date().toISOString() + " [launcher-guard] " + message + "\n", "utf8");
  } catch (_) { /* 只读安装不能让日志写失败拖垮模组 */ }
}

function describe(decision) {
  return JSON.stringify({
    guard: decision.ok ? "ok" : "denied",
    posture: decision.posture,
    blocked: decision.blocked,
    reason: decision.reason,
    launcherVersion: decision.result.launcherVersion || undefined,
    installId: decision.result.installId || undefined,
    machineMismatch: decision.result.machineMismatch || undefined,
    valveIgnored: decision.valveIgnored || undefined,
    tooOld: decision.tooOld || undefined,
  });
}

function createState() {
  const guard = createGuard();
  const participants = new Set();
  let decision = null;
  let reported = false;
  const state = Object.freeze({
    version: GUARD_VERSION,
    decide: function (modId) {
      if (!decision) decision = guard.posture(findManifest(__dirname, modId));
      return decision;
    },
    join: function (id) {
      const name = String(id || "").trim();
      participants.add(name);
      return name;
    },
    report: function (modId) {
      if (reported) return;
      const current = state.decide(modId);
      if (!current.ok || current.blocked || current.valveIgnored || current.result.machineMismatch) {
        reported = true;
        appendLog(describe(current) + " participants=" + JSON.stringify(Array.from(participants)));
      }
    },
  });
  return state;
}

function validState(state) {
  return Boolean(state) && state.version === GUARD_VERSION && typeof state.decide === "function";
}

/** 一个进程一份状态，所有副本共用；槽被换掉就当作 blocked（改守卫不能让它放行） */
function shared() {
  let state = globalThis[STATE_KEY];
  if (state === undefined) {
    state = createState();
    Object.defineProperty(globalThis, STATE_KEY, {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
  } else if (!validState(state)) {
    appendLog("launcher guard state failed its integrity check");
    return null;
  }
  return state;
}

/** true = 本次运行不该加载本模组（由调用方 return 掉） */
function gate(id) {
  const state = shared();
  if (!state) return true;
  state.join(id);
  const decision = state.decide(id);
  state.report(id);
  return decision.blocked;
}

module.exports = {
  gate: gate,
  createGuard: createGuard,
  LAUNCHER_KEYS: LAUNCHER_KEYS,
  canonicalSigned: canonicalSigned,
};
