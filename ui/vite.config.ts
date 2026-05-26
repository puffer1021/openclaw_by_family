import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      // 自签名 https，让局域网设备也能用 mic / 摄像头
      https: {},
      proxy: {
        // 家庭虾 storyboard backend (services/storyboard)
        "/api/storyboard": {
          target: `http://127.0.0.1:${process.env.STORYBOARD_PORT || 3939}`,
          changeOrigin: false,
          ws: false,
          // long timeout: image-gen ~30s each, video-gen ~3-5 min
          timeout: 420_000,
          proxyTimeout: 420_000,
        },
        // 数学岛拍照解题（同一 storyboard 进程托管）
        "/api/math": {
          target: `http://127.0.0.1:${process.env.STORYBOARD_PORT || 3939}`,
          changeOrigin: false,
          ws: false,
          timeout: 420_000,
          proxyTimeout: 420_000,
        },
        // 父母端口 chat（也在 storyboard 进程内）
        "/api/parent": {
          target: `http://127.0.0.1:${process.env.STORYBOARD_PORT || 3939}`,
          changeOrigin: false,
          ws: false,
          timeout: 420_000,
          proxyTimeout: 420_000,
        },
        "/api/kids": {
          target: `http://127.0.0.1:${process.env.STORYBOARD_PORT || 3939}`,
          changeOrigin: false,
          ws: false,
          timeout: 10_000,
          proxyTimeout: 10_000,
        },
        // 创造房间生图/生视频
        "/api/creation": {
          target: `http://127.0.0.1:${process.env.STORYBOARD_PORT || 3939}`,
          changeOrigin: false,
          ws: false,
          timeout: 420_000,
          proxyTimeout: 420_000,
        },
        // 情绪房间：保存聊天记录到 NAS
        "/api/emotion/save-session": {
          target: `http://127.0.0.1:${process.env.STORYBOARD_PORT || 3939}`,
          changeOrigin: false,
          ws: false,
          timeout: 10_000,
          proxyTimeout: 10_000,
        },
        // 情绪房间豆包 Realtime WS 代理
        "/api/emotion/realtime": {
          target: `ws://127.0.0.1:${process.env.STORYBOARD_PORT || 3939}`,
          changeOrigin: false,
          ws: true,
        },
      },
    },
    plugins: [
      basicSsl(),
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
              }),
            );
          });
        },
      },
    ],
  };
});
