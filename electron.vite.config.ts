import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// 入口与 renderer 根目录都用 electron-vite 的默认值
// （src/main/index.ts · src/preload/index.ts · src/renderer）。
// node-pty 是原生模块，必须 external —— 打进 bundle 会找不到 .node 二进制。
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {},
});
