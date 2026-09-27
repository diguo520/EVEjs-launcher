#!/usr/bin/env node
/**
 * L3 端到端编排：快照 → 跑场景 → 断言 → 还原 → 复跑比对。
 *
 * 为什么断言放在这边而不是注入脚本里：真正有说服力的证据是「回包 + 落地后的文件系统」
 * 两边都对上，而文件系统只有等进程退出才看得到。所以注入脚本只负责按顺序调通道、把回包
 * 原样带回来；判定、还原、复跑一致性、进程与端口收尾全部在这里做。
 *
 * 用法：
 *   node tests/e2e/run.mjs                      # 默认场景 repo-mods，跑 2 轮
 *   node tests/e2e/run.mjs --debug --repeats 1  # 用 debug 产物，只跑 1 轮
 *   node tests/e2e/run.mjs --keep               # 跑完不还原，留给人工看现场
 *
 * 为什么要跑 2 轮（默认）：第 2 轮完全建立在「还原之后」的树上。两轮的文件改动指纹必须一致，
 * 这条同时证明了「还原是逐字节的」和「沙箱可以反复用」—— 少了它，还原只是一句自述。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SANDBOX,
  ROOT,
  MARKET_CACHE_PATH,
  applySeeds,
  buildSandbox,
  changeSignature,
  diffManifests,
  listTree,
  restore,
  snapshot,
} from "./sandbox.mjs";

/** 固定绝对路径：登录/任务环境里的 PATH 常常没有 pwsh，但系统自带的 5.1 一定在 */
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
/** L3 涉及的服务端口（与现役版 config/server.json 一致） */
const PORTS = [26000, 26001, 26002, 40110];
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, "contract", "ipc-channels.json"), "utf8"));
const REQUEST_CHANNELS = new Set(
  [...CONTRACT.invoke, ...CONTRACT.send].map((entry) => entry.channel),
);

function parseArgs(argv) {
  const value = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    debug: argv.includes("--debug"),
    keep: argv.includes("--keep"),
    nowarmup: argv.includes("--no-warmup"),
    scenario: value("--scenario", "repo-mods"),
    repeats: Number(value("--repeats", "2")),
    timeoutMs: Number(value("--timeout", "120")) * 1000,
    exe: value("--exe", null),
    sandbox: path.resolve(ROOT, value("--sandbox", path.relative(ROOT, DEFAULT_SANDBOX))),
    outJson: path.resolve(ROOT, value("--out", path.join(".parity-out", "e2e.json"))),
  };
}

function capture(exe, argv) {
  const result = spawnSync(exe, argv, { encoding: "utf8", windowsHide: true });
  return String(result.stdout || "") + String(result.stderr || "");
}

function launcherProcessCount() {
  const out = capture("tasklist", ["/FI", "IMAGENAME eq EvEJSLauncher.exe", "/FO", "CSV", "/NH"]);
  return out
    .split("\n")
    .filter((line) => line.toUpperCase().includes("EVEJSLAUNCHER.EXE")).length;
}

function listeningPorts() {
  const out = capture(POWERSHELL, [
    "-NoProfile",
    "-Command",
    "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique",
  ]);
  return out
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value));
}

async function waitFor(condition, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return condition();
}

/* ----------------------------- 断言求值 ----------------------------- */

function resolvePath(value, dotted) {
  let current = value;
  for (const key of String(dotted).split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function evaluateExpect(expect, reply) {
  const problems = [];
  if (!expect) return problems;
  if (expect.ok !== undefined && (reply === null || reply.ok !== expect.ok)) {
    problems.push("ok 期望 " + expect.ok + "，实际 " + JSON.stringify(reply === null ? null : reply.ok));
  }
  if (expect.path) {
    const actual = resolvePath(reply, expect.path);
    if (expect.equals !== undefined && actual !== expect.equals) {
      problems.push(expect.path + " 期望 " + JSON.stringify(expect.equals) + "，实际 " + JSON.stringify(actual));
    }
    if (expect.isArray && !Array.isArray(actual)) {
      problems.push(expect.path + " 期望数组，实际 " + JSON.stringify(actual));
    }
    if (expect.minLength !== undefined && (!Array.isArray(actual) || actual.length < expect.minLength)) {
      problems.push(expect.path + " 期望至少 " + expect.minLength + " 项，实际 " + JSON.stringify(actual));
    }
  }
  return problems;
}

function evaluateFs(checks, sandboxRoot) {
  const problems = [];
  for (const item of checks || []) {
    const target = path.join(sandboxRoot, ...String(item.path).split("/"));
    const exists = fs.existsSync(target);
    if (item.exists !== undefined && exists !== item.exists) {
      problems.push(item.path + " 期望" + (item.exists ? "存在" : "不存在") + "，实际" + (exists ? "存在" : "不存在"));
    }
    // contains：写通道的「落地内容」断言 —— 只看文件在不在，抓不到「写进去了、但写的是错的值」
    if (item.contains !== undefined) {
      const text = exists ? fs.readFileSync(target, "utf8") : "";
      if (!text.includes(item.contains)) {
        problems.push(item.path + " 内容里没有 " + JSON.stringify(item.contains));
      }
    }
    // notContains：反向断言 —— 用来证明「机密没有明文落盘」（例如 DPAPI 加密后的令牌文件）
    if (item.notContains !== undefined) {
      const text = exists ? fs.readFileSync(target, "utf8") : "";
      if (text.includes(item.notContains)) {
        problems.push(item.path + " 内容里不该出现 " + JSON.stringify(item.notContains));
      }
    }
  }
  return problems;
}

/** 场景里的路径占位符：${REPO} / ${USERDATA} / ${CWD} → 沙箱真实路径。
 *
 *  为什么需要它：好几个写通道的参数必须是绝对路径（config:setRepoRoot、备份目录、直登），
 *  而场景文件是进仓的静态 JSON —— 不替换就只能拿假路径去测异常分支，
 *  真正想验的「写对了没有」反而测不到。替换发生在编排侧，注入脚本拿到的已是绝对路径。 */
function resolvePlaceholders(node, sandbox) {
  if (typeof node === "string") {
    return node
      .replaceAll("${REPO}", sandbox.repoDir)
      .replaceAll("${USERDATA}", sandbox.userdataDir)
      .replaceAll("${CWD}", sandbox.cwdDir);
  }
  if (Array.isArray(node)) return node.map((item) => resolvePlaceholders(item, sandbox));
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = resolvePlaceholders(value, sandbox);
    return out;
  }
  return node;
}

function validateScenario(scenario) {
  const problems = [];
  const ids = new Set();
  for (const step of scenario.steps || []) {
    if (!step.id) problems.push("有步骤缺 id");
    else if (ids.has(step.id)) problems.push("步骤 id 重复：" + step.id);
    else ids.add(step.id);
    if (!REQUEST_CHANNELS.has(step.channel)) {
      problems.push("通道不在契约里：" + step.channel);
    }
  }
  if (!(scenario.steps || []).length) problems.push("场景没有任何步骤");
  return problems;
}

/* ----------------------------- 单轮执行 ----------------------------- */

async function runOnce({ exe, scenarioFile, sandbox, outputDir, index, timeoutMs }) {
  const outFile = path.join(outputDir, "run" + index + ".json");
  fs.rmSync(outFile, { force: true });
  const startedAt = Date.now();
  const child = spawn(exe, ["--self-test"], {
    cwd: sandbox.cwdDir,
    env: {
      ...process.env,
      EVEJS_E2E_SCENARIO: scenarioFile,
      EVEJS_SELF_TEST_OUT: outFile,
      EVEJS_USER_DATA_DIR: sandbox.userdataDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let summary = null;
  await waitFor(
    () => {
      if (!fs.existsSync(outFile)) return false;
      try {
        summary = JSON.parse(fs.readFileSync(outFile, "utf8"));
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs,
  );
  try {
    child.kill();
  } catch {
    /* 进程可能已自退 */
  }
  await waitFor(() => launcherProcessCount() === 0, 10000);
  return { summary, stderr, ms: Date.now() - startedAt };
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const exe = options.exe || path.join(ROOT, "src-tauri", "target", options.debug ? "debug" : "release", "EvEJSLauncher.exe");
  const snapshotDir = options.sandbox + ".snapshot";
  const outputDir = path.join(path.dirname(options.outJson), "e2e-out");
  const scenarioFile = path.join(import.meta.dirname, "scenarios", options.scenario + ".json");
  const checks = [];
  const addCheck = (name, ok, detail = "") => {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) console.log("[FAIL] " + name + (detail ? " —— " + detail : ""));
    return Boolean(ok);
  };

  if (!addCheck("产物存在", fs.existsSync(exe), exe)) {
    console.log("先跑：pwsh -File scripts/build.ps1（或加 --debug 用 debug 产物）");
    process.exit(2);
  }
  if (!addCheck("场景文件存在", fs.existsSync(scenarioFile), scenarioFile)) process.exit(2);

  const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
  const scenarioProblems = validateScenario(scenario);
  if (!addCheck("场景合法（通道都在契约里、id 不重复）", scenarioProblems.length === 0, scenarioProblems.join("；"))) {
    process.exit(2);
  }

  const beforeProcesses = launcherProcessCount();
  addCheck("跑之前没有残留启动器进程", beforeProcesses === 0, "发现 " + beforeProcesses + " 个");
  const busyBefore = listeningPorts().filter((port) => PORTS.includes(port));
  addCheck("跑之前目标端口空闲", busyBefore.length === 0, "占用：" + busyBefore.join(", "));

  const sandbox = buildSandbox({ root: options.sandbox });
  applySeeds(sandbox.root, scenario.seed);
  fs.mkdirSync(outputDir, { recursive: true });

  // 把占位符换成沙箱真实路径后再注入（场景文件本身保持可进仓的静态形态）
  const resolvedScenario = resolvePlaceholders(scenario, sandbox);
  const resolvedScenarioFile = path.join(outputDir, "scenario-resolved.json");
  fs.writeFileSync(resolvedScenarioFile, JSON.stringify(resolvedScenario, null, 2) + "\n", "utf8");

  // 预热一轮：把「首次启动的副作用」落下来再固化进基线，否则两轮差异里会混进随机噪声，
  // 场景本身的确定性就看不出来了。
  //
  // 预热里显式打一次 author:get 是有原因的：作者身份（author.json + mod-keys/<keyId>.key）的
  // 密钥是**每次现建都不同**的随机值，文件名也跟着 keyId 变。早先预热跑的是空场景，靠渲染层
  // 加载时顺手建身份；换成 React 渲染层后，身份只在进入「作者身份」页时才建，空场景不会建 ——
  // 于是每一轮都现建一把新密钥，指纹永远对不上。这里把它显式固化进基线（见 README §5）。
  if (!options.nowarmup) {
    const warmupFile = path.join(outputDir, "warmup.json");
    const warmupScenario = {
      name: "warmup",
      steps: [{ id: "warmup-author", channel: "author:get", args: [] }],
    };
    fs.writeFileSync(warmupFile, JSON.stringify(warmupScenario, null, 2) + "\n", "utf8");
    const warmup = await runOnce({
      exe,
      scenarioFile: warmupFile,
      sandbox,
      outputDir,
      index: 0,
      timeoutMs: options.timeoutMs,
    });
    addCheck(
      "预热一轮（固化身份与脚手架，作为基线的一部分）",
      Boolean(warmup.summary) && warmup.summary.total === warmupScenario.steps.length,
      warmup.summary ? "" : warmup.stderr.trim().split("\n").slice(-2).join(" / "),
    );
  }

  const baseline = snapshot(sandbox.root, snapshotDir);
  console.log("沙箱：" + path.relative(ROOT, sandbox.root));
  console.log("基线：" + baseline.manifest.length + " 个文件，digest " + baseline.digest.slice(0, 12));

  const runs = [];
  for (let index = 1; index <= options.repeats; index += 1) {
    console.log("");
    console.log("=== 第 " + index + " 轮 ===");
    const outcome = await runOnce({
      exe,
      scenarioFile: resolvedScenarioFile,
      sandbox,
      outputDir,
      index,
      timeoutMs: options.timeoutMs,
    });
    if (!outcome.summary) {
      addCheck("第 " + index + " 轮拿到自检报告", false, outcome.stderr.trim().split("\n").slice(-3).join(" / "));
      runs.push({ index, ms: outcome.ms, failed: "no-report" });
      break;
    }
    const summary = outcome.summary;
    addCheck("第 " + index + " 轮报告是 e2e 模式", summary.mode === "e2e", "mode=" + summary.mode);
    console.log("  步骤 " + summary.ok + "/" + summary.total + " 有回包，用时 " + outcome.ms + " ms");

    const postManifest = listTree(sandbox.root);
    const changes = diffManifests(baseline.manifest, postManifest);
    const signature = changeSignature(changes, postManifest);

    const results = Array.isArray(summary.results) ? summary.results : [];
    for (const step of scenario.steps || []) {
      const record = results.find((item) => item.id === step.id);
      if (!addCheck("步骤 " + step.id + " 有回包", Boolean(record) && record.status === "ok", record ? record.error || "" : "报告里没有这条")) {
        continue;
      }
      const problems = evaluateExpect(step.expect, record.reply);
      addCheck("步骤 " + step.id + " 断言", problems.length === 0, problems.join("；"));
    }
    const fsProblems = evaluateFs(resolvedScenario.fsAfter, sandbox.root);
    addCheck("第 " + index + " 轮落地文件符合预期", fsProblems.length === 0, fsProblems.join("；"));
    addCheck(
      "第 " + index + " 轮确实改了沙箱（写通道真落盘）",
      !changes.identical,
      "新增 " + changes.added.length + " / 改动 " + changes.changed.length + " / 删除 " + changes.removed.length,
    );
    // 密闭性：预置的索引缓存若被重写，说明本轮真的出网去拉了索引（网络相关 + 竞态，必须当失败）
    const refetched = [...changes.added, ...changes.changed].some((item) => item === "userdata/" + MARKET_CACHE_PATH);
    addCheck("第 " + index + " 轮没有出网刷新市场索引（沙箱密闭）", !refetched, "mod-index.json 被重写：本轮出网了");

    console.log("  改动：" + signature.length + " 条（新增 " + changes.added.length + " / 改动 " + changes.changed.length + " / 删除 " + changes.removed.length + "）");
    for (const line of signature) console.log("    " + line);

    // --keep：保留现场（调试用）。此时刻意不还原本轮，因此后续轮次/指纹比对不再成立。
    const restored = options.keep ? { digest: baseline.digest } : restore(snapshotDir, sandbox.root);
    addCheck(
      "第 " + index + " 轮还原后与基线逐字节一致",
      restored.digest === baseline.digest,
      "还原后 " + restored.digest.slice(0, 12) + " vs 基线 " + baseline.digest.slice(0, 12),
    );

    runs.push({ index, ms: outcome.ms, ok: summary.ok, total: summary.total, changes, signature, restoreDigest: restored.digest });
  }

  if (runs.length > 1) {
    const first = JSON.stringify(runs[0].signature);
    const allSame = runs.every((run) => JSON.stringify(run.signature) === first);
    addCheck("各轮的文件改动指纹一致（还原可复用 + 场景确定性）", allSame);
  }

  if (!options.keep) {
    const final = restore(snapshotDir, sandbox.root);
    addCheck("收尾还原回到基线", final.digest === baseline.digest);
  } else {
    console.log("--keep：保留现场 " + path.relative(ROOT, sandbox.root));
  }

  await waitFor(() => launcherProcessCount() === 0, 10000);
  const afterProcesses = launcherProcessCount();
  addCheck("跑完没有残留启动器进程", afterProcesses === 0, "发现 " + afterProcesses + " 个");
  const busyAfter = listeningPorts().filter((port) => PORTS.includes(port));
  addCheck("跑完目标端口全部释放", busyAfter.length === 0, "占用：" + busyAfter.join(", "));

  const failures = checks.filter((item) => !item.ok);
  const report = {
    scenario: options.scenario,
    scenarioFile: path.relative(ROOT, scenarioFile),
    exe: path.relative(ROOT, exe),
    repeats: options.repeats,
    finishedAt: new Date().toISOString(),
    sandbox: path.relative(ROOT, sandbox.root),
    baselineDigest: baseline.digest,
    baselineFiles: baseline.manifest.length,
    checks,
    failures: failures.map((item) => item.name),
    runs: runs.map((run) => ({
      index: run.index,
      ms: run.ms,
      ok: run.ok,
      total: run.total,
      added: run.changes ? run.changes.added : [],
      changed: run.changes ? run.changes.changed : [],
      removed: run.changes ? run.changes.removed : [],
    })),
  };
  fs.mkdirSync(path.dirname(options.outJson), { recursive: true });
  fs.writeFileSync(options.outJson, JSON.stringify(report, null, 2) + "\n", "utf8");

  const md = [];
  md.push("");
  md.push("| 场景 | 轮次 | 回包 | 新增/改动/删除 | 用时(ms) |");
  md.push("| --- | --- | --- | --- | --- |");
  for (const run of report.runs) {
    md.push("| " + report.scenario + " | " + run.index + " | " + run.ok + "/" + run.total + " | " + run.added.length + "/" + run.changed.length + "/" + run.removed.length + " | " + run.ms + " |");
  }
  md.push("");
  md.push("断言 " + checks.filter((item) => item.ok).length + "/" + checks.length + " 通过；基线 " + report.baselineFiles + " 个文件，digest " + report.baselineDigest.slice(0, 12) + "。");
  fs.writeFileSync(path.join(path.dirname(options.outJson), "e2e.md"), md.join("\n") + "\n", "utf8");

  console.log("");
  if (failures.length) {
    console.log("L3 端到端未通过（" + failures.length + "/" + checks.length + " 项）：");
    for (const item of failures) console.log("  - " + item.name + (item.detail ? " —— " + item.detail : ""));
    process.exit(1);
  }
  console.log("L3 端到端通过：" + checks.length + " 项断言全绿；结果写进 " + path.relative(ROOT, options.outJson));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
