/**
 * 通道级 golden 的共享口径（S3 §5.2 规则 1；S5 起被 diff.mjs 与 diff-cross.mjs 共用）。
 *
 * 规范化只做「与实现无关的降噪」：剔除 volatile 键、抹平时间戳与绝对路径。
 * 比对策略（整体比 / 只比结构）也集中在这里，避免两个 diff 脚本各写一套。
 */
export const VOLATILE_KEYS = new Set([
  "pid", "processId", "childPid", "ms", "durationMs", "elapsedMs", "startedAt", "finishedAt",
  "at", "timestamp", "updatedAt", "fetchedAt", "publishedAt", "lastRun", "uptimeMs", "since",
  // 窗口状态：用户拖出来的尺寸/位置，纯运行时持久化数据，永远不构成「实现差异」
  "windowBounds",
  // 在线人数：来自 netstat 的连接计数，首轮采样完成前是 null、之后才是数字（0/1/2…），
  // 与 pid 同一类运行时读数；「0 人」与「查不到」的区分由 metrics.rs 的单测保，不在 golden 里冻结
  "onlinePlayers",
  "__truncated",
]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/**
 * 盘符绝对路径。**按反斜杠分段匹配**，所以路径里的空格（本机仓库目录名就带空格）不会被截断，
 * 也不会误伤 `http://127.0.0.1:26002/` 这类正斜杠 URL（旧写法会把后者吃成 `htt<abs-path>`）。
 */
const ABS_PATH = /[A-Za-z]:\\(?:[^\\\/:*?"<>|\r\n]+\\)*[^\\\/:*?"<>|\r\n]*/g;
const UNC_PREFIX = /\\\\\?\\/g;
const USER_HOME = /[A-Za-z]:[\\/]Users[\\/][^\\/"'\s]+/gi;

/**
 * 这些通道的载荷**天生不稳定**（日志正文、计数器、进程 PID、数据库行数），
 * 只比结构（键集合 + 值类型 + 数组元素形状），不比取值 —— 否则每次跑都红，
 * 基线会退化成人人点忽略的红灯。
 */
export const SHAPE_ONLY_CHANNELS = new Set([
  "log:read",
  // 端口扫描来自 netstat：同机器上「谁在监听」会随服务启停变化，值不可冻结
  "accounts:checkRunning",
  // health:check 同理：探的是本机 26000/26001/26002/40110（见 src-tauri/src/health.rs），
  // 机器上真跑着服务端时 market/game 就会翻成 true；键集合与布尔类型仍然照比，
  // 端口映射本身由 portsOf / health:ping 的用例保。
  "health:check",
  "metrics:get",
  "services:list",
  "init:state",
  "database:overview",
  "database:table",
  // env:check 报的是**本机环境**（Node 版本、VS 构建工具路径、server/node_modules 是否存在…）：
  // 换机器 / 换 Node / CI runner 上必然不同，取值不可冻结。只比键集合与值类型
  // （checks[0] 是 Node 那一项，顺序稳定），语义本身由 env.rs 的单测保。
  "env:check",
]);

/**
 * 条件键：**键本身**只在特定取值下才出现，于是「本机装没装某项」会直接改变结构指纹。
 *
 * env:check 的检查项就是这个形状：src-tauri/src/env.rs::check_item 只在「未就绪 / 部分就绪」时
 * 才插入 hint / installUrl（有修复建议才有得可点），warn 同理。CI runner 装的是 Node 22，而
 * node_check 的门槛是 ≥24，于是同一份代码在 runner 上凭空多出两个键，结构比对必然红
 * （2026-09-28 实测：这是 CI 第 11 步唯一剩下的差异）。
 *
 * 这些键的语义（未就绪必须给非空 hint、就绪则整键消失、任何键都不许是 null）由 env.rs 的单测保，
 * 这里只比**必备键**的集合与类型，不再重复管一遍「可选键在什么情况下该出现」。
 */
const CONDITIONAL_KEYS = new Map([
  ["env:check", new Set(["hint", "installUrl", "warn"])],
]);

/**
 * 通道私有的 volatile 键：只在**某一个**通道里才是运行时读数。
 *
 * 为什么不能塞进全局 VOLATILE_KEYS：`ok` 在几乎所有通道里都表示「命令本身成功」，是必须冻结的
 * 契约；只有 `health:ping` 的 `ok` 是「26000 端口此刻通不通」。一刀切会把别处的真契约也抹掉。
 *
 * 为什么必须修（2026-09-30 实测）：这些值跟「本机有没有服务在监听」联动 —— 开着服务端打包时
 * `listening` 从 [] 变 [26000]、`running`/`ok` 从 false 变 true，golden 于是每开关一次服务
 * 就红一次，正是 SHAPE_ONLY_CHANNELS 注释里说的「基线退化成人人点忽略的红灯」。
 * 端口映射与探活语义仍由 accounts.rs / health.rs 的单测保。
 */
const VOLATILE_CHANNEL_KEYS = new Map([
  // netstat 扫描 + 端口探活：值随本机服务启停变化
  ["accounts:checkRunning", new Set(["listening", "running"])],
  // `port` 是常量（DEFAULT_GAME_PORT），不抹，仍然照比
  ["health:ping", new Set(["ok"])],
]);

/** 按通道剔除两类键：条件键（只在特定取值下出现）与运行时读数。 */
function dropKeys(channel, node) {
  const drop = new Set([
    ...(CONDITIONAL_KEYS.get(channel) ?? []),
    ...(VOLATILE_CHANNEL_KEYS.get(channel) ?? []),
  ]);
  if (drop.size === 0) return node;
  if (Array.isArray(node)) return node.map((item) => dropKeys(channel, item));
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node)) {
      if (drop.has(key)) continue;
      out[key] = dropKeys(channel, node[key]);
    }
    return out;
  }
  return node;
}

/** 通道级规范化：normalize 之后再按通道剔除条件键 / 运行时读数。写基线也要走这条，别把读数冻进去。 */
export function normalizeChannel(channel, node) {
  return dropKeys(channel, normalize(node));
}

export function normalize(node) {
  if (typeof node === "string") {
    if (ISO.test(node)) return "<timestamp>";
    return node.replace(USER_HOME, "<user-home>").replace(UNC_PREFIX, "").replace(ABS_PATH, "<abs-path>");
  }
  if (Array.isArray(node)) return node.map((item) => normalize(item));
  if (node && typeof node === "object") {
    const out = {};
    for (const name of Object.keys(node).sort()) {
      if (VOLATILE_KEYS.has(name)) continue;
      out[name] = normalize(node[name]);
    }
    return out;
  }
  return node;
}

/** 结构指纹：字符串→<string>、数字→<number>、布尔→<bool>、数组只取首元素形状、对象保留键 */
export function shape(node) {
  if (Array.isArray(node)) return node.length === 0 ? [] : [shape(node[0])];
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = shape(node[key]);
    return out;
  }
  if (node === null) return "<null>";
  return `<${typeof node}>`;
}

/** 通道级差异：先按规范化后的 JSON 比整块，再列出不相同的顶层键，方便定位 */
export function channelDiff(baseline, current) {
  const left = normalize(baseline);
  const right = normalize(current);
  if (JSON.stringify(left) === JSON.stringify(right)) return null;
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  const changed = [];
  for (const key of [...keys].sort()) {
    if (JSON.stringify(left?.[key]) !== JSON.stringify(right?.[key])) changed.push(key);
  }
  return changed.length ? changed : ["<非对象载荷>"];
}

/**
 * 单通道比对：一致返回 null，否则返回差异键数组。
 * 「整体比 vs 只比结构」的选择只在这里做一次，diff.mjs / diff-cross.mjs 共用。
 */
export function compareChannel(channel, baseline, current) {
  if (SHAPE_ONLY_CHANNELS.has(channel)) {
    const left = shape(normalizeChannel(channel, baseline));
    const right = shape(normalizeChannel(channel, current));
    if (JSON.stringify(left) === JSON.stringify(right)) return null;
    return channelDiff(left, right);
  }
  return channelDiff(normalizeChannel(channel, baseline), normalizeChannel(channel, current));
}

/**
 * `{}` / `[]` / `null` / `undefined`：跨实现豁免某些键之后，一侧会退化成的「空载荷」。
 * 只有两侧都空才算等价（`{}` 与 `null` 都表示「没有内容」，但 `{}` 与 `{x:1}` 不是）。
 */
export function isEmptyPayload(node) {
  if (node === null || node === undefined) return true;
  if (Array.isArray(node)) return node.length === 0;
  if (typeof node === "object") return Object.keys(node).length === 0;
  return false;
}

/** 读 dump 文件，兼容 `{channels:{...}}` 与裸 dump 两种形状 */
export function readDump(file, fs) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return raw.channels ?? raw;
}