import * as net from "net";

/** TCP 端口探活（net.connect 探测） */
export function checkTcp(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

/** 测量到目标端口的 TCP 建连耗时（毫秒）；连不上返回 null */
export function measureTcpLatency(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const started = Date.now();
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(Date.now() - started));
    sock.once("timeout", () => finish(null));
    sock.once("error", () => finish(null));
    sock.connect(port, host);
  });
}

/** HTTP 探活：任何 2xx/3xx/4xx 响应都视为服务在线 */
export async function checkHttp(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

export interface HealthResult {
  game: boolean;    // 26000 TCP
  images: boolean;  // 26001 HTTP /
  gateway: boolean; // 26002 HTTP /health
  market: boolean;  // 40110 TCP（market-server.local.toml）
}

export async function checkAll(): Promise<HealthResult> {
  const [game, images, gateway, market] = await Promise.all([
    checkTcp(26000),
    checkHttp("http://127.0.0.1:26001/"),
    checkHttp("http://127.0.0.1:26002/health"),
    checkTcp(40110)
  ]);
  return { game, images, gateway, market };
}
