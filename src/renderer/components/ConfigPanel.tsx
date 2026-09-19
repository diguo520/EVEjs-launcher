import { useEffect, useState } from "react";
import type { ClientConfig, ConfigBundle } from "../types";

interface Props {
  open: boolean;
  onClose(): void;
  onSaved(): void;
}

interface Settings {
  startClient?: boolean;
  startMarket?: boolean;
}

/** 配置面板：服务器端口只读 + 客户端配置可编辑回写 + 启动选项（登录框位于主界面游戏客户端卡片下） */
export default function ConfigPanel({ open, onClose, onSaved }: Props) {
  const [cfg, setCfg] = useState<ConfigBundle | null>(null);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [settings, setSettings] = useState<Settings>({});
  const [draft, setDraft] = useState<ClientConfig | null>(null);

  useEffect(() => {
    if (!open) return;
    setCfg(null);
    setError("");
    setSavedMsg("");
    window.api
      .getConfig()
      .then((b) => {
        setCfg(b);
        setDraft({ ...b.client });
      })
      .catch((e: unknown) => setError(String(e)));
    window.api.settingsGet().then((s) => setSettings(s as Settings)).catch(() => {});
  }, [open]);

  if (!open) return null;

  const saveClient = async () => {
    if (!draft) return;
    setError("");
    setSavedMsg("");
    const res = await window.api.configSetClient({
      clientPath: draft.clientPath,
      clientExe: draft.clientExe,
      caPem: draft.caPem,
      proxyUrl: draft.proxyUrl
    });
    if (!res.ok) {
      setError(res.reason ?? "保存失败");
      return;
    }
    setCfg((c) => (c ? { ...c, client: res.client } : c));
    setSavedMsg("已回写 " + res.client.sourceFile);
    onSaved();
  };

  const saveSettings = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await window.api.settingsSet(next);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-close" onClick={onClose} title="关闭">
          ✕
        </div>
        <h2>配置 · CONFIG</h2>
        {error && <div className="cfg-error">{error}</div>}
        {savedMsg && <div className="cfg-saved">✓ {savedMsg}</div>}
        {!cfg && !error && <div className="cfg-loading">读取中...</div>}
        {cfg && draft && (
          <>
            <div className="cfg-group">服务器端口（config/server.json · 只读）</div>
            <div className="cfg-row">
              <span className="k">游戏服务器</span>
              <span className="v">{cfg.server.ports.game} (TCP)</span>
            </div>
            <div className="cfg-row">
              <span className="k">图片服务</span>
              <span className="v">{cfg.server.ports.images} (HTTP)</span>
            </div>
            <div className="cfg-row">
              <span className="k">网关 / 代理</span>
              <span className="v">{cfg.server.ports.gateway} (HTTP)</span>
            </div>
            <div className="cfg-row">
              <span className="k">来源</span>
              <span className="v">{cfg.server.sourceFile}</span>
            </div>

            <div className="cfg-group">客户端配置（EvEJSConfig.bat · 可回写）</div>
            <div className="cfg-row">
              <span className="k">客户端路径</span>
              <input
                className="cfg-input"
                value={draft.clientPath}
                placeholder="如 F:\EVE Online - 3396210\tq"
                onChange={(e) => setDraft({ ...draft, clientPath: e.target.value })}
              />
            </div>
            <div className="cfg-row">
              <span className="k">客户端 EXE</span>
              <input
                className="cfg-input"
                value={draft.clientExe}
                placeholder="留空自动 bin64/exefile.exe"
                onChange={(e) => setDraft({ ...draft, clientExe: e.target.value })}
              />
            </div>
            <div className="cfg-row">
              <span className="k">CA 证书</span>
              <input
                className="cfg-input"
                value={draft.caPem}
                placeholder="如 %EVEJS_REPO_ROOT%\server\certs\xmpp-ca-cert.pem"
                onChange={(e) => setDraft({ ...draft, caPem: e.target.value })}
              />
            </div>
            <div className="cfg-row">
              <span className="k">代理地址</span>
              <input
                className="cfg-input"
                value={draft.proxyUrl}
                onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })}
              />
            </div>
            <div className="cfg-row">
              <span className="k">配置来源</span>
              <span className="v">{cfg.client.sourceFile || "（未找到）"}</span>
            </div>
            <div className="cfg-actions">
              <button className="btn-secondary btn-sm" onClick={() => void saveClient()} disabled={savedMsg !== ""}>
                保存配置
              </button>
            </div>

            <div className="cfg-group">启动选项（一键启动）</div>
            <label className="cfg-check">
              <input
                type="checkbox"
                checked={settings.startClient !== false}
                onChange={(e) => void saveSettings({ startClient: e.target.checked })}
              />
              随启动拉起游戏客户端
            </label>
            <label className="cfg-check">
              <input
                type="checkbox"
                checked={settings.startMarket !== false}
                onChange={(e) => void saveSettings({ startMarket: e.target.checked })}
              />
              随启动拉起市场服务
            </label>
          </>
        )}
        <div className="cfg-foot">服务器端口只读 · 客户端配置保存即回写 EvEJSConfig.bat</div>
      </div>
    </div>
  );
}
