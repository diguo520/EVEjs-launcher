import { useCallback, useEffect, useState } from "react";
import NeocomBar, { type NeocomKey } from "./components/NeocomBar";
import ServiceCard from "./components/ServiceCard";
import LoginBox from "./components/LoginBox";
import TerminalPanel from "./components/TerminalPanel";
import StartButton from "./components/StartButton";
import StatusBar from "./components/StatusBar";
import ConfigPanel from "./components/ConfigPanel";
import LogPanel from "./components/LogPanel";
import ManualPanel from "./components/ManualPanel";
import AccountPanel from "./components/AccountPanel";
import EnvBoard from "./components/EnvBoard";
import { useTerminal, type TerminalApi } from "./hooks/useTerminal";
import { useServices } from "./hooks/useServices";
import type { AppInfo, EnvReport, InitState } from "./types";
import logoUrl from "./assets/evejs-logo.svg";

function printEnvReport(rep: EnvReport, terminal: TerminalApi): void {
  for (const c of rep.checks) {
    const mark = c.ok ? "\x1b[32m[ OK ]\x1b[0m" : c.warn ? "\x1b[33m[WARN]\x1b[0m" : "\x1b[31m[FAIL]\x1b[0m";
    terminal.writeLine("system", `${mark} ${c.label}`);
    terminal.writeLine("system", `     ${c.message}`);
    if (!c.ok && c.hint) terminal.writeLine("system", `     \x1b[90m↳ ${c.hint}\x1b[0m`);
  }
  const failed = rep.checks.filter((c) => !c.ok).length;
  const head =
    failed === 0
      ? `\x1b[32m[自检完成] ${rep.passCount}/${rep.totalCount} 项全部通过\x1b[0m`
      : `\x1b[36m[自检完成] ${rep.passCount}/${rep.totalCount} 项通过 · ${failed} 项未达标\x1b[0m`;
  terminal.writeLine("system", `${head} · 仓库 ${rep.repoRoot}`);
  if (rep.sys) {
    const mark =
      rep.sys.level === "ok" ? "\x1b[32m[ OK ]\x1b[0m" : rep.sys.level === "warn" ? "\x1b[33m[WARN]\x1b[0m" : "\x1b[31m[FAIL]\x1b[0m";
    terminal.writeLine("system", `${mark} 系统资源：${rep.sys.message}`);
  }
}

// StrictMode 双执行防护：模块级标记，保证引导只跑一次且定时器不被 cleanup 误清
let booted = false;

export default function App() {
  const terminal = useTerminal();
  const { write, writeLine } = terminal;
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [report, setReport] = useState<EnvReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [initState, setInitState] = useState<InitState | null>(null);
  const [engageBusy, setEngageBusy] = useState(false);
  const [neocomActive, setNeocomActive] = useState<NeocomKey | null>(null);
  const { cards, services, anyActive, anyBusy } = useServices(report);
  // 主进程 → 渲染层：终端数据流 / 退出事件
  useEffect(
    () =>
      window.api.onTerminalData((tabId, data) => {
        write(tabId, data);
      }),
    [write]
  );
  useEffect(
    () =>
      window.api.onTerminalExit((tabId, code) => {
        writeLine(tabId, `\x1b[31m[进程退出] exit code ${code}\x1b[0m`);
      }),
    [writeLine]
  );

  // 环境初始化状态：订阅推送；任务结束（busy true→false）时自动重新检测刷新看板
  useEffect(() => {
    let prevBusy = false;
    window.api
      .initState()
      .then((s) => {
        setInitState(s);
        prevBusy = s.busy;
      })
      .catch(() => {});
    return window.api.onInitChanged((s) => {
      setInitState(s);
      if (prevBusy && !s.busy) {
        terminal.writeLine("system", "\x1b[36m[初始化] 完成，正在重新检测环境…\x1b[0m");
        void window.api.envCheck().then((r) => {
          setReport(r);
          // 只更新看板 + 输出一行摘要；不重复打印完整报告，避免把初始化日志滚出视口
          const failed = r.checks.filter((i) => i.status === "fail").length;
          const warn = r.checks.filter((i) => i.status === "warn").length;
          terminal.writeLine(
            "system",
            `\x1b[36m[初始化] 重新检测完成：${r.checks.length - failed - warn}/${r.checks.length} 项通过${warn ? ` · ${warn} 项警告` : ""}${failed ? ` · ${failed} 项未达标` : ""}\x1b[0m`
          );
        });
      }
      prevBusy = s.busy;
    });
  }, [terminal, writeLine]);

  // 启动引导：应用信息 + 欢迎横幅 + 首次自检（只执行一次）
  useEffect(() => {
    if (booted) return;
    booted = true;
    window.api.appInfo().then(setAppInfo).catch(() => {});
    const t = setTimeout(() => {
      write(
        "system",
        [
          "",
          "\x1b[36m  EvEJS 启动器 · 一键启动（Phase 3-4）\x1b[0m",
          "\x1b[90m  ─────────────────────────────────────────────────────\x1b[0m",
          "\x1b[90m  ›\x1b[0m 点击 \x1b[33m一键启动\x1b[0m：环境自检门禁 → 主服务器 → 市场服务 → 客户端",
          "\x1b[90m  ›\x1b[0m 服务页签实时日志（node-pty + ConPTY），崩溃自动标记 ERROR",
          "\x1b[90m  ›\x1b[0m 左侧 Neocom：设置 = 配置/回写 · 帮助 = 指引",
          ""
        ].join("\r\n") + "\r\n"
      );
      window.api
        .envCheck()
        .then((r) => {
          setReport(r);
          printEnvReport(r, terminal);
        })
        .catch(() => {});
    }, 500);
    // 注意：不清除定时器 —— StrictMode 模拟卸载会误清，导致引导不执行
  }, [write, writeLine, terminal]);

  // 环境自检（看板「重新检测」）
  const runEnvCheck = useCallback(
    async (announce: boolean) => {
      if (checking) return;
      setChecking(true);
      if (announce) terminal.writeLine("system", "\r\n\x1b[33m[一键启动] 正在执行环境自检...\x1b[0m");
      try {
        const rep = await window.api.envCheck();
        setReport(rep);
        printEnvReport(rep, terminal);
      } catch (err) {
        terminal.writeLine("system", `\x1b[31m[自检] 失败：${String(err)}\x1b[0m`);
      } finally {
        setChecking(false);
      }
    },
    [checking, terminal]
  );

  // ENGAGE：环境自检门禁 → 一键启动全部服务（主进程串行 + 端口等待 + 状态推送）
  const onEngage = useCallback(async () => {
    if (engageBusy || checking) return;
    setEngageBusy(true);
    terminal.writeLine("system", "\r\n\x1b[33m[一键启动] 环境自检门禁 + 启动全部服务…\x1b[0m");
    try {
      const rep = await window.api.envCheck();
      setReport(rep);
      printEnvReport(rep, terminal);
      const critical = ["node", "serverDeps", "localDb"];
      const failKeys = rep.checks.filter((c) => !c.ok && critical.includes(c.key));
      if (failKeys.length > 0) {
        terminal.writeLine("system", "\x1b[31m[一键启动] 关键环境未达标（Node/依赖/数据库），已中止。请先修复后重试。\x1b[0m");
        return;
      }
      const res = await window.api.engageStart();
      if (!res.ok) terminal.writeLine("system", `\x1b[31m[一键启动] 启动序列中止：${res.reason}\x1b[0m`);
    } catch (err) {
      terminal.writeLine("system", `\x1b[31m[一键启动] 失败：${String(err)}\x1b[0m`);
    } finally {
      setEngageBusy(false);
    }
  }, [engageBusy, checking, terminal]);

  const onStopAll = useCallback(async () => {
    if (engageBusy) return;
    setEngageBusy(true);
    try {
      await window.api.engageStop();
    } catch (err) {
      terminal.writeLine("system", `\x1b[31m[STOP] 失败：${String(err)}\x1b[0m`);
    } finally {
      setEngageBusy(false);
    }
  }, [engageBusy, terminal]);

  const onRerunEnv = useCallback(() => {
    void runEnvCheck(false);
  }, [runEnvCheck]);

  const onConfigSaved = useCallback(() => {
    void runEnvCheck(false);
  }, [runEnvCheck]);

  const onNeocom = useCallback(
    (key: NeocomKey) => {
      setNeocomActive(key);
      switch (key) {
        case "services":
          terminal.writeLine("system", "\x1b[90m[导航] 环境自检看板固定在右侧，无需弹出\x1b[0m");
          break;
        case "settings":
          setConfigOpen(true);
          break;
        case "help":
          terminal.writeLine("system", "");
          terminal.writeLine("system", "\x1b[36m[帮助] 操作指引\x1b[0m");
          terminal.writeLine("system", "  \x1b[90m›\x1b[0m 一键启动：环境自检门禁 → 启动（主服务器 / 市场 / 客户端）");
          terminal.writeLine("system", "  \x1b[90m›\x1b[0m 停止全部：终止本启动器拉起的全部服务");
          terminal.writeLine("system", "  \x1b[90m›\x1b[0m 服务卡片：单服务 启动 / 停止 / 重启，状态实时推送");
          terminal.writeLine("system", "  \x1b[90m›\x1b[0m 设置：服务器端口（只读）+ 客户端配置回写 + 启动选项");
          terminal.writeLine("system", "  \x1b[90m›\x1b[0m 右侧看板：环境检测项常驻，FAIL 项可一键初始化 / 跳官网安装");
          break;
        case "tasks":
          setLogOpen(true);
          terminal.writeLine("system", "\x1b[90m[导航] 任务视图 = 服务器日志（server/logs/server.log）\x1b[0m");
          break;
        case "accounts":
          setAccountOpen(true);
          terminal.writeLine("system", "\x1b[90m[导航] 账号管理：玩家列表 / 头像 / 删除（删除需先停止全部服务）\x1b[0m");
          break;
        case "manual":
          setManualOpen(true);
          break;
      }
    },
    [terminal]
  );

  const engageBusyNow = engageBusy || anyBusy;

  // 主服务器与市场服务都已运行时，一键启动无可启动目标 → 置灰禁用（客户端可在卡片单独启动）
  const serverRunning = services.some((s) => s.id === "mainServer" && s.state === "running");
  const marketRunning = services.some((s) => s.id === "marketServer" && s.state === "running");
  const engageDisabled = serverRunning && marketRunning;

  return (
    <div className="eve-app">
      <NeocomBar active={neocomActive} onSelect={onNeocom} />
      <div className="eve-main">
        <header className="titlebar">
          <div className="brand">
            <img src={logoUrl} alt="EvEJS" width="26" height="26" draggable={false} />
            <span className="brand-name">EvEJS 启动器</span>
            <span className="brand-ver">v{appInfo?.version ?? "0.1.0"}</span>
            {appInfo && <span className="brand-phase">{appInfo.phase}</span>}
          </div>
          <div className="win-controls">
            <div className="win-btn" onClick={() => window.api.windowMinimize()} title="最小化">
              ─
            </div>
            <div className="win-btn" onClick={() => window.api.windowToggleMaximize()} title="最大化">
              □
            </div>
            <div className="win-btn close" onClick={() => window.api.windowClose()} title="关闭">
              ✕
            </div>
          </div>
        </header>

        <section className="cards">
          {cards.map((c) => (
            <ServiceCard key={c.id} {...c} />
          ))}
          <div className="svc-card login-card">
            <h3>
              <span className="led led-ready" />
              账号登录
              <span className="svc-status-label">LAUNCHER</span>
            </h3>
            <div className="svc-subtitle">EVE · LOGIN</div>
            <LoginBox />
          </div>
        </section>

        <div className="engage-wrap">
          <StartButton busy={engageBusyNow} disabled={engageDisabled} onClick={() => void onEngage()} />
          {anyActive && (
            <button className="btn-secondary btn-stop" onClick={() => void onStopAll()} disabled={engageBusyNow}>
              停止全部
            </button>
          )}
          <span className="engage-hint">
            {engageBusyNow
              ? "正在执行..."
              : engageDisabled
                ? "主服务器与市场服务已运行；客户端可在卡片单独启动"
                : "环境自检门禁 → 一键启动全部服务"}
          </span>
        </div>

        <TerminalPanel terminal={terminal} />

        <StatusBar appInfo={appInfo} report={report} checking={checking} services={services} />
      </div>

      <EnvBoard
        report={report}
        checking={checking}
        onRerun={onRerunEnv}
        initState={initState}
      />

      <ConfigPanel open={configOpen} onClose={() => setConfigOpen(false)} onSaved={onConfigSaved} />
      <LogPanel open={logOpen} onClose={() => setLogOpen(false)} />
      <ManualPanel open={manualOpen} onClose={() => setManualOpen(false)} />
      <AccountPanel open={accountOpen} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
