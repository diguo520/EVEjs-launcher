import { useEffect, useMemo, useState } from "react";
import type { ServerLogResult } from "../types";

interface Props {
  open: boolean;
  onClose(): void;
}

/** 日志级别 → CSS class（着色） */
function levelClass(line: string): string {
  const m = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*\[([A-Z]+)\]/.exec(line);
  if (!m) return "";
  switch (m[1]) {
    case "ERR":
    case "FTL":
      return "log-err";
    case "WRN":
      return "log-wrn";
    case "SUC":
      return "log-suc";
    case "DBG":
      return "log-dbg";
    default:
      return "log-inf";
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 任务视图 = 服务器日志：读取 server/logs/server.log，级别着色 + 滚动 + 刷新 */
export default function LogPanel({ open, onClose }: Props) {
  const [data, setData] = useState<ServerLogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    setError("");
    window.api
      .readServerLog()
      .then((r) => setData(r))
      .catch((e: unknown) => {
        setError(String(e));
        setData(null);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    load();
  }, [open]);

  const rows = useMemo(() => {
    if (!data?.exists) return [];
    return data.lines;
  }, [data]);

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal log-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-close" onClick={onClose} title="关闭">
          ✕
        </div>
        <h2>任务视图 · 服务器日志</h2>

        <div className="log-toolbar">
          <span className="log-meta" title={data?.path ?? ""}>
            {data?.path ?? "…"}
          </span>
          {data?.exists ? (
            <span className="log-meta">
              {rows.length} 行 · {fmtSize(data.size)} · 更新 {fmtTime(data.mtime)}
            </span>
          ) : (
            <span className="log-meta log-empty-tip">文件不存在或为空</span>
          )}
          <button className="btn-secondary btn-sm" onClick={load} disabled={loading}>
            {loading ? "读取中…" : "刷新"}
          </button>
        </div>

        {error && <div className="cfg-error">{error}</div>}

        <div className="log-body">
          {!data && !error && <div className="cfg-loading">读取中...</div>}
          {data && !data.exists && (
            <div className="log-empty">
              未找到日志文件
              <div className="log-empty-sub">{data.path}</div>
            </div>
          )}
          {data?.exists && rows.length === 0 && <div className="log-empty">日志文件为空</div>}
          {rows.length > 0 && (
            <div className="log-lines">
              {rows.map((l, i) => (
                <div key={i} className={`log-line ${levelClass(l)}`}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="cfg-foot">读取 server/logs/server.log · 级别着色：红=错误 黄=警告 绿=成功 灰=调试</div>
      </div>
    </div>
  );
}
