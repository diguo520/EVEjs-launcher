import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountInfo, AccountOpResult, AccountRole } from "../types";

interface Props {
  open: boolean;
  onClose(): void;
}

/** 由 characterId 派生的稳定色相（EVE 风格） */
function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** 角色头像：优先显示游戏内肖像（上传的捏脸肖像或默认肖像），无任何图时兜底虚拟头像 */
function Portrait({ role, size }: { role: AccountRole; size: number }) {
  if (role.avatar) {
    return <img src={role.avatar} width={size} height={size} className="acc-avatar-img" alt={role.characterName} />;
  }
  return <Avatar name={role.characterName} id={role.characterId} size={size} />;
}
function Avatar({ name, id, size }: { name: string; id: string; size: number }) {
  const h = hueOf(id);
  const id1 = `ag-${h}-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="acc-avatar">
      <defs>
        <linearGradient id={id1} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${h}, 55%, 22%)`} />
          <stop offset="100%" stopColor={`hsl(${(h + 40) % 360}, 60%, 10%)`} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${id1})`} stroke="rgba(255, 170, 60, 0.65)" strokeWidth="2" />
      <circle cx="32" cy="32" r="22" fill="none" stroke="rgba(0, 212, 255, 0.35)" strokeWidth="1" />
      <text x="32" y="40" textAnchor="middle" fontSize="26" fill="#f4f6fb" fontFamily="'Segoe UI','Microsoft YaHei',sans-serif" fontWeight="600">
        {(name || "?").slice(0, 1).toUpperCase()}
      </text>
    </svg>
  );
}

function fmtSec(sec: number | null): string {
  if (sec === null || sec === undefined) return "—";
  const v = sec.toFixed(2);
  if (sec >= 5) return `+${v}`;
  if (sec >= 0) return `+${v} 合法`;
  if (sec >= -2) return `${v} 低安`;
  return `${v} 海盗`;
}

export default function AccountPanel({ open, onClose }: Props) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [serverRunning, setServerRunning] = useState(false);
  const [confirming, setConfirming] = useState<AccountInfo | null>(null);
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    // 账号列表先渲染，运行检测异步后置更新（不阻塞列表）
    window.api
      .accountsList()
      .then((acc) => {
        if (acc.ok && acc.data) setAccounts(acc.data);
        else setError(acc.reason || "读取账号失败");
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
    window.api
      .accountsCheckRunning()
      .then((run) => setServerRunning(run.running))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const roleCount = useMemo(() => accounts.reduce((n, a) => n + a.roles.length, 0), [accounts]);

  // 预览删除计划
  const onPreview = (acc: AccountInfo) => {
    setConfirming(acc);
    setPreview("");
    setPreviewing(true);
    window.api
      .accountsDelete(acc.accountKey, false)
      .then((r: AccountOpResult) => setPreview(r.output || (r.ok ? "" : r.reason || "")))
      .catch((e: unknown) => setPreview(String(e)))
      .finally(() => setPreviewing(false));
  };

  // 确认执行
  const onDelete = (acc: AccountInfo) => {
    setDeleting(true);
    setError("");
    window.api
      .accountsDelete(acc.accountKey, true)
      .then((r: AccountOpResult) => {
        if (r.ok) {
          setDone(`账号 ${acc.accountKey} 已删除（备份已生成）`);
          setConfirming(null);
          load();
        } else {
          setError(r.reason || "删除失败");
          setConfirming(null);
        }
      })
      .catch((e: unknown) => {
        setError(String(e));
        setConfirming(null);
      })
      .finally(() => setDeleting(false));
  };

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal acc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-close" onClick={onClose} title="关闭">
          ✕
        </div>
        <h2>账号管理</h2>

        <div className="acc-toolbar">
          <span className="acc-meta">
            {accounts.length} 个账号 · {roleCount} 个角色
          </span>
          {serverRunning ? (
            <span className="acc-warn">服务运行中，删除已禁用（请先「停止全部」）</span>
          ) : (
            <span className="acc-ok">服务已停止，可安全删除</span>
          )}
          <button className="btn-secondary btn-sm" onClick={load} disabled={loading}>
            {loading ? "读取中…" : "刷新"}
          </button>
        </div>

        {error && <div className="cfg-error">{error}</div>}
        {done && <div className="acc-done">{done}</div>}

        <div className="acc-body">
          {loading && !accounts.length && <div className="cfg-loading">读取中...</div>}
          {!loading && !accounts.length && !error && <div className="log-empty">暂无账号</div>}
          {accounts.map((acc) => (
            <div className="acc-card" key={acc.accountKey}>
              <div className="acc-rows">
                {acc.roles.length === 0 && (
                  <div className="acc-row">
                    <Avatar name="?" id={acc.accountKey} size={44} />
                    <div className="acc-info">
                      <div className="acc-name">（无角色）</div>
                      <div className="acc-sub">账号 {acc.accountKey}</div>
                    </div>
                  </div>
                )}
                {acc.roles.map((r) => (
                  <div className="acc-row" key={r.characterId}>
                    <Portrait role={r} size={44} />
                    <div className="acc-info">
                      <div className="acc-name">
                        {r.characterName}
                        {acc.isGM && <span className="acc-badge acc-badge-gm">GM</span>}
                        {acc.banned && <span className="acc-badge acc-badge-ban">封禁</span>}
                      </div>
                      <div className="acc-sub">
                        账号 {acc.accountKey} · 安全 {fmtSec(r.securityStatus)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button
                className="btn-secondary btn-sm btn-danger"
                disabled={serverRunning || deleting || !!confirming}
                onClick={() => onPreview(acc)}
              >
                删除
              </button>
            </div>
          ))}
        </div>

        {/* 删除确认 */}
        {confirming && (
          <div className="acc-confirm">
            <div className="acc-confirm-title">
              删除账号 {confirming.accountKey}
              {confirming.roles.length > 0 && (
                <span className="acc-confirm-sub">
                  （{confirming.roles.map((r) => r.characterName).join("、")}）
                </span>
              )}
            </div>
            <pre className="acc-preview">{previewing ? "正在读取删除计划…" : preview || "（无计划输出）"}</pre>
            <div className="acc-confirm-actions">
              <button className="btn-secondary btn-sm" onClick={() => setConfirming(null)} disabled={deleting}>
                取消
              </button>
              <button
                className="btn-secondary btn-sm btn-danger"
                onClick={() => onDelete(confirming)}
                disabled={deleting || previewing}
              >
                {deleting ? "删除中…" : "确认删除（自动备份）"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
