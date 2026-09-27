#!/usr/bin/env node
/**
 * 由 contract/ipc-channels.json 生成三份产物（单一来源原则）：
 *   src-tauri/src/ipc/channels.rs      通道表（Rust 侧白名单）
 *   ui/src/api-shim.generated.ts       window.api 实现（渲染侧）
 *   docs/ipc-contract.md               人读契约
 *
 * 用法：node scripts/gen-contract.mjs
 * 事件载荷约定：主进程 -> 渲染层统一发数组，shim 负责展开成多参数回调（与 Electron 语义一致）。
 */
import fs from "node:fs";
import path from "node:path";

const CONTRACT = path.resolve("contract", "ipc-channels.json");
if (!fs.existsSync(CONTRACT)) {
  console.error("缺少契约文件，请先运行 node scripts/extract-contract.mjs");
  process.exit(1);
}
const c = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));

const HEADER = "由 scripts/gen-contract.mjs 生成 —— 请勿手改。源: contract/ipc-channels.json";
const all = [...c.invoke, ...c.send].sort((a, b) => a.channel.localeCompare(b.channel));

/* ---------- 1) Rust 通道表 ---------- */
const rs = [];
rs.push("//! " + HEADER);
rs.push("//! 抽取源: " + c.generatedFrom);
rs.push("//! 生成时间: " + c.generatedAt);
rs.push("");
rs.push("#![allow(dead_code)]");
rs.push("");
rs.push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
rs.push("pub enum ChannelKind {");
rs.push("    Invoke,");
rs.push("    Send,");
rs.push("    Event,");
rs.push("}");
rs.push("");
rs.push("#[derive(Debug, Clone, Copy)]");
rs.push("pub struct ChannelSpec {");
rs.push("    pub channel: &'static str,");
rs.push("    pub api: &'static str,");
rs.push("    pub kind: ChannelKind,");
rs.push("}");
rs.push("");
rs.push("pub const REQUEST_COUNT: usize = " + (c.invoke.length + c.send.length) + ";");
rs.push("pub const EVENT_COUNT: usize = " + c.events.length + ";");
rs.push("");
// rustfmt 会把超过 max_width 的条目拆成多行，破坏 verify-contract 的单行解析；
// 生成产物统一加 rustfmt::skip，保证 `cargo fmt --check` 与生成器输出长期一致。
rs.push("#[rustfmt::skip]");
rs.push("pub const CHANNELS: &[ChannelSpec] = &[");
for (const item of all) {
  rs.push(
    '    ChannelSpec { channel: "' + item.channel + '", api: "' + item.api +
    '", kind: ChannelKind::' + (item.kind === "invoke" ? "Invoke" : "Send") + " },"
  );
}
for (const item of c.events) {
  rs.push(
    '    ChannelSpec { channel: "' + item.channel + '", api: "' + item.api + '", kind: ChannelKind::Event },'
  );
}
rs.push("];");
rs.push("");
rs.push("/// 按通道名查规范（线性扫描即可，通道数量级为百）");
rs.push("pub fn spec(channel: &str) -> Option<&'static ChannelSpec> {");
rs.push("    CHANNELS.iter().find(|item| item.channel == channel)");
rs.push("}");
rs.push("");
rs.push("pub fn is_known(channel: &str) -> bool {");
rs.push("    spec(channel).is_some()");
rs.push("}");
rs.push("");
rs.push("/// 需要回包或仅触发的请求通道（不含主进程 -> 渲染层的事件通道）");
rs.push("pub fn is_request(channel: &str) -> bool {");
rs.push("    matches!(spec(channel), Some(item) if item.kind != ChannelKind::Event)");
rs.push("}");
rs.push("");
rs.push("#[cfg(test)]");
rs.push("mod tests {");
rs.push("    use super::*;");
rs.push("");
rs.push("    #[test]");
rs.push("    fn request_channel_count_matches_generated_total() {");
// 这几行按 rustfmt 展开后的写法输出，保证「生成 → cargo fmt --check」恒等（见 F1）
rs.push("        let requests = CHANNELS");
rs.push("            .iter()");
rs.push("            .filter(|i| i.kind != ChannelKind::Event)");
rs.push("            .count();");
rs.push("        assert_eq!(requests, REQUEST_COUNT, \"请求通道数量与契约不一致\");");
rs.push("    }");
rs.push("");
rs.push("    #[test]");
rs.push("    fn event_channel_count_matches_generated_total() {");
rs.push("        let events = CHANNELS");
rs.push("            .iter()");
rs.push("            .filter(|i| i.kind == ChannelKind::Event)");
rs.push("            .count();");
rs.push("        assert_eq!(events, EVENT_COUNT, \"事件通道数量与契约不一致\");");
rs.push("    }");
rs.push("");
rs.push("    #[test]");
rs.push("    fn every_request_channel_is_looked_up() {");
rs.push("        for item in CHANNELS.iter().filter(|i| i.kind != ChannelKind::Event) {");
rs.push("            assert!(");
rs.push("                is_request(item.channel),");
rs.push("                \"{} 应被识别为请求通道\",");
rs.push("                item.channel");
rs.push("            );");
rs.push("        }");
rs.push("    }");
rs.push("");
rs.push("    #[test]");
rs.push("    fn unknown_channel_is_rejected() {");
rs.push("        assert!(!is_known(\"not:a-real-channel\"));");
rs.push("    }");
rs.push("}");
rs.push("");
fs.mkdirSync(path.resolve("src-tauri", "src", "ipc"), { recursive: true });
fs.writeFileSync(path.resolve("src-tauri", "src", "ipc", "channels.rs"), rs.join("\n"), "utf8");

/* ---------- 2) TS shim ---------- */
const ts = [];
ts.push("/* " + HEADER + " */");
ts.push("/* 抽取源: " + c.generatedFrom + " */");
ts.push("/* 生成时间: " + c.generatedAt + " */");
ts.push('import { invoke } from "@tauri-apps/api/core";');
ts.push('import { listen } from "@tauri-apps/api/event";');
ts.push("");
ts.push("/** Rust 侧单一分发命令（内部按通道名二次白名单校验） */");
ts.push('const DISPATCH_COMMAND = "launcher_invoke";');
ts.push("");
ts.push("export type UnlistenFn = () => void;");
ts.push("");
ts.push("function request(channel: string, args: unknown[]): Promise<unknown> {");
ts.push("  return invoke(DISPATCH_COMMAND, { channel, args });");
ts.push("}");
ts.push("");
ts.push("/** 无回包通道：与 Electron 的 ipcRenderer.send 语义一致 */");
ts.push("function fire(channel: string, args: unknown[]): void {");
ts.push("  void invoke(DISPATCH_COMMAND, { channel, args });");
ts.push("}");
ts.push("");
ts.push("/** 事件订阅：载荷统一为数组，按位置展开给回调（对齐 Electron 的多参数回调） */");
ts.push("function on(channel: string, cb: (...args: any[]) => void): UnlistenFn {");
ts.push("  let unlisten: UnlistenFn | null = null;");
ts.push("  let disposed = false;");
ts.push("  void listen<unknown>(channel, (event) => {");
ts.push("    const payload = event.payload;");
ts.push("    return cb(...(Array.isArray(payload) ? payload : [payload]));");
ts.push("  }).then((fn) => {");
ts.push("    if (disposed) fn();");
ts.push("    else unlisten = fn;");
ts.push("  });");
ts.push("  return () => {");
ts.push("    disposed = true;");
ts.push("    if (unlisten) unlisten();");
ts.push("  };");
ts.push("}");
ts.push("");
ts.push("export const api = {");
for (const item of c.invoke) {
  ts.push("  " + item.api + ": (" + item.signature + "): Promise<unknown> => request(\"" + item.channel + "\", [" +
    item.params.join(", ") + "]),");
}
for (const item of c.send) {
  ts.push("  " + item.api + ": (" + item.signature + "): void => fire(\"" + item.channel + "\", [" +
    item.params.join(", ") + "]),");
}
for (const item of c.events) {
  ts.push("  " + item.api + ": (cb: (...args: any[]) => void): UnlistenFn => on(\"" + item.channel + "\", cb),");
}
ts.push("};");
ts.push("");
ts.push("export type LauncherApi = typeof api;");
ts.push("");
ts.push("/** 注入 window.api：legacy 页面 (eve-launcher.html + launcher-bridge.js) 无需任何改动 */");
ts.push("export function installApiShim(target: Record<string, unknown> = window as unknown as Record<string, unknown>): LauncherApi {");
ts.push("  target.api = api;");
ts.push("  return api;");
ts.push("}");
ts.push("");
fs.mkdirSync(path.resolve("ui", "src"), { recursive: true });
fs.writeFileSync(path.resolve("ui", "src", "api-shim.generated.ts"), ts.join("\n"), "utf8");

/* ---------- 2b) 注入用纯 JS shim（零依赖，无需打包器） ----------
 * 为什么不用 esbuild：legacy 页面只需要 window.api 这一层薄封装，
 * 引入打包器就要维护 node_modules 与锁文件，而 Rust 侧是 include_str! 静态包含
 * （编译期必须存在），多一条「先装依赖再构建」的链路就多一个失败点。
 * 这里直接用 Tauri 始终注入的 window.__TAURI_INTERNALS__（与官方 @tauri-apps/api 同一传输层，
 * 与 withGlobalTauri 无关；关掉全局 __TAURI__ 可减少渲染层可调用的入口面），
 * 生成物是纯 JS，可直接被 node --check 校验。
 */
const js = [];
js.push("/* " + HEADER + " */");
js.push("/* 抽取源: " + c.generatedFrom + " */");
js.push("/* 注入方式: tauri.conf.json → withGlobalTauri:false + initialization_script */");
js.push("/* 传输层对齐 @tauri-apps/api：invoke + transformCallback 都挂在 __TAURI_INTERNALS__ 上 */");
js.push("(function () {");
js.push('  "use strict";');
js.push('  var DISPATCH = "launcher_invoke";');
js.push("  function bridge() {");
js.push("    var api = window.__TAURI_INTERNALS__;");
js.push('    if (!api || typeof api.invoke !== "function" || typeof api.transformCallback !== "function") {');
js.push('      throw new Error("window.__TAURI_INTERNALS__ 未注入：页面不在 Tauri WebView 中，或 Tauri 版本不兼容");');
js.push("    }");
js.push("    return api;");
js.push("  }");
js.push("  function request(channel, args) {");
js.push("    return bridge().invoke(DISPATCH, { channel: channel, args: args });");
js.push("  }");
js.push('  /** 无回包通道：与 Electron ipcRenderer.send 语义一致 */');
js.push("  function fire(channel, args) {");
js.push("    request(channel, args).catch(function () {});");
js.push("  }");
js.push('  /** 解除监听：先清 JS 侧回调表再通知事件插件（对齐 @tauri-apps/api/event 的 unlisten） */');
js.push("  function unlisten(channel, eventId) {");
js.push('    var events = window.__TAURI_EVENT_PLUGIN_INTERNALS__;');
js.push('    if (events && typeof events.unregisterListener === "function") events.unregisterListener(channel, eventId);');
js.push('    bridge().invoke("plugin:event|unlisten", { event: channel, eventId: eventId }).catch(function () {});');
js.push("  }");
js.push('  /** 事件订阅：载荷统一是数组，按位置展开成多参数回调（对齐 Electron） */');
js.push("  function on(channel, cb) {");
js.push("    var api = bridge();");
js.push("    var eventId = null;");
js.push("    var disposed = false;");
js.push('    api.invoke("plugin:event|listen", {');
js.push("      event: channel,");
js.push('      target: { kind: "Any" },');
js.push("      handler: api.transformCallback(function (event) {");
js.push("        var payload = event.payload;");
js.push("        return cb.apply(null, Array.isArray(payload) ? payload : [payload]);");
js.push("      })");
js.push("    }).then(function (id) {");
js.push("      if (disposed) unlisten(channel, id);");
js.push("      else eventId = id;");
js.push("    }).catch(function () {});");
js.push("    return function () {");
js.push("      disposed = true;");
js.push("      if (eventId !== null) { var id = eventId; eventId = null; unlisten(channel, id); }");
js.push("    };");
js.push("  }");
js.push("  var api = {");
for (const item of c.invoke) {
  js.push("    " + item.api + ": function (" + item.params.join(", ") + ") { return request(\"" +
    item.channel + "\", [" + item.params.join(", ") + "]); },");
}
for (const item of c.send) {
  js.push("    " + item.api + ": function (" + item.params.join(", ") + ") { fire(\"" +
    item.channel + "\", [" + item.params.join(", ") + "]); },");
}
for (const item of c.events) {
  js.push("    " + item.api + ": function (cb) { return on(\"" + item.channel + "\", cb); },");
}
js.push("  };");
js.push("  window.api = api;");
js.push("})();");
/* 产物落在 ui/src/（进仓）而不是 ui/dist/（构建产物、已 gitignore）：
 * lib.rs 用 include_str! 静态包含它，必须随源码一起存在于仓库中。
 * build-ui.mjs 再把它连同 ui/web 一起拷进 ui/dist。 */
fs.mkdirSync(path.resolve("ui", "src"), { recursive: true });
fs.writeFileSync(path.resolve("ui", "src", "api-shim.js"), js.join("\n"), "utf8");

/* ---------- 3) 契约文档 ---------- */
const md = [];
md.push("# IPC 契约（自动生成）");
md.push("");
md.push("> " + HEADER);
md.push("> 抽取源：`" + c.generatedFrom + "`");
md.push("> 生成时间：" + c.generatedAt);
md.push("");
md.push("## 计数");
md.push("");
md.push("| 项 | 数量 |");
md.push("| --- | --- |");
md.push("| invoke（有回包） | " + c.counts.invoke + " |");
md.push("| send（无回包） | " + c.counts.send + " |");
md.push("| 请求通道合计 | " + c.counts.requests + " |");
md.push("| 事件通道（主进程 → 渲染层） | " + c.counts.events + " |");
md.push("| window.api 入口合计 | " + c.counts.apiTotal + " |");
md.push("| ipc.ts 注册数 | " + c.counts.registered + " |");
md.push("");
md.push("## 交叉校验");
md.push("");
md.push("- 注册未暴露：" + (c.registeredNotExposed.join(", ") || "无"));
md.push("- 暴露未注册：" + (c.exposedNotRegistered.join(", ") || "无") + "（事件通道不经 ipcMain 注册，属预期）");
md.push("- 动态注册点：" + c.dynamicRegistrations);
md.push("");
md.push("## 请求通道（" + c.counts.requests + "）");
md.push("");
md.push("| window.api | 通道 | 类型 | 参数 |");
md.push("| --- | --- | --- | --- |");
for (const item of [...c.invoke, ...c.send].sort((a, b) => a.channel.localeCompare(b.channel))) {
  md.push("| `" + item.api + "` | `" + item.channel + "` | " + item.kind + " | `" + (item.signature || "-") + "` |");
}
md.push("");
md.push("## 事件通道（" + c.counts.events + "）");
md.push("");
md.push("| window.api | 通道 |");
md.push("| --- | --- |");
for (const item of c.events) {
  md.push("| `" + item.api + "` | `" + item.channel + "` |");
}
md.push("");
fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(path.resolve("docs", "ipc-contract.md"), md.join("\n"), "utf8");

console.log("已生成：");
console.log("  src-tauri/src/ipc/channels.rs      (" + rs.length + " 行)");
console.log("  ui/src/api-shim.generated.ts       (" + ts.length + " 行)");
console.log("  ui/src/api-shim.js                 (" + js.length + " 行)");
console.log("  docs/ipc-contract.md               (" + md.length + " 行)");
