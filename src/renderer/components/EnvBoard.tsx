import type { CheckItem, EnvReport, InitState, SysResource } from "../types";

interface Props {
  report: EnvReport | null;
  checking: boolean;
  onRerun(): void;
  initState: InitState | null;
}

type ItemState = "ok" | "warn" | "fail";

function stateOf(c: CheckItem): ItemState {
  if (c.ok) return "ok";
  if (c.warn) return "warn";
  return "fail";
}

const STATE_TEXT: Record<ItemState, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };
const LED_CLASS: Record<ItemState, string> = { ok: "led-ready", warn: "led-warn", fail: "led-error" };

/** 系统资源（内存 / CPU 线程）状态灯：>8GB 且 >8 线程绿；恰为 8/8 黄；任一小于 8 红 */
function sysState(s: SysResource): ItemState {
  return s.level;
}

/** 可在启动器内初始化的检测项 → 初始化任务 key（首次启动未通过时显示「初始化」按钮） */
const INIT_KEYS: Record<string, string> = {
  serverDeps: "deps",
  localDb: "db",
  market: "market",
  clientPath: "client",
  caCert: "ca"
};

/** 环境自检看板（右侧常驻分栏）：逐项状态灯 + 提示 + 初始化按钮（带进度条、并发互斥） */
export default function EnvBoard({ report, checking, onRerun, initState }: Props) {
  const checks = report?.checks ?? [];
  const pass = report?.passCount ?? 0;
  const total = report?.totalCount ?? 0;
  const initBusy = !!initState?.busy;
  const initKey = initState?.key ?? null;
  const initProgress = initState?.progress ?? null;

  const runInit = (key: string) => {
    void window.api.initRun(key).catch(() => {});
  };

  return (
    <aside className="env-panel">
      <div className="env-panel-head">
        <h2>环境自检</h2>
        <button className="btn-secondary btn-sm" onClick={onRerun} disabled={checking || initBusy}>
          {checking ? "检测中..." : "重新检测"}
        </button>
      </div>

      {!report && <div className="cfg-loading">等待检测结果...</div>}

      {report && (
        <>
          <div className="env-summary">
            通过 {pass}/{total} 项 · Node {report.node.version}
          </div>
          {initBusy && (
            <div className="env-init-tip">
              正在初始化「{initState?.label}」… 日志见下方终端，请勿重复操作
            </div>
          )}
          {report.sys && (
            <div className="env-row">
              <span className={`led ${LED_CLASS[sysState(report.sys)]}`} />
              <div className="env-main">
                <div className="env-title">
                  <span className="env-label">系统资源</span>
                  <span className={`env-status ${sysState(report.sys)}`}>
                    {STATE_TEXT[sysState(report.sys)]}
                  </span>
                </div>
                <div className="env-msg">{report.sys.message}</div>
              </div>
            </div>
          )}
          <div className="env-list">
            {checks.map((c) => {
              const st = stateOf(c);
              const initTask = INIT_KEYS[c.key];
              const isThisInit = initBusy && initKey === initTask;
              return (
                <div key={c.key} className="env-row">
                  <span className={`led ${LED_CLASS[st]}`} />
                  <div className="env-main">
                    <div className="env-title">
                      <span className="env-label">{c.label}</span>
                      <span className={`env-status ${st}`}>{STATE_TEXT[st]}</span>
                    </div>
                    <div className="env-msg">{c.message}</div>
                    {!c.ok && c.hint && <div className="env-hint">↳ {c.hint}</div>}
                    {isThisInit && (
                      <div className="env-progress">
                        <div
                          className={`env-progress-fill${initProgress === null ? " indeterminate" : ""}`}
                          style={initProgress === null ? undefined : { width: `${initProgress}%` }}
                        />
                      </div>
                    )}
                  </div>
                  {initTask && !c.ok && (
                    <button
                      className="env-init"
                      disabled={initBusy}
                      onClick={() => void runInit(initTask)}
                    >
                      {isThisInit ? "初始化中…" : "初始化"}
                    </button>
                  )}
                  {!c.ok && c.installUrl && !initTask && (
                    <button
                      className="env-install"
                      onClick={() => void window.api.openExternal(c.installUrl!)}
                    >
                      官网安装
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}
