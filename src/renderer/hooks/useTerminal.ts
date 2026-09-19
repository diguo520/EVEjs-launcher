import { useCallback, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/** EVE 风格 xterm 主题（与 eve-theme.css token 一致） */
const TERM_THEME = {
  background: "#0a0f17",
  foreground: "#c8d3e0",
  cursor: "#5fc8ff",
  cursorAccent: "#0b0e14",
  selectionBackground: "#1d4a66",
  black: "#0b0e14",
  red: "#e05555",
  green: "#a8d24a",
  yellow: "#ffd24a",
  blue: "#5fc8ff",
  magenta: "#c792ea",
  cyan: "#67d8e8",
  white: "#c8d3e0",
  brightBlack: "#6b7f95",
  brightRed: "#ff6b6b",
  brightGreen: "#c4e06a",
  brightYellow: "#ffe27a",
  brightBlue: "#8fd8ff",
  brightMagenta: "#dba4ff",
  brightCyan: "#8fe8f4",
  brightWhite: "#eef5fb"
};

export interface TerminalApi {
  register(tabId: string, el: HTMLElement | null): void;
  write(tabId: string, data: string): void;
  writeLine(tabId: string, text: string): void;
  fitTab(tabId: string): void;
  setActive(tabId: string): void;
}

/**
 * 多页签 xterm 实例注册表（技术方案 5.1）：
 * 每个页签独立 Terminal + FitAddon，键盘输入回传主进程 PTY。
 */
export function useTerminal(): TerminalApi {
  const regRef = useRef<Map<string, { term: Terminal; fit: FitAddon }>>(new Map());
  const openedRef = useRef<Set<string>>(new Set());

  const register = useCallback((tabId: string, el: HTMLElement | null) => {
    const map = regRef.current;
    if (!el) {
      const existing = map.get(tabId);
      if (existing) {
        try {
          existing.term.dispose();
        } catch {
          /* ignore */
        }
        map.delete(tabId);
        openedRef.current.delete(tabId);
      }
      return;
    }
    const existing = map.get(tabId);
    if (existing) {
      if (!openedRef.current.has(tabId)) {
        existing.term.open(el);
        openedRef.current.add(tabId);
      }
      requestAnimationFrame(() => {
        try {
          existing.fit.fit();
        } catch {
          /* 容器不可见时忽略 */
        }
      });
      return;
    }
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 10000,
      theme: TERM_THEME,
      allowTransparency: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    openedRef.current.add(tabId);
    term.onData((d) => window.api.terminalInput(tabId, d));
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    map.set(tabId, { term, fit });
  }, []);

  const write = useCallback((tabId: string, data: string) => {
    const t = regRef.current.get(tabId);
    if (t) {
      t.term.write(data);
      // xterm DOM renderer 偶发"内容入 buffer 但视口行文本不重绘"（陈旧渲染）。
      // flush 强制解析 write 队列；scrollToBottom 让视口跟随；全量 refresh 强制重绘行文本。
      try {
        t.term.flush();
      } catch {
        /* ignore */
      }
      try {
        t.term.scrollToBottom();
      } catch {
        /* ignore */
      }
      try {
        t.term.refresh(0, t.term.buffer.active.length - 1);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const writeLine = useCallback((tabId: string, text: string) => {
    const norm = text.replace(/\r?\n/g, "\r\n");
    regRef.current.get(tabId)?.term.write(norm + "\r\n");
  }, []);

  const fitTab = useCallback((tabId: string) => {
    const t = regRef.current.get(tabId);
    if (t) {
      try {
        t.fit.fit();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const setActive = useCallback((tabId: string) => {
    const t = regRef.current.get(tabId);
    if (t) {
      try {
        t.term.focus();
        t.fit.fit();
      } catch {
        /* ignore */
      }
    }
  }, []);

  // 返回稳定对象：任何父组件重渲染都不应改变 api 引用，
  // 否则依赖它的 useMemo（如 TerminalPanel 的 ref 回调）会重建并销毁 xterm。
  return useMemo<TerminalApi>(
    () => ({ register, write, writeLine, fitTab, setActive }),
    [register, write, writeLine, fitTab, setActive]
  );
}
