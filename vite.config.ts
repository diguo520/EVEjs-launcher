import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// 渲染层构建：src/renderer -> dist/renderer（base './' 以便 file:// 加载）
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1"
  }
});
