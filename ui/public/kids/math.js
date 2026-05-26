import { openCameraCapture } from "./camera-capture.js";
/**
 * math.js — 数学岛 · 拍照解题
 *
 * 流程：
 *   1) IDLE: 用户拍照/上传/拖入图片
 *   2) SOLVING: POST 图给 /api/math/solve，建立 SSE 接收 agent 流式输出
 *   3) DONE: 显示最终答案 + 可视化（如 Manim 视频）
 */
import { logEvent } from "./kids-log.js";

const stage = document.getElementById("mathStage");
const idlePane = document.getElementById("idlePane");
const solvePane = document.getElementById("solvePane");
const fileInput = document.getElementById("fileInput");
const cameraInput = document.getElementById("cameraInput");

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "kids.math.lastJob"; // {jobId, image, ts}

let currentJobId = null;
let currentEs = null; // EventSource
const startedAt = { ts: 0 };

function saveLastJob(jobId, dataUrl) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        jobId,
        image: dataUrl,
        ts: Date.now(),
      }),
    );
  } catch {}
}
function loadLastJob() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}
function clearLastJob() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// ===== 进入空闲状态 =====
function setIdle() {
  stage.dataset.state = "idle";
  idlePane.hidden = false;
  solvePane.hidden = true;
  const iframe = $("solveIframe");
  const loading = $("solveLoading");
  if (iframe) {
    iframe.hidden = true;
    iframe.src = "about:blank";
  }
  if (loading) loading.hidden = false;
  closeStream();
}

// ===== 用户提交了图片 =====
async function startSolve(dataUrl) {
  stage.dataset.state = "solving";
  idlePane.hidden = true;
  solvePane.hidden = false;
  $("problemImg").src = dataUrl;
  // 重置加载占位
  $("solveLoading").hidden = false;
  $("solveTitle").textContent = "小喵在看题目…";
  $("solveHint").textContent = "";
  $("solveIframe").hidden = true;
  $("solveIframe").src = "about:blank";
  $("stopBtn").hidden = false;
  startedAt.ts = Date.now();
  // 提交前清掉旧的本地记录，避免刷新错乱
  clearLastJob();

  logEvent("math-photo-submit", { ts: startedAt.ts });

  // 1) 上传图片，拿到 jobId
  let jobId;
  try {
    const r = await fetch("/api/math/solve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    jobId = data.jobId;
    if (!jobId) throw new Error("no jobId");
  } catch (err) {
    showError("无法启动 agent: " + err.message);
    return;
  }
  currentJobId = jobId;
  // 题目图先存上，jobId 后面 solution 事件才能确认成功
  saveLastJob(jobId, dataUrl);

  // 2) 建立 SSE 流接收增量输出
  const es = new EventSource(`/api/math/solve/${jobId}/stream`);
  currentEs = es;

  $("solveTitle").textContent = "小喵在解题…";

  // step / answer 事件忽略：极简 UI 只看视频
  // 但用它们来更新 loading 提示，让用户感觉有进度
  es.addEventListener("step", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const t = (data.text || "").trim();
      if (t)
        $("solveHint").textContent = t.replace(
          /^(题目|第[一二三四五六七八九十0-9]+步)[:：]\s*/,
          "",
        );
    } catch {}
  });

  es.addEventListener("answer", () => {
    $("solveTitle").textContent = "正在渲染动画…";
    $("solveHint").textContent = "马上就好";
  });

  es.addEventListener("viz", (ev) => {
    // viz 仅作 fallback（万一 solution.html 没生成出来）
    const data = JSON.parse(ev.data);
    const iframe = $("solveIframe");
    if (iframe && !iframe.hidden) return; // 已经切到 iframe 模式就不再写 fallback
    // 流式 fallback 暂不渲染图像，避免和 iframe 冲突
  });

  // 解题动画 HTML 准备好 → 切到 iframe，隐藏 loading
  es.addEventListener("solution", (ev) => {
    const data = JSON.parse(ev.data);
    if (!data.url) return;
    $("solveIframe").src = data.url;
    $("solveIframe").hidden = false;
    $("solveLoading").hidden = true;
  });

  es.addEventListener("done", () => {
    stage.dataset.state = "done";
    $("stopBtn").hidden = true;
    es.close();
    currentEs = null;
    logEvent("math-photo-solved", {
      durationSec: Math.round((Date.now() - startedAt.ts) / 1000),
    });
    if (typeof window.parent?.addCatXp === "function") window.parent.addCatXp(8);
    else if (typeof window.addCatXp === "function") window.addCatXp(8);
  });

  es.addEventListener("error-msg", (ev) => {
    const data = JSON.parse(ev.data);
    showError(data.message || "解题出错了");
    es.close();
    currentEs = null;
  });

  es.onerror = () => {
    if (stage.dataset.state === "solving") {
      showError("连接断开了 — 后端 agent 没启动？");
    }
  };
}

function showError(msg) {
  stage.dataset.state = "error";
  $("solveLoading").hidden = false;
  $("solveIframe").hidden = true;
  $("solveTitle").textContent = "❌ 出问题了";
  $("solveHint").textContent = msg;
  $("stopBtn").hidden = true;
}

function closeStream() {
  if (currentEs) {
    currentEs.close();
    currentEs = null;
  }
  if (currentJobId) {
    // 通知后端取消（可选）
    fetch(`/api/math/solve/${currentJobId}/cancel`, { method: "POST" }).catch(() => {});
    currentJobId = null;
  }
}

// ===== 文件 → DataURL =====
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("请选择一张图片");
    return;
  }
  const dataUrl = await readAsDataUrl(file);
  await startSolve(dataUrl);
}

// ===== 事件绑定 =====
$("uploadBtn").addEventListener("click", () => fileInput.click());
$("cameraBtn").addEventListener("click", async () => {
  const dataUrl = await openCameraCapture();
  if (dataUrl) await startSolve(dataUrl);
});

[fileInput, cameraInput].forEach((inp) => {
  inp.addEventListener("change", () => {
    const f = inp.files && inp.files[0];
    if (f) handleFile(f);
    inp.value = "";
  });
});

// 拖拽
idlePane.addEventListener("dragover", (e) => {
  e.preventDefault();
  idlePane.classList.add("dragover");
});
idlePane.addEventListener("dragleave", () => idlePane.classList.remove("dragover"));
idlePane.addEventListener("drop", (e) => {
  e.preventDefault();
  idlePane.classList.remove("dragover");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

$("changeBtn").addEventListener("click", setIdle);
$("stopBtn").addEventListener("click", () => {
  closeStream();
  showError("已停止");
});

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

// 启动：先尝试恢复上次解题；恢复失败才回退到 idle
async function bootstrap() {
  const last = loadLastJob();
  if (!last?.jobId) {
    setIdle();
    return;
  }
  // 探活：solution.html 还在吗？
  try {
    const r = await fetch(`/api/math/solution/${last.jobId}.html`, { method: "HEAD" });
    if (!r.ok) throw new Error("solution gone");
    // 复活：直接跳到 done 状态，左栏复显题目，右栏 iframe 加载
    stage.dataset.state = "done";
    idlePane.hidden = true;
    solvePane.hidden = false;
    $("problemImg").src = last.image || "";
    $("solveLoading").hidden = true;
    $("solveIframe").src = `/api/math/solution/${last.jobId}.html`;
    $("solveIframe").hidden = false;
    $("stopBtn").hidden = true;
  } catch {
    clearLastJob();
    setIdle();
  }
}
bootstrap();
