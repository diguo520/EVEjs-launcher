import { useEffect, useMemo, useRef, useState } from "react";
import type { TerminalApi } from "../hooks/useTerminal";

interface Props {
  terminal: TerminalApi;
}

interface TabDef {
  id: string;
  label: string;
}

const TABS: TabDef[] = [
  { id: "system", label: "系统" },
  { id: "mainServer", label: "主服务器" },
  { id: "market", label: "市场服务" },
  { id: "client", label: "客户端" }
];

/**
 * 内嵌终端面板（技术方案 5.1）：
 * 多页签 xterm 实例，随窗口尺寸自适应，键盘输入回传主进程。
 */
export default function TerminalPanel({ terminal }: Props) {
  const [active, setActive] = useState("system");
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // 每个页签注册独立 xterm 实例。
  // 注意：ref 回调必须用 useMemo 固化 —— 若每次渲染生成新闭包，
  // React 会 detach 旧 ref（销毁 xterm）再 attach 新 ref（重建），
  // 导致任何父组件重渲染都会清空终端内容。
  const refs = useMemo(() => {
    const map: Record<string, (el: HTMLDivElement | null) => void> = {};
    for (const t of TABS) {
      map[t.id] = (el) => {
        paneRefs.current[t.id] = el;
        terminal.register(t.id, el);
      };
    }
    return map;
  }, [terminal]);

  // 激活页签时自适应尺寸 + 焦点
  useEffect(() => {
    terminal.setActive(active);
    const el = paneRefs.current[active];
    if (!el) return;
    const ro = new ResizeObserver(() => terminal.fitTab(active));
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, terminal]);

  return (
    <div className="term-panel">
      <div className="term-tabs">
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`term-tab${active === t.id ? " active" : ""}`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </div>
        ))}
        <div className="term-tab-spacer" />
        <span className="term-hint">吉他 商贸中心</span>
      </div>
      <div className="term-body">
        {TABS.map((t) => (
          <div
            key={t.id}
            ref={refs[t.id]}
            className={`term-pane${active === t.id ? "" : " hidden"}`}
          />
        ))}
      </div>
    </div>
  );
}
