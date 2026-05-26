/**
 * gen-cat-videos.mjs
 *
 * 使用 Doubao Seedance API 以 emotion.png 作为参考图，
 * 生成 5 种情绪状态的猫猫动画视频，保存到 ui/public/kids/assets/cat-actions/
 *
 * 运行: node gen-cat-videos.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// Load env
const envPath = path.join(REPO_ROOT, ".env");
const envVars = {};
if (existsSync(envPath)) {
  readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (m) envVars[m[1]] = m[2].trim();
  });
}

const ARK_API_KEY = envVars.ARK_API_KEY || process.env.ARK_API_KEY || "";
const ARK_BASE_URL = envVars.ARK_BASE_URL || process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_VIDEO_MODEL = envVars.ARK_VIDEO_MODEL || process.env.ARK_VIDEO_MODEL || "doubao-seedance-1-5-pro-251215";

if (!ARK_API_KEY) {
  console.error("ARK_API_KEY not set");
  process.exit(1);
}

// Output directory — 新位置，单独的猫角色动画
const OUT_DIR = path.join(REPO_ROOT, "ui/public/kids/assets/cat/live2d");
mkdirSync(OUT_DIR, { recursive: true });

// Reference image: 纯猫角色（无房间背景），可叠加到任何场景
const CAT_IMAGE_PATH = path.join(REPO_ROOT, "ui/public/kids/assets/cat/character-source.png");
const catImageB64 = readFileSync(CAT_IMAGE_PATH).toString("base64");
const CAT_IMAGE_URL = `data:image/png;base64,${catImageB64}`;

// 5 emotional states — 强调纯背景 + 猫不动位置（首尾帧一致）
const BG_KEYWORD = "on a pure solid color background, no environment, no shadows, no other objects, the cat stays in the exact same position in every frame";

const STATES = [
  {
    name: "idle",
    prompt:
      `A cute pixel-art gray tabby kitten with a green bow tie collar, sitting still in the same spot, only breathing softly with subtle chest rise and fall, occasional slow blink, very minimal motion, calm idle loop, ${BG_KEYWORD}, no camera movement`,
  },
  {
    name: "listening",
    prompt:
      `A cute pixel-art gray tabby kitten with a green bow tie collar, ears perking up and twitching attentively, head tilting slightly side to side, eyes wide and curious, body stays in the same sitting position, ${BG_KEYWORD}, no camera movement`,
  },
  {
    name: "thinking",
    prompt:
      `A cute pixel-art gray tabby kitten with a green bow tie collar, looking up thoughtfully, slowly tilting head left and right, eyes blinking and narrowing in concentration, body stays in the same sitting position, ${BG_KEYWORD}, no camera movement`,
  },
  {
    name: "speaking",
    prompt:
      `A cute pixel-art gray tabby kitten with a green bow tie collar, mouth opening and closing repeatedly as if talking, expressive meowing animation, slight head bob, body stays in the same sitting position, ${BG_KEYWORD}, no camera movement`,
  },
  {
    name: "happy",
    prompt:
      `A cute pixel-art gray tabby kitten with a green bow tie collar, joyfully bouncing slightly in place, ears wiggling, eyes sparkling, big smile, tail wagging, body stays roughly centered, ${BG_KEYWORD}, no camera movement`,
  },
];

async function submitSeedanceTask(prompt, imageUrl) {
  const fullPrompt = `${prompt} --duration 5 --camerafixed true --watermark false`;
  const content = [
    { type: "text", text: fullPrompt },
    { type: "image_url", image_url: { url: imageUrl }, role: "first_frame" },
  ];

  const res = await fetch(`${ARK_BASE_URL}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ARK_API_KEY}`,
    },
    body: JSON.stringify({ model: ARK_VIDEO_MODEL, content }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Seedance submit ${res.status}: ${t.slice(0, 400)}`);
  }
  const j = await res.json();
  const taskId = j?.id;
  if (!taskId) throw new Error(`No task id: ${JSON.stringify(j).slice(0, 200)}`);
  return taskId;
}

async function pollSeedanceTask(taskId) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const res = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${ARK_API_KEY}` },
    });
    if (!res.ok) { console.log(`  poll ${i + 1}: HTTP ${res.status}`); continue; }
    const j = await res.json();
    const status = String(j?.status ?? "").toLowerCase();
    console.log(`  poll ${i + 1}: ${status}`);
    if (status === "succeeded") {
      const videoUrl =
        j?.content?.video_url ??
        j?.content?.[0]?.video_url ??
        j?.video_url ??
        "";
      if (!videoUrl) throw new Error(`No video_url in response: ${JSON.stringify(j).slice(0, 300)}`);
      return videoUrl;
    }
    if (status === "failed") {
      throw new Error(`Task failed: ${JSON.stringify(j).slice(0, 300)}`);
    }
  }
  throw new Error("Timed out after ~6 minutes");
}

async function downloadMp4(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  writeFileSync(outPath, Buffer.from(buf));
  console.log(`  saved ${Math.round(buf.byteLength / 1024)} KB → ${outPath}`);
}

async function generateState(state) {
  const outPath = path.join(OUT_DIR, `${state.name}.mp4`);
  if (existsSync(outPath)) {
    console.log(`[skip] ${state.name}.mp4 already exists`);
    return;
  }
  console.log(`\n[gen] ${state.name}`);
  console.log(`  prompt: ${state.prompt.slice(0, 80)}...`);

  const taskId = await submitSeedanceTask(state.prompt, CAT_IMAGE_URL);
  console.log(`  task: ${taskId}`);

  const videoUrl = await pollSeedanceTask(taskId);
  console.log(`  video URL: ${videoUrl.slice(0, 80)}...`);

  await downloadMp4(videoUrl, outPath);
}

// Main: generate all states (sequentially to avoid rate limits)
console.log("=== 猫猫动画生成器 ===");
console.log(`model: ${ARK_VIDEO_MODEL}`);
console.log(`reference: ${CAT_IMAGE_PATH}`);
console.log(`output: ${OUT_DIR}`);
console.log("");

for (const state of STATES) {
  try {
    await generateState(state);
  } catch (err) {
    console.error(`[error] ${state.name}:`, err.message);
  }
}

console.log("\n=== 完成 ===");
