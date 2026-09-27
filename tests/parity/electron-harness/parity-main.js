/**
 * Electron harness 入口（S5 / L2）。
 * 顺序很重要：先劫持 ipcMain，再让现役工程注册它自己的 handler。
 * 只注册 IPC、不创建窗口，所以不会弹窗、不会拉起服务。
 */
"use strict";

const capture = require("./parity-capture.js");
capture.install();
require("./dist/main/main/ipc.js").registerIpc();
capture.start();