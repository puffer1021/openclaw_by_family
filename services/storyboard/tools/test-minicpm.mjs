/**
 * test-minicpm.mjs — 测试 MiniCPM-o WebSocket 连接
 * node services/storyboard/test-minicpm.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WS = require("ws");

const URL = "wss://minicpmo45.modelbest.cn/v1/realtime?mode=audio";
const INSTRUCTION = "你叫小十二，是给6岁孩子使用的中文情绪小猫伙伴。请用温柔简短的话回答。";

console.log("连接:", URL);
const ws = new WS(URL);

const timeout = setTimeout(() => {
  console.error("超时 45s");
  ws.close();
  process.exit(1);
}, 45000);

ws.on("open", () => console.log("✅ WebSocket 已连接"));

ws.on("message", (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }

  const type = msg.type || msg.event;
  console.log("收到:", type, JSON.stringify(msg).slice(0, 200));

  // 等队列完成后发 session.update
  if (type === "session.queue_done" || type === "queue_done") {
    console.log("→ 发送 session.update");
    ws.send(JSON.stringify({
      type: "session.update",
      session: { instructions: INSTRUCTION },
    }));
  }

  // session 创建后发静音帧触发回复
  if (type === "session.created") {
    console.log("✅ session.created, id:", msg.session_id);
    console.log("→ 发送 1s 静音帧");
    const samples = new Float32Array(16000); // 全零 = 静音
    const audio = Buffer.from(samples.buffer).toString("base64");
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio, force_listen: true }));
  }

  if (type === "response.output_audio.delta") {
    console.log("✅ 收到模型回复:", msg.text || "(纯音频)");
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }

  if (type === "response.listen") {
    console.log("✅ 模型进入监听状态 (连接正常)");
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }

  if (type === "error") {
    console.error("❌ 服务端 error:", JSON.stringify(msg));
    clearTimeout(timeout);
    ws.close();
    process.exit(1);
  }

  if (type === "session.closed") {
    console.log("会话关闭:", msg.reason);
    clearTimeout(timeout);
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error("❌ WebSocket 错误:", err.message);
  clearTimeout(timeout);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  console.log("连接关闭:", code, reason.toString());
});
