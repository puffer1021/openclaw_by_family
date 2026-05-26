/**
 * 家庭虾 · 创造房间 后端服务
 *
 * 单文件 Node ES module,零外部依赖。
 *
 * Endpoints:
 *   GET  /healthz
 *   POST /api/storyboard/describe    { image: dataURL } -> { description }
 *   POST /api/storyboard/coach       { messages, image_description?, regenerate? }
 *                                      -> { reply, frames? }
 *   POST /api/storyboard/render      { prompt, size? }
 *                                      -> { url }
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, promises as fsp } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// =============================================
// Codex CLI backend (ChatGPT 浏览器登录复用)
// =============================================
// 复用 ChatGPT Plus 订阅，零 API 费用。无需配 AGENT_API_KEY。
// 鉴权来自 ~/.codex/auth.json （由 `codex login` 生成）。
const CODEX_CLI = path.join(REPO_ROOT, "node_modules", "@openai", "codex", "bin", "codex.js");
const CODEX_AUTH = path.join(homedir(), ".codex", "auth.json");
const CODEX_AVAILABLE = existsSync(CODEX_CLI) && existsSync(CODEX_AUTH);
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.5";

// math 解题专用后端：codex（默认 if 可用）| http（OpenAI 兼容 API）
const MATH_BACKEND = process.env.MATH_BACKEND || (CODEX_AVAILABLE ? "codex" : "http");

// Manim Python venv 路径（项目本地 .venv，与设备无关）
const MANIM_BIN = path.join(REPO_ROOT, ".venv", "bin", "manim");
const MANIM_AVAILABLE = existsSync(MANIM_BIN);

// 数学题渲染产物缓存（持久化：刷新页面不丢失）
// 保留最近 N 个 job 目录，超过则按时间删旧的
const MATH_CACHE_DIR = path.join(__dirname, "math-cache");
const MATH_CACHE_KEEP = Number(process.env.MATH_CACHE_KEEP || 30);
mkdirSync(MATH_CACHE_DIR, { recursive: true });

// Local video cache directory — downloaded MP4s live here indefinitely
const VIDEO_CACHE_DIR = path.join(__dirname, "video-cache");
mkdirSync(VIDEO_CACHE_DIR, { recursive: true });

// 情绪聊天记录 → NAS 存档
const NAS_CHAT_DIR = "/Volumes/disk4/AMD项目/聊天记录";

async function routeSaveEmotionSession(req, res) {
  const body = await readJsonBody(req);
  const { messages = [], startTs, durationSec } = body;
  if (!messages.length) { send(res, 200, { ok: true, skipped: true }); return; }

  try {
    mkdirSync(NAS_CHAT_DIR, { recursive: true });

    const d = new Date(startTs || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const filename = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_聊天记录.md`;
    const filepath = path.join(NAS_CHAT_DIR, filename);

    const durText = durationSec ? `${Math.round(durationSec / 60 * 10) / 10} 分钟` : "—";
    const lines = [
      `# 情绪聊天记录`,
      ``,
      `**时间**：${d.toLocaleString("zh-CN", { hour12: false })}  `,
      `**时长**：${durText}`,
      ``,
      `---`,
      ``,
    ];
    for (const msg of messages) {
      const t = new Date(msg.ts || startTs);
      const time = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
      const name = msg.role === "user" ? "小朋友" : "蛋蛋";
      lines.push(`**${name}** ${time}`);
      lines.push(`> ${(msg.text || "").replace(/\n/g, "\n> ")}`);
      lines.push(``);
    }

    writeFileSync(filepath, lines.join("\n"), "utf-8");
    console.log(`[emotion] 聊天记录已保存 → ${filepath}`);
    send(res, 200, { ok: true, file: filename });
  } catch (err) {
    console.warn("[emotion] 保存聊天记录失败:", err.message);
    send(res, 500, { ok: false, error: err.message });
  }
}

// 孩子端事件持久化（localStorage → 服务端文件，供微信 bot 查询）
const EVENTS_STORE = path.join(__dirname, "kids-events.json");
function loadStoredEvents() {
  try { return JSON.parse(readFileSync(EVENTS_STORE, "utf-8")); } catch { return []; }
}
function appendStoredEvent(evt) {
  let arr = loadStoredEvents();
  arr.push(evt);
  if (arr.length > 500) arr = arr.slice(-500);
  writeFileSync(EVENTS_STORE, JSON.stringify(arr));
}

async function routeSyncEvents(req, res) {
  const body = await readJsonBody(req);
  if (body.event) appendStoredEvent(body.event);
  scheduleOpenclawMemorySync();
  send(res, 200, { ok: true });
}

async function routeSyncEventsBulk(req, res) {
  const body = await readJsonBody(req);
  const incoming = Array.isArray(body.events) ? body.events : [];
  if (!incoming.length) return send(res, 200, { ok: true });
  // 合并：以 ts+type 为 key 去重，保留最新的完整快照
  const existing = loadStoredEvents();
  const seen = new Set(existing.map((e) => `${e.ts}:${e.type}`));
  const merged = [...existing];
  for (const e of incoming) {
    const k = `${e.ts}:${e.type}`;
    if (!seen.has(k)) { seen.add(k); merged.push(e); }
  }
  merged.sort((a, b) => a.ts - b.ts);
  const trimmed = merged.slice(-500);
  writeFileSync(EVENTS_STORE, JSON.stringify(trimmed));
  scheduleOpenclawMemorySync();
  send(res, 200, { ok: true, total: trimmed.length });
}

// =============================================
// Agent 抽象：OpenAI 兼容的任意端点
// =============================================
// 优先级：AGENT_* 显式配置 > 默认复用已有的 ARK 配置（doubao-vision）
// 想换 GPT-5/Codex/Claude 等，把这 3 行加 .env 即可：
//   AGENT_API_KEY=sk-...
//   AGENT_BASE_URL=https://api.openai.com/v1
//   AGENT_MODEL=gpt-5-codex
const AGENT_API_KEY  = process.env.AGENT_API_KEY  || process.env.ARK_API_KEY || "";
const AGENT_BASE_URL = process.env.AGENT_BASE_URL || process.env.ARK_BASE_URL || "https://api.openai.com/v1";
const AGENT_MODEL    = process.env.AGENT_MODEL    || process.env.ARK_VISION_MODEL || "doubao-1-5-vision-pro-32k-250115";

const PORT = Number(process.env.STORYBOARD_PORT || 3939);
const ARK_API_KEY = process.env.ARK_API_KEY || "";
const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL || "doubao-seedream-5-0-260128";
const ARK_VIDEO_MODEL = process.env.ARK_VIDEO_MODEL || "doubao-seedance-1-5-pro-251215";
const ARK_VISION_MODEL = process.env.ARK_VISION_MODEL || "doubao-1-5-vision-pro-32k-250115";
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic";
const MINIMAX_MODEL = "MiniMax-M2.7";

// ----- skill prompt -----
let cachedSkill = "";
function loadSkillPrompt() {
  if (cachedSkill) return cachedSkill;
  try {
    const p = path.join(REPO_ROOT, "skills/kids-storyboard-coach/SKILL.md");
    cachedSkill = readFileSync(p, "utf8");
  } catch (err) {
    console.error("[storyboard] failed to load skill markdown:", err.message);
    cachedSkill = "你是一只友好的故事教练小龙,陪小朋友讲故事。";
  }
  return cachedSkill;
}

// ----- helpers -----
function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    ...headers,
  });
  res.end(body);
}

function readJsonBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ----- MiniMax (Anthropic-compatible) -----
async function callMiniMax({ messages, system, max_tokens = 2048 }) {
  if (!MINIMAX_API_KEY) throw new Error("MINIMAX_API_KEY missing");
  const r = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MINIMAX_API_KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      max_tokens,
      system,
      messages,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`MiniMax ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  // anthropic-style: content is array of { type, text }
  const text = (j.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text;
}

// ----- Doubao Chat (OpenAI-compatible, used for vision describe) -----
async function callDoubaoChat({ model, messages, max_tokens = 800 }) {
  if (!ARK_API_KEY) throw new Error("ARK_API_KEY missing");
  const r = await fetch(`${ARK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ARK_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, max_tokens }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Doubao ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  return j?.choices?.[0]?.message?.content?.trim() || "";
}

// ----- Doubao Seedream (text -> image) -----
async function callSeedream({ prompt, size = "2K" }) {
  if (!ARK_API_KEY) throw new Error("ARK_API_KEY missing");
  const r = await fetch(`${ARK_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ARK_API_KEY}`,
    },
    body: JSON.stringify({
      model: ARK_IMAGE_MODEL,
      prompt,
      sequential_image_generation: "disabled",
      response_format: "b64_json",
      size,
      stream: false,
      watermark: false,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Seedream ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`Seedream returned no b64_json: ${JSON.stringify(j).slice(0, 300)}`);
  return `data:image/png;base64,${b64}`;
}

// ----- Doubao Seedance (image → video, async polling) -----
// Correct endpoint: POST /v3/contents/generations/tasks
// Prompt flags:  --duration N  --camerafixed false  --watermark false
// frameImages: array of { url, role } where role is "first_frame"|"middle_frame"|"last_frame"
async function callSeedance({ prompt, frameImages = [], duration = 10 }) {
  if (!ARK_API_KEY) throw new Error("ARK_API_KEY missing");

  const fullPrompt = `${prompt} --duration ${duration} --camerafixed false --watermark false`;

  const content = [{ type: "text", text: fullPrompt }];
  for (const { url, role } of frameImages) {
    if (url) content.push({ type: "image_url", image_url: { url }, role });
  }

  // Submit task
  const submitRes = await fetch(`${ARK_BASE_URL}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ARK_API_KEY}`,
    },
    body: JSON.stringify({ model: ARK_VIDEO_MODEL, content }),
  });

  if (!submitRes.ok) {
    const t = await submitRes.text();
    throw new Error(`Seedance submit ${submitRes.status}: ${t.slice(0, 400)}`);
  }

  const submitJson = await submitRes.json();
  const taskId = submitJson?.id;
  if (!taskId) throw new Error(`Seedance: no task id: ${JSON.stringify(submitJson).slice(0, 200)}`);
  console.log("[seedance] task submitted:", taskId);

  // Poll every 6 s, max 60 tries (~6 min)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 6000));

    const pollRes = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${ARK_API_KEY}` },
    });
    if (!pollRes.ok) { console.warn("[seedance] poll", pollRes.status); continue; }

    const pj = await pollRes.json();
    const status = String(pj?.status ?? "").toLowerCase();
    console.log(`[seedance] poll #${i + 1} status=${status}`);

    if (status === "succeeded") {
      // video URL sits in content[].video_url or url
      const videoUrl =
        pj?.content?.video_url ??
        pj?.content?.[0]?.video_url ??
        pj?.video_url ??
        "";
      if (!videoUrl) throw new Error(`Seedance succeeded but no video_url: ${JSON.stringify(pj).slice(0, 300)}`);
      return videoUrl;
    }
    if (status === "failed") {
      throw new Error(`Seedance task failed: ${JSON.stringify(pj).slice(0, 300)}`);
    }
  }
  throw new Error("Seedance timed out after ~6 minutes");
}

// ===========================================================
// 数学岛 · 拍照解题 agent
// ===========================================================
// 调用 OpenAI 兼容 API（Chat Completions），开 stream=true 拿增量
// 服务端把模型增量解析成结构化 SSE event 推给前端：
//   step: 解题中间步骤
//   answer: 最终答案
//   viz: 可视化（动画提示等）
//   done: 全部结束
//   error-msg: 出错
// ===========================================================
const mathJobs = new Map(); // jobId → { abort, clients, buffer, eventQueue, done }

const MATH_PROMPT = [
  "你是一位给 6 岁孩子讲题的数学老师，要把题目和解法做成一段简短的 Manim 动画。",
  "看完图里的题目后，直接输出一段 Manim Python 代码（不要任何前置说明文字）。",
  "",
  "动画里要完整呈现：题目复述 → 一步步推导 → 最终答案。所有讲解通过画面里的 Text() 和动画展现，",
  "不要在代码外另写文字步骤——观众只看视频。",
  "",
  "用三个反引号围栏包裹代码：",
  "```python",
  "from manim import *",
  "class Solve(Scene):",
  "    def construct(self):",
  "        # 题目 → 推导 → 答案，分成 3-5 个独立场景",
  "        # 每个场景：FadeIn → wait(1.5-2) → FadeOut，再进入下一场景",
  "        # 总时长 8-14 秒",
  "        pass",
  "```",
  "",
  "═══ 核心硬约束（违反就报废）═══",
  "",
  "【场景切换规则 — 最重要】",
  "- 把动画分成 3-5 个**独立场景**，绝对不要把所有元素同时堆在一帧上",
  "- 每个新场景之前必须 self.play(FadeOut(*self.mobjects)) 清空画面",
  "- 标准结构：",
  "    scene1 = VGroup(...).arrange(DOWN, buff=0.4)",
  "    self.play(Write(scene1)); self.wait(1.8)",
  "    self.play(FadeOut(scene1))",
  "    # ... 下一个场景",
  "",
  "【布局区域】",
  "- Manim 画布是 14×8（横×纵）单位，中心在 (0,0)",
  "- 文字 / 图形必须放在 x ∈ [-5.5, 5.5]、y ∈ [-3, 3] 之内",
  "- 同一帧元素之间最少留 0.5 单位 buff，避免重叠挤压",
  "- 用 VGroup(*items).arrange(DOWN/RIGHT, buff=0.5).move_to(ORIGIN) 整齐排版",
  "- 不要手动 .shift() 多个绝对位置然后期望它们不撞——容易翻车",
  "",
  "【字号】",
  "- Text() 默认 font_size=48 太大，请用 28-36",
  "- 标题用 36，正文用 28，注释用 22",
  "",
  "【代码硬约束】",
  "- 类名必须叫 Solve",
  "- 只能用 manim 内置对象：Text, Circle, Square, Rectangle, Line, Arrow, Dot, VGroup, NumberPlane",
  "- 禁用 MathTex / Tex / LaTeX 公式（没装 TeX 环境）",
  "- 所有中文文字必须放进 Text(...)，字体使用默认即可",
  "- 不要 import 第三方库；不要执行任何 shell 命令",
  "- 输出代码即可，禁止调用任何工具",
].join("\n");

async function routeMathSolve(req, res) {
  let body;
  try { body = await readJsonBody(req, 30 * 1024 * 1024); }
  catch (err) { return send(res, 400, { error: "bad body: " + err.message }); }

  const dataUrl = body.image;
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return send(res, 400, { error: "image (data URL) required" });
  }

  if (MATH_BACKEND === "http" && !AGENT_API_KEY) {
    return send(res, 503, {
      error: "MATH_BACKEND=http 但 AGENT_API_KEY 未配置；或安装 codex CLI 并 `codex login` 改用 codex 后端",
    });
  }
  if (MATH_BACKEND === "codex" && !CODEX_AVAILABLE) {
    return send(res, 503, {
      error: `codex CLI 不可用。检查 ${CODEX_CLI} 是否存在，且 ${CODEX_AUTH} 是否已通过 \`codex login\` 生成`,
    });
  }

  const jobId = randomUUID();
  const abort = new AbortController();
  const job = {
    abort,
    clients: new Set(),
    eventQueue: [],
    buffer: "",
    done: false,
    manimCode: "",         // 累积模型输出的 manim 代码
    inCodeBlock: false,    // 当前是否在 ```python 围栏里
    answerSeen: false,
    problemImg: dataUrl,   // 缓存题目原图，用于 solution.html
    title: "",             // "题目:" 内容
    steps: [],             // 所有步骤文本
    answer: "",            // 最终答案
  };
  mathJobs.set(jobId, job);

  // 异步触发 agent，不阻塞返回
  const driver = MATH_BACKEND === "codex"
    ? callCodexExec(job, jobId, dataUrl)
    : callAgentStreaming(job, dataUrl);
  driver.catch((err) => {
    pushEvent(job, "error-msg", { message: err.message || String(err) });
    finishJob(job, jobId);
  });

  send(res, 200, { jobId });
}

// ===== codex CLI 后端 =====
// spawn `node node_modules/@openai/codex/bin/codex.js exec -i <img> --json ...`
// 解析 JSONL 流，把 agent_message 文本按行分发为 step/answer/viz 事件
async function callCodexExec(job, jobId, imageDataUrl) {
  const jobDir = path.join(MATH_CACHE_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  // 把 dataURL 解码写到本地，codex CLI 用 -i 读
  const imgPath = path.join(jobDir, "problem.png");
  const m = imageDataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
  if (!m) throw new Error("image must be base64 data URL");
  writeFileSync(imgPath, Buffer.from(m[1], "base64"));

  const args = [
    CODEX_CLI,
    "exec",
    "-i", imgPath,
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C", jobDir,
    "-m", CODEX_MODEL,
    MATH_PROMPT,
  ];

  const child = spawn(process.execPath, args, {
    cwd: jobDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  job.abort.signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch {} });

  // 120s 硬超时，避免 codex 卡死无限等
  const codexTimeoutMs = Number(process.env.CODEX_TIMEOUT_MS || 120_000);
  const codexTimer = setTimeout(() => {
    console.warn(`[math] codex timeout (${codexTimeoutMs}ms) for ${jobId}, killing`);
    try { child.kill("SIGKILL"); } catch {}
  }, codexTimeoutMs);

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line || !line.startsWith("{")) continue;
      try {
        const evt = JSON.parse(line);
        handleCodexEvent(job, evt);
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(codexTimer);
  if (exitCode !== 0 && !job.done) {
    throw new Error(`codex 退出码 ${exitCode}（可能是超时被 kill）: ${stderrBuf.slice(-300)}`);
  }

  // 模型若给了 manim 代码，渲染一段视频
  let videoUrl = null;
  let vizError = null;
  if (job.manimCode.trim() && MANIM_AVAILABLE) {
    console.log(`[math] rendering manim for ${jobId} (${job.manimCode.length} chars)…`);
    try {
      videoUrl = await renderManim(jobId, job.manimCode, jobDir);
      console.log(`[math] manim done for ${jobId}: ${videoUrl}`);
    } catch (err) {
      vizError = err.message || String(err);
      console.warn(`[math] manim failed for ${jobId}: ${vizError}`);
    }
  } else if (job.manimCode.trim() && !MANIM_AVAILABLE) {
    vizError = "服务器未装 manim（.venv/bin/manim 不存在）";
  }

  // 生成集成解题 HTML（题目原图 + 步骤 + 答案 + 视频一体化）
  try {
    const html = buildSolutionHtml(job, videoUrl, vizError);
    writeFileSync(path.join(jobDir, "solution.html"), html);
    console.log(`[math] solution.html written for ${jobId} (${job.steps.length} steps, video=${!!videoUrl})`);
    pushEvent(job, "solution", { url: `/api/math/solution/${jobId}.html` });
  } catch (err) {
    console.error(`[math] failed to build solution.html for ${jobId}:`, err);
    pushEvent(job, "viz", { kind: "text", text: "❌ 解题页生成失败：" + (err.message || String(err)) });
    if (vizError) pushEvent(job, "viz", { kind: "text", text: "🎬 " + vizError });
  }

  finishJob(job, jobId);
}

// 极简：右栏只放一个全幅自动播放视频，全程透明背景让黑板色透出来
function buildSolutionHtml(job, videoUrl, vizError) {
  const body = videoUrl
    ? `<video src="${videoUrl}" autoplay loop muted playsinline></video>`
    : `<div class="err">🎬 ${escapeHtmlServer(vizError || "动画生成失败")}</div>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>解题动画</title>
<style>
  html,body { margin:0; padding:0; height:100%; background:transparent; }
  body { display:flex; align-items:center; justify-content:center; overflow:hidden; background:transparent; }
  video { width:100%; height:100%; object-fit:contain; background:transparent; }
  .err {
    color: rgba(255, 200, 120, 0.9);
    font: 14px -apple-system, "PingFang SC", sans-serif;
    padding: 16px;
    border: 2px dashed rgba(255, 200, 120, 0.5);
    border-radius: 8px;
    background: rgba(0,0,0,0.2);
  }
</style></head><body>${body}</body></html>`;
}

function escapeHtmlServer(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function routeMathSolution(req, res, jobId) {
  const html = path.join(MATH_CACHE_DIR, jobId, "solution.html");
  if (!existsSync(html)) return send(res, 404, { error: "solution not found" });
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });
  createReadStream(html).pipe(res);
}

// 解析 codex JSONL 事件
function handleCodexEvent(job, evt) {
  if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
    const text = evt.item.text || "";
    parseAgentText(job, text);
  }
  // turn.started / thread.started / turn.completed 不需要处理
}

// 把模型一次性返回的整段文本按行分发，并提取 ```python 代码块
function parseAgentText(job, text) {
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw; // 保留缩进，代码块要原样收集
    const trimmed = line.trim();

    // 代码围栏处理
    if (/^```python\s*$/.test(trimmed)) { job.inCodeBlock = true; continue; }
    if (job.inCodeBlock) {
      if (/^```\s*$/.test(trimmed)) { job.inCodeBlock = false; continue; }
      job.manimCode += line + "\n";
      continue;
    }

    if (!trimmed) continue;
    if (trimmed.startsWith("题目:") || trimmed.startsWith("题目：")) {
      job.title = trimmed.replace(/^题目[:：]\s*/, "");
      pushEvent(job, "step", { text: trimmed });
    } else if (/^第[一二三四五六七八九十0-9]+步[:：]/.test(trimmed)) {
      job.steps.push(trimmed);
      pushEvent(job, "step", { text: trimmed });
    } else if (trimmed.startsWith("答案:") || trimmed.startsWith("答案：")) {
      job.answerSeen = true;
      job.answer = trimmed.replace(/^答案[:：]\s*/, "");
      pushEvent(job, "answer", { value: job.answer });
    } else {
      job.steps.push(trimmed);
      pushEvent(job, "step", { text: trimmed });
    }
  }
}

// ===== Manim 渲染 =====
// 黑板色背景（#283717）：视觉上跟教室黑板融合，所有浏览器都能播
// 黑板真实色范围 R:34-47 / G:47-58 / B:17-29；纯色块比纹理黑板视觉上偏亮，
// 故选偏暗端目标 (33, 47, 17)，叠加 mp4 yuv420p 压缩的 (-1,-2,-3) 偏移，
// 设置为 #213014 (33, 48, 20) 编码后落在视觉融合点
const CHALKBOARD_COLOR = "#213014";
async function renderManim(jobId, code, jobDir) {
  // 在用户代码前注入 manim 配置，强制使用黑板色当背景
  const preamble = [
    "from manim import config",
    `config.background_color = "${CHALKBOARD_COLOR}"`,
    "",
  ].join("\n");
  const scenePath = path.join(jobDir, "scene.py");
  writeFileSync(scenePath, preamble + code);

  const mediaDir = path.join(jobDir, "media");
  await new Promise((resolve, reject) => {
    const child = spawn(MANIM_BIN, [
      "-ql",                          // 480p15 低画质，5-10 秒
      "--disable_caching",
      "--media_dir", mediaDir,
      scenePath,
      "Solve",
    ], { cwd: jobDir });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`manim exit ${code}: ${err.slice(-400)}`));
    });
  });

  const mp4 = path.join(mediaDir, "videos", "scene", "480p15", "Solve.mp4");
  if (!existsSync(mp4)) throw new Error("manim 渲染完成但找不到 mp4 输出");
  return `/api/math/video/${jobId}`;
}

function routeMathVideo(req, res, jobId) {
  const mp4 = path.join(MATH_CACHE_DIR, jobId, "media", "videos", "scene", "480p15", "Solve.mp4");
  if (!existsSync(mp4)) return send(res, 404, { error: "video not found" });
  res.writeHead(200, {
    "content-type": "video/mp4",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });
  createReadStream(mp4).pipe(res);
}

// 调 OpenAI 兼容 Chat Completions API，stream=true
async function callAgentStreaming(job, imageDataUrl) {
  const url = `${AGENT_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: AGENT_MODEL,
    stream: true,
    max_tokens: 2000,
    messages: [
      { role: "system", content: MATH_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "请解这道数学题：" },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${AGENT_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: job.abort.signal,
  });

  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`Agent ${res.status}: ${errTxt.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += decoder.decode(value, { stream: true });
    // OpenAI SSE: 行分隔，data: {...}
    const lines = sseBuf.split("\n");
    sseBuf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) appendAgentText(job, delta);
      } catch {}
    }
  }
  // 最后残留的 buffer 也作为 step 推出
  flushAgentBuffer(job, true);
  finishJobByJob(job);
}

// 把模型增量按行切分，成形的行立刻推 SSE
function appendAgentText(job, delta) {
  job.buffer += delta;
  flushAgentBuffer(job, false);
}

function flushAgentBuffer(job, flushAll) {
  const parts = job.buffer.split("\n");
  job.buffer = flushAll ? "" : parts.pop();
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("题目:") || line.startsWith("题目：")) {
      pushEvent(job, "step", { text: line });
    } else if (/^第[一二三四五六七八九十0-9]+步[:：]/.test(line)) {
      pushEvent(job, "step", { text: line });
    } else if (line.startsWith("答案:") || line.startsWith("答案：")) {
      pushEvent(job, "answer", { value: line.replace(/^答案[:：]\s*/, "") });
    } else if (line.startsWith("动画提示:") || line.startsWith("动画提示：")) {
      pushEvent(job, "viz", {
        kind: "text",
        text: "🎬 " + line.replace(/^动画提示[:：]\s*/, "") + "（Manim 渲染待接入）",
      });
    } else {
      pushEvent(job, "step", { text: line });
    }
  }
}

function finishJobByJob(job) {
  for (const [id, j] of mathJobs.entries()) {
    if (j === job) { finishJob(job, id); return; }
  }
}

// 把 buffer 按行解析成 step / answer / viz 事件
function flushLinesAsSteps(job, flushAll = false) {
  const parts = job.buffer.split("\n");
  job.buffer = flushAll ? "" : parts.pop();   // 最后一行可能还没结束
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("题目:") || line.startsWith("题目：")) {
      pushEvent(job, "step", { text: line });
    } else if (/^第[一二三四五六七八九十0-9]+步[:：]/.test(line)) {
      pushEvent(job, "step", { text: line });
    } else if (line.startsWith("答案:") || line.startsWith("答案：")) {
      const v = line.replace(/^答案[:：]\s*/, "");
      pushEvent(job, "answer", { value: v });
    } else if (line.startsWith("动画提示:") || line.startsWith("动画提示：")) {
      const v = line.replace(/^动画提示[:：]\s*/, "");
      pushEvent(job, "viz", { kind: "text", text: "🎬 " + v + "（Manim skill 暂未接入）" });
    } else {
      // 其他行作为普通 step
      pushEvent(job, "step", { text: line });
    }
  }
}

function pushEvent(job, type, data) {
  const evt = { type, data };
  if (job.clients.size === 0) {
    job.eventQueue.push(evt);
  } else {
    for (const client of job.clients) writeSseEvent(client, type, data);
  }
}

function writeSseEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

function finishJob(job, jobId) {
  if (job.done) return;
  job.done = true;
  pushEvent(job, "done", {});
  for (const client of job.clients) {
    try { client.end(); } catch {}
  }
  job.clients.clear();
  // 5 分钟后从内存 map 移除（释放 SSE clients），但磁盘缓存保留供刷新加载
  if (jobId) setTimeout(() => mathJobs.delete(jobId), 5 * 60 * 1000);
  // 异步执行旧 job 目录裁剪
  pruneMathCache().catch(() => {});
}

// 保留 MATH_CACHE_KEEP 个最新 job 目录，删除更旧的
async function pruneMathCache() {
  const { readdirSync, statSync } = await import("node:fs");
  let entries;
  try {
    entries = readdirSync(MATH_CACHE_DIR);
  } catch { return; }
  const dirs = entries
    .map((name) => {
      const p = path.join(MATH_CACHE_DIR, name);
      try { return { name, p, mtime: statSync(p).mtimeMs }; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const toDelete = dirs.slice(MATH_CACHE_KEEP);
  for (const d of toDelete) {
    try { rmSync(d.p, { recursive: true, force: true }); } catch {}
  }
}

function routeMathStream(req, res, jobId) {
  const job = mathJobs.get(jobId);
  if (!job) {
    return send(res, 404, { error: "job not found" });
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  });
  res.write(":\n\n");
  job.clients.add(res);

  for (const evt of job.eventQueue) writeSseEvent(res, evt.type, evt.data);
  job.eventQueue = [];

  if (job.done) {
    writeSseEvent(res, "done", {});
    try { res.end(); } catch {}
    job.clients.delete(res);
  }

  req.on("close", () => job.clients.delete(res));
}

function routeMathCancel(req, res, jobId) {
  const job = mathJobs.get(jobId);
  if (job) {
    try { job.abort?.abort(); } catch {}
    finishJob(job, jobId);
  }
  send(res, 200, { ok: true });
}

// ----- routes -----

// ===== 父母端口 AI 聊天 =====
// 前端把孩子的活动日志（kids.events）和当前问题一起发来，
// 服务端组装 system prompt（系统提示）让 AI 充当育儿助手。
async function routeParentChat(req, res) {
  const body = await readJsonBody(req);
  // events 优先用请求体传入的（浏览器端），没有则读服务端持久化文件（微信 bot 路径）
  const events  = Array.isArray(body.events) && body.events.length > 0
    ? body.events
    : loadStoredEvents();
  const messages= Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return send(res, 400, { error: "messages required" });

  const summary = summarizeEvents(events);

  const system =
    "你是「小喵」家庭育儿助手，帮 6 岁孩子（孩子名叫「小十二」）的家长理解孩子最近的状态。\n" +
    "你能看到孩子在「小十二的家」app 里最近的活动记录（情绪聊天、数学题、画作），\n" +
    "请基于这些事实给家长温和、具体、可执行的建议，避免空泛和说教。\n" +
    "如果家长问的问题和孩子的活动无关，正常作答即可。\n" +
    "称呼孩子时直接叫「小十二」或「孩子」，不要称呼自己为「小十二」。\n\n" +
    "## 孩子最近的活动记录\n" + summary;

  // 清理 messages：只允许 user/assistant + 字符串 content
  const clean = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const reply = await callMiniMax({ system, messages: clean, max_tokens: 1500 });
    send(res, 200, { reply });
  } catch (err) {
    console.error("[parent-chat]", err);
    send(res, 502, { error: String(err.message || err) });
  }
}

// 把事件压成给 AI 看的纯文本摘要
function summarizeEvents(events) {
  if (!events.length) return "（暂无活动记录）";
  // 按类型分组统计
  const byType = {};
  for (const e of events) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e);
  }
  const fmt = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false });
  const lines = [];

  // 情绪对话
  const emoMsgs = byType["emotion-message"] || [];
  if (emoMsgs.length) {
    lines.push(`### 情绪聊天（${emoMsgs.length} 句小猫的话）`);
    // 取最近 8 句
    for (const e of emoMsgs.slice(-8)) {
      lines.push(`- [${fmt(e.ts)}] 小猫: ${e.text?.slice(0, 80) || ""}`);
    }
  }
  const sessions = byType["emotion-session-end"] || [];
  if (sessions.length) {
    const total = sessions.reduce((s, e) => s + (e.durationSec || 0), 0);
    lines.push(`- 累计聊天 ${sessions.length} 次，总时长约 ${Math.round(total / 60)} 分钟`);
  }

  // 数学岛 · 合理安排时间（甘特图）
  const mathOk = byType["math-success"] || [];
  const mathFail= byType["math-fail"] || [];
  const mathSub = byType["math-suboptimal"] || [];
  if (mathOk.length || mathFail.length || mathSub.length) {
    lines.push(`### 数学岛 · 合理安排时间`);
    if (mathOk.length)  lines.push(`- 答对 ${mathOk.length} 题（最优解）：${mathOk.slice(-5).map((e) => e.title).join("、")}`);
    if (mathSub.length) lines.push(`- 完成但非最优 ${mathSub.length} 次`);
    if (mathFail.length)lines.push(`- 失败 ${mathFail.length} 次（可能题目还没理解）`);
  }

  // 数学岛 · 拍照解题
  const photoSubmits = byType["math-photo-submit"] || [];
  const photoSolved  = byType["math-photo-solved"] || [];
  if (photoSubmits.length || photoSolved.length) {
    lines.push(`### 数学岛 · 拍照解题（GPT-5.5 + Manim 动画）`);
    lines.push(`- 提交了 ${photoSubmits.length} 道题`);
    if (photoSolved.length) {
      const totalSec = photoSolved.reduce((s, e) => s + (e.durationSec || 0), 0);
      const avgSec = Math.round(totalSec / photoSolved.length);
      lines.push(`- 完整解出 ${photoSolved.length} 道，平均耗时约 ${avgSec} 秒`);
      const recent = photoSolved.slice(-3).map((e) => fmt(e.ts)).join("、");
      lines.push(`- 最近完成时间：${recent}`);
    }
    if (photoSubmits.length > photoSolved.length) {
      lines.push(`- 有 ${photoSubmits.length - photoSolved.length} 道题没看完动画就换题，可能是题目难度或耐心问题`);
    }
  }

  // 创造
  const paintings = byType["creation-painting"] || [];
  const stories   = byType["creation-story"]    || [];
  const videos    = byType["creation-video"]    || [];
  if (paintings.length || stories.length || videos.length) {
    lines.push(`### 创造房间`);
    if (paintings.length) {
      lines.push(`- 上传画作 ${paintings.length} 幅，最近一幅描述：「${paintings[paintings.length-1].description?.slice(0, 200) || ""}」`);
    }
    if (stories.length)  lines.push(`- 编出故事 ${stories.length} 个`);
    if (videos.length)   lines.push(`- 生成动画视频 ${videos.length} 部`);
  }

  return lines.join("\n");
}

async function routeDescribe(req, res) {
  const body = await readJsonBody(req);
  const image = body.image; // dataURL or http url
  if (!image || typeof image !== "string") {
    return send(res, 400, { error: "image (dataURL) required" });
  }

  // OpenAI-compatible image_url (Doubao accepts both http and data URLs)
  const imagePart = { type: "image_url", image_url: { url: image } };

  try {
    const description = await callDoubaoChat({
      model: ARK_VISION_MODEL,
      messages: [
        {
          role: "system",
          content:
            "你是一个细心的视觉描述助手。给你一张儿童画,请你用 80-150 个中文字描述这张画里的:\n" +
            "1) 主要角色(物种、颜色、特征)\n2) 场景或背景\n3) 关键道具或细节\n" +
            "不要评价画功,不要猜测寓意,只描述画面本身。一段话即可,不要列表。",
        },
        {
          role: "user",
          content: [imagePart, { type: "text", text: "请描述这张画。" }],
        },
      ],
      max_tokens: 600,
    });
    send(res, 200, { description: description.trim() });
  } catch (err) {
    console.error("[describe]", err);
    send(res, 502, { error: String(err.message || err) });
  }
}

function tryParseFramesJson(text) {
  // look for the last ```json ... ``` block, or a bare {...} block containing "frames"
  const fenced = /```(?:json)?\s*([\s\S]+?)```/gi;
  let last = null;
  let m;
  while ((m = fenced.exec(text)) !== null) last = m[1];
  const candidates = [];
  if (last) candidates.push(last.trim());
  // also try the whole text trimmed
  candidates.push(text.trim());
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && Array.isArray(obj.frames) && obj.frames.length > 0) return obj;
    } catch (_) {}
  }
  return null;
}

function stripFencedJson(text) {
  return text.replace(/```(?:json)?\s*[\s\S]+?```/gi, "").trim();
}

async function routeCoach(req, res) {
  const body = await readJsonBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const imageDesc = typeof body.image_description === "string" ? body.image_description : "";

  if (messages.length === 0) {
    return send(res, 400, { error: "messages required" });
  }

  // Build system prompt: skill + (optional) image-description context
  let system = loadSkillPrompt();
  if (imageDesc) {
    system += `\n\n---\n## 当前孩子的画\n\n${imageDesc}`;
  }
  if (body.regenerate && typeof body.regenerate.frame === "number") {
    const fb = body.regenerate.feedback ? `,反馈是:${body.regenerate.feedback}` : "";
    system += `\n\n---\n## 重生请求\n孩子要求重生第 ${body.regenerate.frame} 帧${fb}。请只输出该帧的新 prompt(JSON 格式,frames 只含一项)。`;
  }

  // sanitize input messages: only role+content allowed
  const cleanMsgs = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));

  let reply;
  try {
    reply = await callMiniMax({ system, messages: cleanMsgs, max_tokens: 2048 });
  } catch (err) {
    console.error("[coach]", err);
    return send(res, 502, { error: String(err.message || err) });
  }

  const parsed = tryParseFramesJson(reply);
  if (!parsed) {
    return send(res, 200, { reply, frames: null });
  }

  // We got frames from the coach. Render each frame via Seedream.
  const visibleReply = stripFencedJson(reply) || `好啦,小故事写好咯!我来变出画面,你等等哦~ ✨`;
  const frames = [];
  for (const f of parsed.frames) {
    if (!f || typeof f.prompt !== "string") continue;
    try {
      const url = await callSeedream({ prompt: f.prompt });
      frames.push({ n: f.n, scene: f.scene || "", prompt: f.prompt, url });
    } catch (err) {
      console.error("[coach/render frame", f.n, "]", err.message);
      frames.push({ n: f.n, scene: f.scene || "", prompt: f.prompt, error: String(err.message || err) });
    }
  }
  send(res, 200, { reply: visibleReply, frames, title: parsed.title || "" });
}

async function routeRender(req, res) {
  const body = await readJsonBody(req);
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "string") {
    return send(res, 400, { error: "prompt required" });
  }
  try {
    const url = await callSeedream({ prompt, size: body.size || "2K" });
    send(res, 200, { url });
  } catch (err) {
    console.error("[render]", err);
    send(res, 502, { error: String(err.message || err) });
  }
}

async function routeRegenFrame(req, res) {
  const body = await readJsonBody(req);
  const { n, prompt } = body;
  if (!n || !prompt) return send(res, 400, { error: "n and prompt required" });
  try {
    console.log(`[regen] frame ${n}, prompt: ${prompt.slice(0, 80)}...`);
    const url = await callSeedream({ prompt });
    send(res, 200, { frames: [{ n, url, prompt, scene: body.scene || "" }] });
  } catch (err) {
    console.error("[regen]", err);
    send(res, 502, { error: String(err.message || err) });
  }
}

// ----- Creation room: 生图 / 生视频（基于拼贴画 + 聊天历史） -----

// 把聊天 + 拼贴图描述 → 一段英文图像 prompt（给 Seedream / Seedance）
//
// 关键设计：prompt **模板化构造**，不让 LLM 写整段（之前 LLM 会被孩子聊天带跑、输出中文反问）。
// LLM 只用来：
//   1) 视觉模型描述拼贴（英文 2-3 句）
//   2) 把孩子的原图中文描述译成 1 句英文
// 然后用固定英文模板拼出最终 Seedream prompt。
async function buildCreationPrompt({ collageDataUrl, messages, originalDescription, placedStickers = [] }) {
  // Step A: vision 描述当前拼贴画（含贴纸 / 涂鸦）—— 英文 2-3 句
  let collageDesc = "";
  try {
    collageDesc = await callDoubaoChat({
      model: ARK_VISION_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a careful visual describer. Look at this kid's collage. Write 2-3 short English sentences. List the main subjects, what they are doing, and any small icons / stickers / extra objects added on top of the original drawing. Use simple words. Don't invent anything not visible. Don't comment on art quality. English only.",
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: collageDataUrl } },
            { type: "text", text: "Describe this collage in English." },
          ],
        },
      ],
      max_tokens: 280,
    });
    collageDesc = (collageDesc || "").trim();
  } catch (err) {
    console.warn("[creation] vision describe failed:", err.message);
  }

  // Step B: 把孩子原图中文描述 → 1 句英文（短任务，LLM 不会走神）
  let sceneEn = "";
  if (originalDescription) {
    try {
      sceneEn = await callMiniMax({
        system: "You are a precision translator. Translate the Chinese input to ONE English sentence under 25 words. Output ONLY the final English sentence on a single line, nothing else.",
        messages: [{ role: "user", content: originalDescription }],
        max_tokens: 600, // M2.7 是 reasoning 模型，需要给 thinking 留空间
      });
      sceneEn = (sceneEn || "").trim().replace(/^["']|["']$/g, "");
    } catch (err) {
      console.warn("[creation] translate failed:", err.message);
    }
  }

  // 孩子贴到画上的素材清单
  const stickerNames = (placedStickers || [])
    .map((s) => (s && s.name ? String(s.name).trim() : ""))
    .filter(Boolean);
  const stickerLine = stickerNames.length
    ? `The kid added these specific food items on the table that must all appear: ${stickerNames.join(", ")}.`
    : "";

  // Step C: 用固定模板拼出英文 Seedream prompt
  const STYLE = "Pixel art, isometric 3/4 view, Stardew Valley style, 16-bit pixel style, 16:9 aspect ratio, warm cozy lighting, family-friendly, no violence";
  const sceneLine = sceneEn || "A warm everyday family scene";
  const collageLine = collageDesc ? `Scene details: ${collageDesc}` : "";

  const finalPrompt = [
    STYLE + ".",
    `Subject: ${sceneLine}.`,
    collageLine,
    stickerLine,
    "Soft palette, cozy mood, no text or watermark.",
  ].filter(Boolean).join(" ");

  return { prompt: finalPrompt, collageDesc, sceneEn };
}

// 生图：拼贴 + 聊天 → Seedream
async function routeCreationImage(req, res) {
  const body = await readJsonBody(req);
  const { canvasPng, messages, imageDescription, placedStickers } = body;
  if (!canvasPng) return send(res, 400, { error: "canvasPng required" });

  try {
    const { prompt, collageDesc } = await buildCreationPrompt({
      collageDataUrl: canvasPng,
      messages: messages || [],
      originalDescription: imageDescription || "",
      placedStickers: placedStickers || [],
    });
    console.log(`[creation/image] prompt: ${prompt.slice(0, 120)}...`);
    const url = await callSeedream({ prompt, size: "2K" });
    send(res, 200, { url, prompt, collageDesc });
  } catch (err) {
    console.error("[creation/image]", err);
    send(res, 502, { error: String(err.message || err) });
  }
}

// 生视频：拼贴 + 聊天 → Seedance（异步任务）
const _creationVideoTasks = new Map(); // taskId -> { status, videoUrl, error }

async function routeCreationVideo(req, res) {
  const body = await readJsonBody(req);
  const { canvasPng, messages, imageDescription, placedStickers } = body;
  if (!canvasPng) return send(res, 400, { error: "canvasPng required" });

  // 立即建一个任务 id 返回，后台跑生成
  const taskId = `cv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _creationVideoTasks.set(taskId, { status: "pending" });
  send(res, 202, { taskId });

  // 后台跑
  (async () => {
    try {
      const { prompt } = await buildCreationPrompt({
        collageDataUrl: canvasPng,
        messages: messages || [],
        originalDescription: imageDescription || "",
        placedStickers: placedStickers || [],
      });
      console.log(`[creation/video ${taskId}] prompt: ${prompt.slice(0, 120)}...`);
      _creationVideoTasks.set(taskId, { status: "running", progress: "正在生成视频…" });

      const videoUrl = await callSeedance({
        prompt,
        frameImages: [{ url: canvasPng, role: "first_frame" }],
        duration: 10,
      });
      _creationVideoTasks.set(taskId, { status: "done", videoUrl });
    } catch (err) {
      console.error(`[creation/video ${taskId}]`, err);
      _creationVideoTasks.set(taskId, { status: "error", error: String(err.message || err) });
    }
  })();
}

async function routeCreationVideoStatus(req, res, taskId) {
  const t = _creationVideoTasks.get(taskId);
  if (!t) return send(res, 404, { error: "task not found" });
  send(res, 200, t);
}

// ----- async video task queue -----
// Tasks stored in memory: { status, videoUrls, error, progress }
const videoTasks = new Map();
let taskCounter = 0;

function makeTaskId() {
  return `vtask_${Date.now()}_${++taskCounter}`;
}

async function runVideoTask(taskId, frames, title) {
  const task = videoTasks.get(taskId);
  const f1 = frames[0];
  const f2 = frames[1];
  const f3 = frames[frames.length - 1];

  const style = "Pixel art animation, Stardew Valley style, smooth cinematic transition.";
  const prompt12 = `${style} Start: ${f1?.prompt || ""}. End: ${f2?.prompt || ""}. Story: "${title}".`;
  const prompt23 = `${style} Start: ${f2?.prompt || ""}. End: ${f3?.prompt || ""}. Story: "${title}".`;

  async function makeClip(label, firstUrl, lastUrl, prompt) {
    task.progress = `生成${label}中...`;
    try {
      return await callSeedance({
        prompt,
        frameImages: [
          { url: firstUrl, role: "first_frame" },
          { url: lastUrl,  role: "last_frame" },
        ].filter(f => f.url),
        duration: 5,
      });
    } catch (err) {
      console.warn(`[video] ${label} first+last failed, retrying first-only:`, err.message.slice(0, 100));
      return await callSeedance({
        prompt,
        frameImages: [{ url: firstUrl, role: "first_frame" }],
        duration: 5,
      });
    }
  }

  try {
    task.progress = "提交生成任务...";
    const [r1, r2] = await Promise.allSettled([
      makeClip("片段1(分镜1→2)", f1?.url, f2?.url, prompt12),
      makeClip("片段2(分镜2→3)", f2?.url, f3?.url, prompt23),
    ]);

    if (r1.status === "rejected") console.error("[video] clip1 failed:", r1.reason?.message);
    if (r2.status === "rejected") console.error("[video] clip2 failed:", r2.reason?.message);

    const cdnUrls = [r1, r2]
      .filter(r => r.status === "fulfilled" && r.value)
      .map(r => r.value);

    if (cdnUrls.length === 0) throw new Error("两段均生成失败");

    // Download MP4s to local disk so they never expire
    task.progress = "下载视频到本地...";
    const clipPaths = [];
    for (let i = 0; i < cdnUrls.length; i++) {
      const filename = `${taskId}-clip${i}.mp4`;
      const filepath = path.join(VIDEO_CACHE_DIR, filename);
      const dl = await fetch(cdnUrls[i]);
      if (!dl.ok) throw new Error(`download clip ${i}: ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      writeFileSync(filepath, buf);
      clipPaths.push(filepath);
      console.log(`[video] cached clip ${i} → ${filename} (${(buf.length/1024).toFixed(0)}KB)`);
    }

    // Concatenate into one file if multiple clips
    let finalFilename, finalPath;
    if (clipPaths.length > 1) {
      task.progress = "拼接视频...";
      finalFilename = `${taskId}-final.mp4`;
      finalPath = path.join(VIDEO_CACHE_DIR, finalFilename);
      await concatMp4(clipPaths, finalPath);
      // Clean up individual clips
      for (const p of clipPaths) { try { unlinkSync(p); } catch (_) {} }
      console.log(`[video] concatenated ${clipPaths.length} clips → ${finalFilename}`);
    } else {
      finalFilename = path.basename(clipPaths[0]);
      finalPath = clipPaths[0];
    }

    task.status = "done";
    task.videoUrls = [`/api/storyboard/video-file/${taskId}/final`];
    task.progress = "完成";
    console.log(`[video] task ${taskId} done → ${finalFilename}`);
  } catch (err) {
    task.status = "error";
    task.error = String(err.message || err);
    console.error(`[video] task ${taskId} error:`, err.message);
  }
}

async function routeVideoSubmit(req, res) {
  const body = await readJsonBody(req);
  const frames = Array.isArray(body.frames) ? body.frames.filter(Boolean) : [];
  if (frames.length === 0) return send(res, 400, { error: "frames required" });

  const taskId = makeTaskId();
  const title = typeof body.title === "string" ? body.title : "A short story";
  videoTasks.set(taskId, { status: "running", progress: "初始化...", videoUrls: null, error: null });

  // Fire and forget — task runs in background
  runVideoTask(taskId, frames, title).catch(() => {});

  send(res, 202, { taskId });
}

// Concatenate multiple MP4 files into one using ffmpeg concat demuxer (no re-encode)
function concatMp4(inputPaths, outputPath) {
  return new Promise((resolve, reject) => {
    // Write a temporary concat list file
    const listPath = outputPath + ".txt";
    const listContent = inputPaths.map(p => `file '${p}'`).join("\n");
    writeFileSync(listPath, listContent);
    execFile("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      outputPath,
    ], (err, stdout, stderr) => {
      try { unlinkSync(listPath); } catch (_) {}
      if (err) {
        console.error("[ffmpeg]", stderr?.slice(-300));
        reject(new Error(`ffmpeg failed: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

function routeVideoFile(req, res, taskId, clipIndex) {
  // clipIndex is "final" for concatenated or a number for single-clip fallback
  const filename = clipIndex === "final"
    ? `${taskId}-final.mp4`
    : `${taskId}-clip${clipIndex}.mp4`;
  const filepath = path.join(VIDEO_CACHE_DIR, filename);
  if (!existsSync(filepath)) {
    return send(res, 404, { error: "video file not found" });
  }
  res.writeHead(200, {
    "content-type": "video/mp4",
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000",
  });
  createReadStream(filepath).pipe(res);
}

function routeVideoStatus(req, res, taskId) {
  const task = videoTasks.get(taskId);
  if (!task) return send(res, 404, { error: "task not found" });
  send(res, 200, {
    status: task.status,
    progress: task.progress,
    videoUrls: task.videoUrls,
    error: task.error,
  });
}

// ----- server -----
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method === "GET" && req.url === "/healthz") {
    return send(res, 200, {
      ok: true,
      hasArkKey: !!ARK_API_KEY,
      hasMinimaxKey: !!MINIMAX_API_KEY,
      hasAgentKey: !!AGENT_API_KEY,
      imageModel: ARK_IMAGE_MODEL,
      agentModel: AGENT_API_KEY ? AGENT_MODEL : null,
    });
  }
  try {
    if (req.method === "POST" && req.url === "/api/parent/chat") return routeParentChat(req, res);
    if (req.method === "POST" && req.url === "/api/kids/sync-events") return routeSyncEvents(req, res);
    if (req.method === "POST" && req.url === "/api/kids/sync-events/bulk") return routeSyncEventsBulk(req, res);
    if (req.method === "POST" && req.url === "/api/emotion/save-session") return routeSaveEmotionSession(req, res);

    // 数学岛 · 拍照解题
    if (req.method === "POST" && req.url === "/api/math/solve") return routeMathSolve(req, res);
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/api/math/video/")) {
      const jobId = req.url.slice("/api/math/video/".length);
      return routeMathVideo(req, res, jobId);
    }
    if ((req.method === "GET" || req.method === "HEAD") && req.url.startsWith("/api/math/solution/")) {
      const file = req.url.slice("/api/math/solution/".length);
      const jobId = file.replace(/\.html$/, "");
      return routeMathSolution(req, res, jobId);
    }
    if (req.method === "GET" && req.url.startsWith("/api/math/solve/") && req.url.endsWith("/stream")) {
      const jobId = req.url.split("/")[4];
      return routeMathStream(req, res, jobId);
    }
    if (req.method === "POST" && req.url.startsWith("/api/math/solve/") && req.url.endsWith("/cancel")) {
      const jobId = req.url.split("/")[4];
      return routeMathCancel(req, res, jobId);
    }

    if (req.method === "POST" && req.url === "/api/storyboard/describe") return routeDescribe(req, res);
    if (req.method === "POST" && req.url === "/api/storyboard/coach") return routeCoach(req, res);
    if (req.method === "POST" && req.url === "/api/creation/stt") return routeStt(req, res);
    if (req.method === "POST" && req.url === "/api/openclaw/sync-memory") return routeSyncMemory(req, res);
    if (req.method === "POST" && req.url === "/api/creation/generate-image") return routeCreationImage(req, res);
    if (req.method === "POST" && req.url === "/api/creation/generate-video") return routeCreationVideo(req, res);
    if (req.method === "GET" && req.url.startsWith("/api/creation/video/")) {
      const taskId = req.url.split("/").pop();
      return routeCreationVideoStatus(req, res, taskId);
    }
    if (req.method === "POST" && req.url === "/api/storyboard/render") return routeRender(req, res);
    if (req.method === "POST" && req.url === "/api/storyboard/regen-frame") return routeRegenFrame(req, res);
    if (req.method === "POST" && req.url === "/api/storyboard/video") return routeVideoSubmit(req, res);
    if (req.method === "GET" && req.url.startsWith("/api/storyboard/video-file/")) {
      // /api/storyboard/video-file/:taskId/:clipIndex
      const parts = req.url.split("/");
      const clipIndex = parts.pop();
      const taskId = parts.pop();
      return routeVideoFile(req, res, taskId, clipIndex);
    }
    if (req.method === "GET" && req.url.startsWith("/api/storyboard/video/")) {
      const taskId = req.url.split("/").pop();
      return routeVideoStatus(req, res, taskId);
    }
  } catch (err) {
    console.error("[server]", err);
    return send(res, 500, { error: String(err.message || err) });
  }
  send(res, 404, { error: "not found" });
});

// ---- 把 Sanctuary 孩子日志同步到 OpenClaw 记忆目录 ----
// 落到 ~/.openclaw/workspace/memory/<YYYY-MM-DD>-sanctuary-<kidName>.md
// OpenClaw 的 memory-core / dreaming 自动把它当短期记忆索引、提取、提升到 MEMORY.md
const OPENCLAW_MEMORY_DIR = path.join(homedir(), ".openclaw", "workspace", "memory");
const KID_NAME = process.env.SANCTUARY_KID_NAME || "小十二";

const EVENT_DESCRIPTIONS = {
  "creation-painting":   "上传了一张画到创造房间",
  "creation-story":      "和蛋蛋编了一个故事",
  "creation-image":      "让 AI 把画作生成了一张新插画",
  "creation-video":      "让 AI 把画作做成了一段动画",
  "math-success":        "数学题做出最优解",
  "math-suboptimal":     "数学题完成（非最优）",
  "emotion-message":     "情绪房间和小喵对话",
  "emotion-session-start": "进入情绪房间开始对话",
  "emotion-session-end": "结束了情绪房间对话",
};

// 节流：10 秒内多次事件只触发一次写盘
let _openclawSyncTimer = null;
function scheduleOpenclawMemorySync() {
  if (_openclawSyncTimer) return;
  _openclawSyncTimer = setTimeout(() => {
    _openclawSyncTimer = null;
    syncToOpenclawMemory().catch((err) => console.warn("[openclaw-sync]", err.message));
  }, 8000);
}

async function syncToOpenclawMemory() {
  const events = loadStoredEvents();
  if (!events.length) return;
  const todayKey = new Date().toISOString().slice(0, 10);
  const startOfDay = new Date(`${todayKey}T00:00:00`).getTime();
  const todayEvents = events.filter((e) => e.ts >= startOfDay);
  if (!todayEvents.length) return;

  const md = renderKidsMemoryMd(KID_NAME, todayKey, todayEvents);
  const file = path.join(OPENCLAW_MEMORY_DIR, `${todayKey}-sanctuary-${KID_NAME}.md`);
  await fsp.mkdir(OPENCLAW_MEMORY_DIR, { recursive: true });
  await fsp.writeFile(file, md, "utf8");
  console.log("[openclaw-sync] →", file, `(${todayEvents.length} events)`);
}

// 显式 API：家长模式按"生成日报"或定时也能触发
async function routeSyncMemory(req, res) {
  try {
    await syncToOpenclawMemory();
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 500, { error: String(err.message || err) });
  }
}

function renderKidsMemoryMd(kidName, dateKey, events) {
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  // 按事件类型做小计
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  const summary = Object.entries(byType)
    .map(([t, n]) => `${EVENT_DESCRIPTIONS[t] || t} × ${n}`)
    .join("，");

  const lines = events.map((e) => {
    const time = fmtTime(e.ts);
    const desc = EVENT_DESCRIPTIONS[e.type] || e.type;
    let detail = "";
    if (e.text) detail = `：${String(e.text).replace(/\n/g, " ").slice(0, 200)}`;
    else if (e.problemText) detail = `：${String(e.problemText).slice(0, 100)}`;
    else if (e.role === "assistant" && e.text) detail = `（小喵）：${e.text.slice(0, 200)}`;
    else if (e.role === "user" && e.text) detail = `（孩子）：${e.text.slice(0, 200)}`;
    return `- [${time}] ${desc}${detail}`;
  });

  return [
    `# Sanctuary · ${kidName} 的 ${dateKey} 日志`,
    "",
    `- **来源**：Sanctuary 家庭虾应用（孩子端）`,
    `- **孩子**：${kidName}`,
    `- **日期**：${dateKey}`,
    `- **概览**：${summary || "（无事件）"}`,
    "",
    "## 详细事件",
    "",
    ...lines,
    "",
  ].join("\n");
}

// 用 ffmpeg volumedetect 算平均音量（dBFS，越接近 0 越响）
function detectMeanVolume(wavFile) {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-i", wavFile, "-af", "volumedetect", "-f", "null", "-"];
    const ff = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => { err += d.toString("utf8"); });
    ff.on("error", () => resolve(null));
    ff.on("close", () => {
      const m = err.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
      resolve(m ? parseFloat(m[1]) : null);
    });
  });
}

// ---- /api/creation/stt：豆包 Realtime 当 STT 用 ----
// 客户端上传 webm/opus → ffmpeg 转 16kHz s16le PCM → 喂给豆包，等 asr_final → 返回文字
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

async function routeStt(req, res) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 25 * 1024 * 1024) return send(res, 413, { error: "audio too large" });
    chunks.push(c);
  }
  const audioBytes = Buffer.concat(chunks);
  if (!audioBytes.length) return send(res, 400, { error: "no audio" });

  if (!process.env.DOUBAO_REALTIME_APP_ID || !process.env.DOUBAO_REALTIME_ACCESS_KEY) {
    return send(res, 500, { error: "DOUBAO_REALTIME_* not set in .env" });
  }

  const contentType = (req.headers["content-type"] || "audio/webm").split(";")[0].trim();
  const ext =
    contentType.includes("wav") ? "wav"
    : contentType.includes("mp3") ? "mp3"
    : contentType.includes("mp4") || contentType.includes("m4a") ? "m4a"
    : contentType.includes("ogg") ? "ogg"
    : "webm";

  const tmp = tmpdir();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile = path.join(tmp, `stt-${stamp}.${ext}`);
  const pcmFile = path.join(tmp, `stt-${stamp}.pcm`);
  const wavFile = path.join(tmp, `stt-${stamp}.wav`);

  try {
    await fsp.writeFile(inFile, audioBytes);

    // ffmpeg → 16kHz mono s16le 原始 PCM + wav（用 wav 做静音检测）
    await new Promise((resolve, reject) => {
      const ff = spawn(FFMPEG_BIN, [
        "-y", "-i", inFile,
        "-ar", "16000", "-ac", "1", wavFile,
        "-ar", "16000", "-ac", "1", "-f", "s16le", pcmFile,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      ff.stderr.on("data", (d) => { err += d.toString("utf8"); });
      ff.on("error", reject);
      ff.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`)));
    });

    // 静音兜底：低于 -65 dB 直接返回空，省掉一次豆包调用
    const meanDb = await detectMeanVolume(wavFile);
    if (meanDb !== null && meanDb < -65) {
      console.log("[stt] 静音 (mean_volume", meanDb, "dB)，跳过");
      return send(res, 200, { text: "" });
    }

    const realPcm = await fsp.readFile(pcmFile);
    // 末尾补 0.5 秒静音，让豆包 server VAD 有空间触发"用户说完了"
    const SILENCE_MS = 500;
    const SILENCE_BYTES = (16000 * SILENCE_MS / 1000) * 2;
    const pcmBytes = Buffer.concat([realPcm, Buffer.alloc(SILENCE_BYTES, 0)]);

    // 走豆包 Realtime，仅取 ASR，丢弃 LLM/TTS 输出
    const text = await transcribeViaDoubao(pcmBytes);
    console.log("[stt] →", JSON.stringify(text));
    return send(res, 200, { text });
  } catch (err) {
    console.error("[stt]", err);
    return send(res, 500, { error: String(err.message || err) });
  } finally {
    for (const f of [inFile, wavFile, pcmFile]) fsp.unlink(f).catch(() => {});
  }
}

function transcribeViaDoubao(pcmBytes) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let asrText = "";
    let session = null;

    const finishWith = (resolveFn, valOrErr, isErr = false) => {
      if (resolved) return;
      resolved = true;
      try { session?.finish(); } catch {}
      if (isErr) reject(valOrErr); else resolveFn(valOrErr);
    };

    const timeout = setTimeout(() => {
      finishWith(resolve, asrText); // 超时也返回已识别的（有总比没有强）
    }, 20000);

    session = startDoubaoSession({
      appId: process.env.DOUBAO_REALTIME_APP_ID,
      accessKey: process.env.DOUBAO_REALTIME_ACCESS_KEY,
      speaker: process.env.DOUBAO_REALTIME_SPEAKER || "zh_female_vv_jupiter_bigtts",
      botName: "STT",
      systemRole: "",
      speakingStyle: "",
      onEvent(ev) {
        if (ev.type === "session_started") {
          // 推 20ms 一包：16k * 20ms * 2 byte = 640 字节
          const CHUNK = 640;
          let off = 0;
          const tick = setInterval(() => {
            if (off >= pcmBytes.length) {
              clearInterval(tick);
              return;
            }
            try { session.sendAudio(pcmBytes.subarray(off, off + CHUNK)); } catch {}
            off += CHUNK;
          }, 20);
        } else if (ev.type === "asr_final") {
          asrText += ev.text || "";
        } else if (ev.type === "asr_ended") {
          // ASR 结束 = 用户话说完了，可以收工，不等 LLM/TTS
          clearTimeout(timeout);
          finishWith(resolve, asrText.trim());
        } else if (ev.type === "error") {
          clearTimeout(timeout);
          finishWith(reject, new Error(`doubao stt error: ${JSON.stringify(ev.payload || ev.code)}`), true);
        }
      },
    });
  });
}

// ---- WebSocket: 浏览器 ↔ 我们 ↔ 豆包 Realtime 代理 ----
import { WebSocketServer } from "ws";
import { startDoubaoSession } from "./doubao-realtime.mjs";

const DOUBAO_REALTIME_APP_ID = process.env.DOUBAO_REALTIME_APP_ID || "";
const DOUBAO_REALTIME_ACCESS_KEY = process.env.DOUBAO_REALTIME_ACCESS_KEY || "";
const DOUBAO_REALTIME_SPEAKER = process.env.DOUBAO_REALTIME_SPEAKER || "zh_female_vv_jupiter_bigtts";

const emotionWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/emotion/realtime") {
    emotionWss.handleUpgrade(req, socket, head, (browserWs) => {
      handleEmotionConnection(browserWs);
    });
  } else {
    socket.destroy();
  }
});

function handleEmotionConnection(browserWs) {
  console.log("[emotion-ws] browser 连上");
  let doubao = null;

  browserWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (doubao && doubao.isOpen()) {
        doubao.sendAudio(Buffer.isBuffer(data) ? data : Buffer.from(data));
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString("utf8")); } catch {
      console.warn("[emotion-ws] 无法解析消息", data.toString("utf8").slice(0, 100));
      return;
    }
    console.log("[emotion-ws] ←", msg.type);

    if (msg.type === "start") {
      if (!DOUBAO_REALTIME_APP_ID || !DOUBAO_REALTIME_ACCESS_KEY) {
        const err = "DOUBAO_REALTIME_* 没配在 .env";
        console.warn("[emotion-ws]", err);
        browserWs.send(JSON.stringify({ type: "error", message: err }));
        return;
      }
      console.log("[emotion-ws] 开豆包会话…");
      doubao = startDoubaoSession({
        appId: DOUBAO_REALTIME_APP_ID,
        accessKey: DOUBAO_REALTIME_ACCESS_KEY,
        speaker: msg.speaker || DOUBAO_REALTIME_SPEAKER,
        botName: msg.botName || "小喵",
        systemRole: msg.systemRole || "",
        speakingStyle: msg.speakingStyle || "",
        onEvent(ev) {
          if (ev.type === "error") console.warn("[doubao] error", ev);
          else if (ev.type === "session_started") console.log("[doubao] session_started");
          else if (ev.type === "asr_final") console.log("[doubao] asr:", ev.text);
          else if (ev.type === "chat_ended") console.log("[doubao] chat done");
          if (browserWs.readyState !== browserWs.OPEN) return;
          if (ev.type === "tts_audio") {
            browserWs.send(ev.pcm);
          } else {
            browserWs.send(JSON.stringify(ev));
          }
        },
      });
    } else if (msg.type === "interrupt" && doubao) {
      doubao.interrupt();
    } else if (msg.type === "stop" && doubao) {
      doubao.finish();
    }
  });

  browserWs.on("close", () => {
    console.log("[emotion-ws] browser 断开");
    try { doubao?.finish(); } catch {}
  });
  browserWs.on("error", (err) => {
    console.warn("[emotion-ws] browser err", err.message);
    try { doubao?.finish(); } catch {}
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[storyboard] listening on http://127.0.0.1:${PORT}`);
  console.log(`  ARK key: ${ARK_API_KEY ? "set" : "MISSING"} (model ${ARK_IMAGE_MODEL})`);
  console.log(`  MiniMax key: ${MINIMAX_API_KEY ? "set" : "MISSING"}`);
  // 启动时先同步一次今日记忆
  syncToOpenclawMemory().catch((err) => console.warn("[openclaw-sync init]", err.message));
});
