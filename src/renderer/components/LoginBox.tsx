import { useEffect, useState } from "react";

interface Settings {
  loginUser?: string;
  loginPassword?: string;
}

/**
 * 账号登录卡片（主界面第 4 列）：
 * 正面 = 登录表单；点"修改密码"卡片 3D 翻转 → 背面修改密码表单，点 X 翻转回来。
 */
export default function LoginBox() {
  const [flipped, setFlipped] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwdOld, setPwdOld] = useState("");
  const [pwdNew, setPwdNew] = useState("");
  const [pwdNew2, setPwdNew2] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    window.api.settingsGet().then((s) => {
      const st = s as Settings;
      if (st.loginUser) setUser(st.loginUser);
      if (st.loginPassword) {
        setPassword(st.loginPassword);
        setRemember(true);
      }
    }).catch(() => undefined);
  }, []);

  const saveSettings = async (patch: Record<string, unknown>) => {
    try {
      await window.api.settingsSet(patch);
    } catch {
      /* 忽略保存失败 */
    }
  };

  const doLogin = async () => {
    if (!user.trim() || !password) {
      setMsg({ ok: false, text: "请输入账号和密码" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await window.api.loginStart(user.trim(), password);
      setMsg({ ok: res.ok, text: res.ok ? "登录成功，客户端启动中" : res.reason ?? "登录失败" });
      if (res.ok) {
        await saveSettings({
          loginUser: remember ? user.trim() : undefined,
          loginPassword: remember ? password : undefined
        });
      }
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const doChangePassword = async () => {
    if (!pwdOld || !pwdNew || pwdNew !== pwdNew2) {
      setPwdMsg({ ok: false, text: pwdNew !== pwdNew2 ? "两次新密码不一致" : "请填写完整" });
      return;
    }
    if (pwdNew.length < 4) {
      setPwdMsg({ ok: false, text: "新密码至少 4 位" });
      return;
    }
    setPwdBusy(true);
    setPwdMsg(null);
    try {
      const res = await window.api.accountsSetPassword(user.trim(), pwdOld, pwdNew);
      setPwdMsg({ ok: res.ok, text: res.ok ? "密码已修改（立即生效）" : res.reason ?? "修改失败" });
      if (res.ok) {
        setPwdOld("");
        setPwdNew("");
        setPwdNew2("");
        setTimeout(() => setFlipped(false), 600);
      }
    } catch (e) {
      setPwdMsg({ ok: false, text: String(e) });
    } finally {
      setPwdBusy(false);
    }
  };

  return (
    <div className={`login-flip ${flipped ? "flipped" : ""}`}>
      {/* 正面：登录 */}
      <div className="login-face login-front">
        <input
          className="cfg-input"
          value={user}
          placeholder="账号"
          autoComplete="off"
          onChange={(e) => setUser(e.target.value)}
        />
        <input
          className="cfg-input"
          type="password"
          value={password}
          placeholder="密码"
          autoComplete="off"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void doLogin(); }}
        />
        <div className="login-btn-row">
          <button className="btn-primary btn-sm login-go" onClick={() => void doLogin()} disabled={busy}>
            {busy ? "验证中…" : "登 录"}
          </button>
          <button className="btn-secondary btn-sm login-chpwd" onClick={() => { setFlipped(true); setMsg(null); }}>
            修改密码
          </button>
        </div>
        <div className="login-tools">
          <label className="cfg-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住密码
          </label>
          <span className="login-tip">直达角色选择</span>
        </div>
        {msg && (
          <div className={`login-msg login-msg-inline ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>
        )}
      </div>

      {/* 背面：修改密码 */}
      <div className="login-face login-back">
        <div className="login-back-head">
          <span className="login-back-title">修改密码</span>
          <button className="login-x" onClick={() => setFlipped(false)} title="返回登录" aria-label="返回">
            ✕
          </button>
        </div>
        <input
          className="cfg-input"
          type="password"
          value={pwdOld}
          placeholder="旧密码"
          autoComplete="off"
          onChange={(e) => setPwdOld(e.target.value)}
        />
        <input
          className="cfg-input"
          type="password"
          value={pwdNew}
          placeholder="新密码"
          autoComplete="off"
          onChange={(e) => setPwdNew(e.target.value)}
        />
        <input
          className="cfg-input"
          type="password"
          value={pwdNew2}
          placeholder="确认新密码"
          autoComplete="off"
          onChange={(e) => setPwdNew2(e.target.value)}
        />
        <button className="btn-primary btn-sm login-go" onClick={() => void doChangePassword()} disabled={pwdBusy}>
          {pwdBusy ? "提交中…" : "确认修改"}
        </button>
        {pwdMsg && (
          <div className={`login-msg login-msg-inline ${pwdMsg.ok ? "ok" : "err"}`}>{pwdMsg.text}</div>
        )}
      </div>
    </div>
  );
}
