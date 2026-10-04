#!/usr/bin/env node
"use strict";
/**
 * 游戏世界参数侧车（服务端 config/*.json）。
 *
 * 为什么是侧车而不是重写进 Rust：schema、取值范围校验、整型约束、原子写全都在服务端
 * `server/src/config/manager.js` 里，启动器只做「读出来 / 写回去」的搬运。
 * 抄一份规则进 Rust 等于制造第二套真相，服务端升版必然漂移。
 *
 * 用法（都由启动器调用，不面向用户）：
 *   node game-config-cli.js read --root <服务端根目录>
 *   node game-config-cli.js save --root <服务端根目录>   # patch 走 stdin: {"patch":{...}}
 *   node game-config-cli.js reset --root <服务端根目录>  # 每个配置域写回服务端默认值（写前整份备份）
 *
 * 约定：无论成功失败都以退出码 0 结束，结论写在 stdout 的 JSON 里（ok 字段），
 * 免得 Rust 侧把「服务端不支持」和「node 崩了」混成一种错误。
 */
const fs = require("fs");
const path = require("path");

const DOMAIN_ORDER = ["server", "gameplay", "world", "mining", "npc", "economy"];

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function parseArgs(argv) {
  const result = { command: argv[0] || "", root: "" };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      result.root = argv[i + 1] || "";
      i += 1;
    }
  }
  return result;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (error) {
    return "";
  }
}

/** 载入服务端自己的配置管理器；服务端目录不完整时给出可读原因而不是抛栈 */
function loadManager(root) {
  const configDir = path.join(root, "server", "src", "config");
  const managerPath = path.join(configDir, "manager.js");
  const schemaPath = path.join(configDir, "schema", "index.js");
  if (!fs.existsSync(managerPath) || !fs.existsSync(schemaPath)) {
    return { error: "服务端目录里没有配置模块，期望 " + managerPath };
  }
  let mod;
  let schemaDefinitions;
  try {
    mod = require(managerPath);
    schemaDefinitions = require(schemaPath);
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return { error: "加载服务端配置模块失败：" + detail };
  }
  if (typeof mod.createConfigManager === "function") {
    try {
      return { manager: mod.createConfigManager({ rootDir: root, schemaDefinitions: schemaDefinitions }) };
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      return { error: "初始化配置管理器失败：" + detail };
    }
  }
  try {
    return { manager: require(path.join(configDir, "index.js")) };
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return { error: "服务端配置模块没有导出 createConfigManager：" + detail };
  }
}

function projectDefinitions(definitions) {
  return definitions.map(function (entry) {
    const configPath = Array.isArray(entry.configPath) ? entry.configPath : [];
    const file = typeof entry.configFile === "string" ? entry.configFile : "";
    let description = entry.description;
    if (typeof description === "string") description = [description];
    if (!Array.isArray(description)) description = [];
    return {
      key: entry.key,
      domain: file,
      section: configPath.length > 0 ? String(configPath[0]) : "",
      valueType: entry.valueType,
      defaultValue: entry.defaultValue === undefined ? null : entry.defaultValue,
      description: description.map(String),
      validValues: typeof entry.validValues === "string" ? entry.validValues : null,
      integer: entry.integer === true,
      minValue: typeof entry.minValue === "number" ? entry.minValue : null,
      maxValue: typeof entry.maxValue === "number" ? entry.maxValue : null,
      exclusiveMinValue: entry.exclusiveMinValue === true,
      allowBlank: entry.allowBlank === true,
      allowedValues: Array.isArray(entry.allowedValues) ? entry.allowedValues.slice() : null,
      envVar: typeof entry.envVar === "string" ? entry.envVar : null
    };
  });
}

function projectState(manager) {
  const snap = manager.getConfigStateSnapshot();
  const version = snap.version && typeof snap.version === "object" ? snap.version : {};
  return {
    values: snap.resolvedConfig && typeof snap.resolvedConfig === "object" ? snap.resolvedConfig : {},
    defaults: snap.defaults && typeof snap.defaults === "object" ? snap.defaults : {},
    sources: snap.sources && typeof snap.sources === "object" ? snap.sources : {},
    files: snap.configFilePaths && typeof snap.configFilePaths === "object" ? snap.configFilePaths : {},
    envOverrides: Object.keys(snap.envConfig && typeof snap.envConfig === "object" ? snap.envConfig : {}),
    configDir: typeof snap.configDir === "string" ? snap.configDir : "",
    rootDir: typeof snap.rootDir === "string" ? snap.rootDir : "",
    evejsVersion: typeof version.evejsVersion === "string" ? version.evejsVersion : null,
    schemaVersion: typeof version.configSchemaVersion === "number" ? version.configSchemaVersion : null,
    legacy: {
      shared: typeof snap.legacySharedConfigPath === "string" ? snap.legacySharedConfigPath : null,
      local: typeof snap.legacyLocalConfigPath === "string" ? snap.legacyLocalConfigPath : null
    }
  };
}

/** 写前备份：整份 config/*.json 拷到 _local/config-backups/gameconfig-<时间戳>/ */
function backupConfigs(root, files, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(root, "_local", "config-backups", (label || "gameconfig") + "-" + stamp);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const domain of Object.keys(files)) {
    const file = files[domain];
    if (typeof file === "string" && fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(dir, domain + ".json"));
      copied.push(domain);
    }
  }
  return { dir: dir, copied: copied };
}

function commandRead(root) {
  const loaded = loadManager(root);
  if (loaded.error) return { ok: false, supported: false, reason: loaded.error };
  const manager = loaded.manager;
  const payload = projectState(manager);
  payload.ok = true;
  payload.supported = true;
  payload.domains = DOMAIN_ORDER;
  payload.definitions = projectDefinitions(manager.getConfigDefinitions());
  return payload;
}

function errorList(error) {
  return error && Array.isArray(error.errors)
    ? error.errors
    : [error && error.message ? error.message : String(error)];
}

function commandSave(root, rawStdin) {
  const loaded = loadManager(root);
  if (loaded.error) return { ok: false, supported: false, reason: loaded.error };
  let body;
  try {
    body = JSON.parse(rawStdin || "{}");
  } catch (error) {
    return { ok: false, supported: true, reason: "请求体不是合法 JSON" };
  }
  const patch = body && typeof body.patch === "object" && body.patch !== null ? body.patch : null;
  if (!patch) return { ok: false, supported: true, reason: "缺少 patch" };
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, supported: true, reason: "没有要写入的配置项" };

  const manager = loaded.manager;
  const definitions = projectDefinitions(manager.getConfigDefinitions());
  const byKey = new Map(definitions.map(function (item) { return [item.key, item]; }));
  const unknown = keys.filter(function (key) { return !byKey.has(key); });
  if (unknown.length > 0) {
    return { ok: false, supported: true, reason: "不认识的配置项：" + unknown.join("、") };
  }
  const domains = [];
  for (const key of keys) {
    const domain = byKey.get(key).domain;
    if (domain && domains.indexOf(domain) === -1) domains.push(domain);
  }

  const state = projectState(manager);

  // 先校验再备份：值不合法时不该在服务端留下一堆没用的备份目录
  if (typeof manager.buildValidatedConfigValues === "function") {
    try {
      manager.buildValidatedConfigValues(patch, state.values);
    } catch (error) {
      const errors = errorList(error);
      return { ok: false, supported: true, reason: errors.join("；"), errors: errors };
    }
  }

  let backup;
  try {
    backup = backupConfigs(root, state.files);
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return { ok: false, supported: true, reason: "写前备份失败，已放弃写入：" + detail };
  }

  try {
    manager.saveConfig(patch, { domains: domains });
  } catch (error) {
    const errors = errorList(error);
    return { ok: false, supported: true, reason: errors.join("；"), errors: errors, backupDir: backup.dir };
  }

  const after = projectState(manager);
  return {
    ok: true,
    supported: true,
    saved: domains,
    backupDir: backup.dir,
    values: after.values,
    sources: after.sources,
    envOverrides: after.envOverrides
  };
}

/**
 * 重置：把每个配置域写回服务端自己的默认值。
 *
 * 默认值只在服务端 schema 里，这里不抄第二套：拿 getConfigStateSnapshot().defaults
 * 当整份 patch 交给 saveConfig，由服务端校验 + 原子写回。写前整份备份到
 * _local/config-backups/reset-<时间戳>/，失败不动盘。
 */
function commandReset(root) {
  const loaded = loadManager(root);
  if (loaded.error) return { ok: false, supported: false, reason: loaded.error };
  const manager = loaded.manager;

  let before;
  try {
    before = projectState(manager);
  } catch (error) {
    return { ok: false, supported: true, reason: errorList(error).join("；") };
  }
  const defaults = before.defaults && typeof before.defaults === "object" ? before.defaults : null;
  if (!defaults || Object.keys(defaults).length === 0) {
    return { ok: false, supported: true, reason: "服务端没有给出默认值清单，无法重置" };
  }

  let backup;
  try {
    backup = backupConfigs(root, before.files, "reset");
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return { ok: false, supported: true, reason: "写前备份失败，已放弃写入：" + detail };
  }

  try {
    manager.saveConfig(defaults, { domains: DOMAIN_ORDER });
  } catch (error) {
    const errors = errorList(error);
    return { ok: false, supported: true, reason: errors.join("；"), errors: errors, backupDir: backup.dir };
  }

  const after = projectState(manager);
  const changed = Object.keys(after.values).filter(function (key) {
    return JSON.stringify(after.values[key]) !== JSON.stringify(before.values[key]);
  });
  return {
    ok: true,
    supported: true,
    backupDir: backup.dir,
    changed: changed,
    values: after.values,
    defaults: after.defaults,
    sources: after.sources,
    envOverrides: after.envOverrides
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? path.resolve(args.root) : "";
  if (!root) {
    emit({ ok: false, supported: false, reason: "缺少 --root（服务端根目录）" });
    return;
  }
  if (!fs.existsSync(root)) {
    emit({ ok: false, supported: false, reason: "服务端根目录不存在：" + root });
    return;
  }
  if (args.command === "read") {
    emit(commandRead(root));
    return;
  }
  if (args.command === "save") {
    emit(commandSave(root, readStdin()));
    return;
  }
  if (args.command === "reset") {
    emit(commandReset(root));
    return;
  }
  emit({ ok: false, supported: false, reason: "未知子命令：" + args.command });
}

try {
  main();
} catch (error) {
  emit({ ok: false, supported: false, reason: error && error.stack ? error.stack : String(error) });
}