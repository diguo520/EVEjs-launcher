/**
 * Electron 侧 parity 捕获（S5 / L2 的第二半）。
 *
 * 为什么是「包装」而不是「改现役源码」：
 *   现役工程是只读的（E:\Games\EveJS-v0.12.8\launcher\launcher 只允许读），
 *   所以驱动方式改成：把它的 dist/ 复制到 .parity-out/electron-harness/（node_modules 用目录联接，
 *   不占额外磁盘），再用本文件作为**入口包装**——先劫持 ipcMain 把处理函数录下来，
 *   再 require 现役编译产物自身（dist/main/main/ipc.js）的 registerIpc()，
 *   最后用假 event 逐个调用只读通道，把**回包原文**写成与 Tauri 侧同结构的 JSON。
 *
 * 这样现役工程一个字节都不用改，而跑的是它真实的处理函数。
 * 副作用说明：只调用只读通道（与 scripts/smoke-ipc.ps1 同一份白名单），
 * 不启动服务、不改配置、不关窗口；不创建 BrowserWindow（只注册 handler）。
 */
"use strict";

const fs = require("fs");
const { app, ipcMain } = require("electron");

const CHANNEL_TIMEOUT_MS = 15000;
const handlers = new Map();
const senders = new Map();
const originalHandle = ipcMain.handle.bind(ipcMain);
const originalOn = ipcMain.on.bind(ipcMain);

/** 假的 IpcMainInvokeEvent：只提供只读通道真正会碰到的成员 */
const fakeEvent = {
  sender: {
    id: 0,
    send() {},
    once() {},
    on() {},
    off() {},
    removeListener() {},
    isDestroyed: () => false,
  },
  senderFrame: null,
  frameId: 0,
  processId: process.pid,
  returnValue: undefined,
  reply() {},
};

function install() {
  ipcMain.handle = (channel, fn) => {
    handlers.set(channel, fn);
    return originalHandle(channel, fn);
  };
  ipcMain.on = (channel, fn) => {
    senders.set(channel, fn);
    return originalOn(channel, fn);
  };
}

function readChannelPlan() {
  const file = process.env.EVEJS_PARITY_CHANNELS;
  if (!file || !fs.existsSync(file)) {
    throw new Error("缺少 EVEJS_PARITY_CHANNELS（通道清单 JSON 路径）");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function callWithTimeout(fn, args) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CHANNEL_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve().then(() => fn(fakeEvent, ...args)), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function run() {
  const plan = readChannelPlan();
  const out = process.env.EVEJS_SELF_TEST_OUT;
  const dump = {};
  const fails = [];

  for (const item of plan) {
    const handler = handlers.get(item.channel) || senders.get(item.channel);
    if (!handler) {
      dump[item.channel] = { __parity: "no-handler" };
      fails.push(`${item.channel}（现役侧未注册）`);
      continue;
    }
    try {
      const value = await callWithTimeout(handler, item.args || []);
      dump[item.channel] = value === undefined ? { __parity: "undefined" } : value;
    } catch (err) {
      dump[item.channel] = { __parity: "throw", message: String((err && err.message) || err) };
      fails.push(`${item.channel}（${(err && err.message) || err}）`);
    }
  }

  const summary = {
    ok: plan.length - fails.length,
    total: plan.length,
    fails,
    dump,
    meta: { side: "electron", channels: plan.length, electron: process.versions.electron },
  };
  if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`[parity] electron dump ${summary.ok}/${summary.total}${fails.length ? " fails=" + fails.join(",") : ""}`);
  app.exit(0);
}

function start() {
  const settle = Number(process.env.EVEJS_PARITY_SETTLE_MS || "2500");
  app
    .whenReady()
    .then(() => new Promise((resolve) => setTimeout(resolve, settle)))
    .then(run)
    .catch((err) => {
      console.error("[parity] electron capture 失败：", err);
      app.exit(3);
    });
}

module.exports = { install, start };