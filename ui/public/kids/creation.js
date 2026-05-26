// Creation room — kid uploads a drawing, chats with the storyboard coach,
// gets 3 storyboard frames, can regenerate any frame, then exports a fake
// MediaRecorder slideshow video.

import { openCameraCapture } from "./camera-capture.js";
import { logEvent } from "./kids-log.js";

const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const cameraInput = $("cameraInput");
const uploadBtn = $("uploadBtn");
const cameraBtn = $("cameraBtn");
const easelArt = $("easelArt");
const easelPlaceholder = $("easelPlaceholder");
const chatWindow = $("chatWindow");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const sendBtn = $("sendBtn");
// 故事板/视频区已从 UI 移除 —— 用 noop 代理让旧逻辑静默失效，避免 null 报错
const _noopFn = function () {
  return _noop;
};
const _noop = new Proxy(_noopFn, {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive) return () => "";
    if (prop === "length") return 0;
    return _noop;
  },
  set() {
    return true;
  },
  apply() {
    return _noop;
  },
});
const generateVideoBtn = $("generateVideoBtn") || _noop;
const finalVideo = $("finalVideo") || _noop;
const videoSection = $("videoSection") || _noop;
const strip = $("storyboardStrip") || _noop;
const clearBtn = $("clearBtn") || _noop;

const STORAGE_KEY = "creation_state_v1";

const state = {
  imageDataUrl: null,
  imageDescription: null,
  messages: [], // { role: "user"|"assistant", content: string }
  frames: [null, null, null], // each: { url, prompt, scene }
  videoUrls: null, // string[] | null
  busy: false,
};

// ----- image compression (for localStorage) -----
// Compress a data URL / http URL to a JPEG data URL at ≤maxSide px and quality q.
function compressImage(src, maxSide = 900, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(src); // fallback: keep original
    img.src = src;
  });
}

// Video URLs are now /api/storyboard/video-file/:taskId/:clip — served from local disk,
// never expire. Plain localStorage is enough; no IndexedDB needed.

// ----- persistence -----
function snapshotOverlay() {
  // 取涂鸦层当前像素，没画过就 null
  try {
    const ov = document.getElementById("canvasOverlay");
    if (!ov || !ov.width || !ov.height) return null;
    const ctx2 = ov.getContext("2d");
    const data = ctx2.getImageData(0, 0, ov.width, ov.height).data;
    let any = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        any = true;
        break;
      }
    }
    if (!any) return null;
    return ov.toDataURL("image/png");
  } catch {
    return null;
  }
}

function snapshotGeneratedSlides() {
  const stage = document.getElementById("easelFrame");
  if (!stage) return [];
  const out = [];
  stage.querySelectorAll('.canvas-slide:not([data-slide="0"])').forEach((s) => {
    const v = s.querySelector("video");
    if (v && v.src) return out.push({ kind: "video", url: v.src });
    const im = s.querySelector("img");
    if (im && im.src) return out.push({ kind: "image", url: im.src });
  });
  return out;
}

function saveState() {
  const toSave = {
    imageDataUrl: state.imageDataUrl,
    imageDescription: state.imageDescription,
    messages: state.messages,
    frames: state.frames,
    videoUrls: state.videoUrls,
    placedStickers: state.placedStickers || [],
    latestGeneratedImageUrl: state.latestGeneratedImageUrl || null,
    overlayDataUrl: snapshotOverlay(),
    generatedSlides: snapshotGeneratedSlides(),
  };
  // localStorage 配额很小（~5 MB），如果太大就降级保存（先丢生成的图，再丢涂鸦）
  const tryWrite = (obj) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  };
  if (tryWrite(toSave)) return;
  console.warn("saveState: 超出 localStorage 配额，丢掉生成的图/视频");
  if (tryWrite({ ...toSave, generatedSlides: [], latestGeneratedImageUrl: null })) return;
  console.warn("saveState: 仍超额，丢掉涂鸦层");
  if (
    tryWrite({
      ...toSave,
      generatedSlides: [],
      latestGeneratedImageUrl: null,
      overlayDataUrl: null,
    })
  )
    return;
  console.warn("saveState: 还是超，丢掉原图（最坏情况）");
  tryWrite({
    imageDescription: state.imageDescription,
    messages: state.messages,
    placedStickers: state.placedStickers || [],
  });
}

function clearSavedState() {
  localStorage.removeItem(STORAGE_KEY);
}

function restoreState() {
  let saved;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch (e) {
    return;
  }

  // Restore image on easel
  if (saved.imageDataUrl) {
    state.imageDataUrl = saved.imageDataUrl;
    state.imageDescription = saved.imageDescription || null;
    easelArt.src = saved.imageDataUrl;
    easelArt.hidden = false;
    easelPlaceholder.hidden = true;
    $("easelFrame").classList.add("uploaded", "has-image");

    // 等图片真的加载好（fitOverlay 调过一次后），再恢复涂鸦层和生成的页
    if (
      saved.overlayDataUrl ||
      (Array.isArray(saved.generatedSlides) && saved.generatedSlides.length)
    ) {
      const restoreVisuals = () => {
        // 涂鸦层
        if (saved.overlayDataUrl) {
          const ov = document.getElementById("canvasOverlay");
          const ovImg = new Image();
          ovImg.onload = () => {
            try {
              if (ov && ov.width && ov.height) {
                ov.getContext("2d").drawImage(ovImg, 0, 0, ov.width, ov.height);
              }
            } catch (e) {
              console.warn("[restore] overlay draw failed:", e);
            }
          };
          ovImg.src = saved.overlayDataUrl;
        }
        // 生成的图/视频幻灯（用 setTimeout 让 pushGeneratedSlide 等模块都已就绪）
        setTimeout(() => {
          if (typeof pushGeneratedSlide !== "function") return;
          for (const s of saved.generatedSlides || []) {
            if (s && s.url) pushGeneratedSlide(s.kind, s.url);
          }
          // 默认回到第 0 页（原图），不是最新生成那页
          if (typeof refreshSlideUI === "function") {
            currentSlideIdx = 0;
            refreshSlideUI();
          }
        }, 0);
      };
      // 等 easelArt 触发 load 后再画，否则 overlay 还没 fit 到对应尺寸
      if (easelArt.complete && easelArt.naturalWidth) {
        // 已经加载完了（同步 cache）
        requestAnimationFrame(() => requestAnimationFrame(restoreVisuals));
      } else {
        easelArt.addEventListener(
          "load",
          () => {
            requestAnimationFrame(() => requestAnimationFrame(restoreVisuals));
          },
          { once: true },
        );
      }
    }
  }

  // Restore extras
  if (Array.isArray(saved.placedStickers)) state.placedStickers = saved.placedStickers;
  if (saved.latestGeneratedImageUrl) state.latestGeneratedImageUrl = saved.latestGeneratedImageUrl;

  // Restore chat messages —— 但隐藏系统观察 / 上传提示这种"内部消息"，
  // 它们仍保留在 state.messages 里给蛋蛋看上下文，只是不在屏幕上画
  if (Array.isArray(saved.messages) && saved.messages.length > 0) {
    state.messages = saved.messages;
    chatWindow.innerHTML = "";
    for (const msg of saved.messages) {
      const c = String(msg.content || "");
      const internal =
        msg.role === "user" && (c.startsWith("（前端看到") || c.startsWith("（我刚刚上传"));
      if (internal) continue;
      if (msg.role === "user") {
        pushBubble(msg.content, "kid");
      } else {
        pushBubble(msg.content, "coach");
      }
    }
  }

  // 故事板/视频已从 UI 移除：丢掉这些字段，避免误触发提示
  state.frames = [null, null, null];
  state.videoUrls = null;
}

// ----- chat ui helpers -----
function pushBubble(text, role = "coach") {
  const div = document.createElement("div");
  div.className = "bubble bubble-" + role;
  div.textContent = text;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return div;
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "bubble bubble-typing";
  div.id = "typingBubble";
  div.textContent = "蛋蛋在想... ✨";
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return div;
}

function clearTyping() {
  const t = $("typingBubble");
  if (t) t.remove();
}

function setBusy(b) {
  state.busy = b;
  sendBtn.disabled = b;
  chatInput.disabled = b;
  uploadBtn.disabled = b;
  cameraBtn.disabled = b;
}

// ----- frame ui helpers -----
function getFrameSlot(n) {
  return strip.querySelector(`.frame-slot[data-frame="${n}"]`);
}
function setFrameLoading(n, on) {
  const art = getFrameSlot(n).querySelector(".frame-art");
  art.classList.toggle("loading", on);
  art.classList.remove("error");
}
function setFrameError(n) {
  const art = getFrameSlot(n).querySelector(".frame-art");
  art.classList.remove("loading");
  art.classList.add("error");
}
function setFrameImage(n, url) {
  const slot = getFrameSlot(n);
  const art = slot.querySelector(".frame-art");
  art.classList.remove("loading", "error");
  art.innerHTML = "";
  const img = document.createElement("img");
  img.src = url;
  img.alt = `分镜 ${n}`;
  img.crossOrigin = "anonymous";
  art.appendChild(img);
  // show regenerate button now that there's something to regen
  slot.querySelector(".frame-regen-btn").hidden = false;
}
function allFramesReady() {
  return state.frames.every((f) => f && f.url);
}
function refreshVideoButton() {
  generateVideoBtn.disabled = !allFramesReady() || state.busy;
}

// ----- API -----
async function apiPost(path, payload) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ----- flows -----

async function handleImageDataUrl(dataUrl) {
  // 上传永远先把图显出来，不管蛋蛋有没有在忙
  console.log("[upload] 收到图，长度:", dataUrl ? dataUrl.length : 0);
  state.imageDataUrl = dataUrl;
  easelArt.src = dataUrl;
  easelArt.hidden = false;
  easelPlaceholder.hidden = true;
  $("easelFrame").classList.add("uploaded", "has-image");
  if (state.busy) {
    pushBubble("（图先放上去啦，等蛋蛋回完上一句再聊~）", "system");
    return;
  }

  setBusy(true);
  pushBubble("（蛋蛋在偷偷看你的画…）", "system");
  showTyping();
  try {
    const { description } = await apiPost("/api/storyboard/describe", { image: dataUrl });
    state.imageDescription = description;
    logEvent("creation-painting", { description });
    clearTyping();

    // Compress drawing for localStorage (original stays for API calls this session)
    compressImage(dataUrl, 900, 0.82).then((c) => {
      state.imageDataUrl = c;
    });

    state.messages = [{ role: "user", content: "（我刚刚上传了我的画）" }];
    const { reply } = await apiPost("/api/storyboard/coach", {
      messages: state.messages,
      image_description: description,
    });
    state.messages.push({ role: "assistant", content: reply });
    pushBubble(reply, "coach");
    saveState();
  } catch (err) {
    clearTyping();
    pushBubble("蛋蛋这会儿没看清画...再试一次?(" + err.message + ")", "system");
  } finally {
    setBusy(false);
  }
}

uploadBtn.addEventListener("click", () => fileInput.click());
cameraBtn.addEventListener("click", async () => {
  const dataUrl = await openCameraCapture();
  if (dataUrl) handleImageDataUrl(dataUrl);
});

[fileInput, cameraInput].forEach((inp) => {
  inp.addEventListener("change", () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    console.log(
      "[upload] 选了文件:",
      file.name,
      file.type,
      (file.size / 1024 / 1024).toFixed(2) + "MB",
    );
    if (file.size > 25 * 1024 * 1024) {
      alert("图太大啦（>25MB），蛋蛋抱不动~ 试一张小一点的");
      inp.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => handleImageDataUrl(reader.result);
    reader.onerror = (e) => {
      console.error("[upload] FileReader 出错:", e);
      alert("读取图片失败：" + (reader.error?.message || "未知错误"));
    };
    reader.readAsDataURL(file);
    inp.value = "";
  });
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || state.busy) return;
  chatInput.value = "";
  pushBubble(text, "kid");
  state.messages.push({ role: "user", content: text });

  // 记录是否是孩子第一次说故事（提交前就判断，避免后面乱算）
  const kidCountBefore = realKidMessages().length - 1;

  setBusy(true);
  const typing = showTyping();
  try {
    const res = await apiPost("/api/storyboard/coach", {
      messages: state.messages,
      image_description: state.imageDescription || "",
    });
    clearTyping();
    state.messages.push({ role: "assistant", content: res.reply });
    pushBubble(res.reply, "coach");
    saveState();

    // 孩子第一次说了故事 → 蛋蛋回完自动开始生视频
    if (kidCountBefore === 0) {
      await autoGenerateVideo(text);
    }
  } catch (err) {
    clearTyping();
    pushBubble("蛋蛋愣了一下... 再说一次试试?(" + err.message + ")", "system");
  } finally {
    setBusy(false);
    refreshVideoButton();
  }
});

// ----- regenerate single frame -----
strip.addEventListener("click", async (e) => {
  const btn = e.target.closest(".frame-regen-btn");
  if (!btn || state.busy) return;
  const n = Number(btn.dataset.regen);
  if (!n) return;

  setBusy(true);
  setFrameLoading(n, true);
  pushBubble(`重新画第 ${n} 幕中... ✨`, "system");
  try {
    const existing = state.frames[n - 1];
    if (!existing?.prompt) {
      throw new Error(`第 ${n} 幕还没有 prompt，请先生成分镜`);
    }
    // 直接用原 prompt 重新调 Seedream，无需经过 MiniMax
    const res = await apiPost("/api/storyboard/regen-frame", {
      n,
      prompt: existing.prompt,
      scene: existing.scene || "",
    });
    const f = Array.isArray(res.frames) ? res.frames[0] : null;
    if (f?.url) {
      const compressed = await compressImage(f.url);
      setFrameImage(n, compressed);
      state.frames[n - 1] = { url: compressed, prompt: f.prompt, scene: f.scene };
      pushBubble(`第 ${n} 幕重新画好啦 ✨`, "system");
      saveState();
    } else {
      throw new Error(res.error || "没有返回图片");
    }
  } catch (err) {
    setFrameError(n);
    console.error("[regen] error:", err);
    pushBubble(`重画失败: ${err.message || String(err)}`, "system");
  } finally {
    setBusy(false);
    refreshVideoButton();
  }
});

// ----- clear / new story -----
clearBtn.addEventListener("click", () => {
  if (!confirm("清空这个故事，重新开始？")) return;

  clearSavedState();

  // reset state
  state.imageDataUrl = null;
  state.imageDescription = null;
  state.messages = [];
  state.frames = [null, null, null];
  state.videoUrls = null;
  state.placedStickers = [];

  // 清除生成的幻灯页
  if (typeof stageEl !== "undefined" && stageEl) {
    stageEl.querySelectorAll('.canvas-slide:not([data-slide="0"])').forEach((s) => s.remove());
    currentSlideIdx = 0;
    refreshSlideUI();
  }
  if (typeof hideGenHint === "function") hideGenHint();

  // reset easel
  easelArt.src = "";
  easelArt.hidden = true;
  easelPlaceholder.hidden = false;
  $("easelFrame").classList.remove("uploaded", "has-image");
  // 同步清掉涂鸦层
  if (typeof overlay !== "undefined" && overlay) {
    overlay.hidden = true;
    if (octx && overlay.width && overlay.height)
      octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  // reset chat
  chatWindow.innerHTML = "";
  pushBubble("先上传一张你的画吧,我等不及啦~ 🥚✨", "coach");

  // reset storyboard frames
  for (let n = 1; n <= 3; n++) {
    const slot = getFrameSlot(n);
    const art = slot.querySelector(".frame-art");
    art.classList.remove("loading", "error");
    art.innerHTML = "";
    const labels = ["开场", "中间", "结尾"];
    const span = document.createElement("span");
    span.className = "frame-empty";
    span.textContent = labels[n - 1];
    art.appendChild(span);
    slot.querySelector(".frame-regen-btn").hidden = true;
  }

  // reset video section
  finalVideo.src = "";
  videoSection.hidden = true;
  refreshVideoButton();
});

// ----- Seedance video generation -----
// 顺序播放多段视频的队列
let videoQueue = [];
let videoTotal = 0;

function playNextVideo() {
  if (videoQueue.length > 0) {
    const url = videoQueue.shift();
    const current = videoTotal - videoQueue.length;
    console.log(`[video] playing segment ${current}/${videoTotal}`, url.slice(0, 60));
    finalVideo.src = url;
    finalVideo.play().catch((e) => {
      console.warn("[video] play error, skipping:", e.message);
      playNextVideo(); // 跳过播放失败的段
    });
  }
}

finalVideo.addEventListener("ended", playNextVideo);
finalVideo.addEventListener("error", (e) => {
  console.warn("[video] load error, skipping to next:", finalVideo.error?.message);
  playNextVideo();
});

generateVideoBtn.addEventListener("click", async () => {
  if (state.busy) return;
  if (!allFramesReady()) {
    pushBubble("先和我聊聊这画里的故事吧~ 等故事齐了我再帮你做成视频🎬", "coach");
    return;
  }
  setBusy(true);

  let progressBubble = pushBubble("正在提交视频任务... 🎬", "system");

  try {
    // Step 1: submit task → get taskId immediately (202)
    const submitRes = await apiPost("/api/storyboard/video", {
      frames: state.frames,
      title: state.imageDescription || "小故事",
    });
    const taskId = submitRes.taskId;
    if (!taskId) throw new Error("提交失败，没有返回任务 ID");

    progressBubble.textContent = "任务已提交，正在生成... ⏳ 大概 3-5 分钟";

    // Step 2: poll /api/storyboard/video/:taskId every 5s
    await new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const r = await fetch(`/api/storyboard/video/${taskId}`);
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            clearInterval(interval);
            return reject(new Error(j.error || `poll ${r.status}`));
          }

          const { status, progress, videoUrls, error } = j;
          if (progress) progressBubble.textContent = `生成中: ${progress} ⏳`;

          if (status === "done") {
            clearInterval(interval);
            resolve(videoUrls);
          } else if (status === "error") {
            clearInterval(interval);
            reject(new Error(error || "视频生成失败"));
          }
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 5000);
    }).then((urls) => {
      if (!urls || urls.length === 0) throw new Error("没有返回视频链接");

      progressBubble.textContent = `视频做好啦！共 ${urls.length} 段自动连播 ✨`;
      state.videoUrls = urls;
      saveState();
      logEvent("creation-video", { segments: urls.length });

      // 播放第一段，剩余段入队
      videoTotal = urls.length;
      videoQueue = urls.slice(1);
      videoSection.hidden = false;
      // scroll the game-shell (the overflow-y: auto container) down to show video
      setTimeout(() => videoSection.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
      finalVideo.src = urls[0];
      console.log(`[video] starting ${urls.length} segments, first:`, urls[0].slice(0, 60));
      finalVideo.play().catch((e) => {
        console.warn("[video] first segment play error:", e.message);
        playNextVideo();
      });
    });
  } catch (err) {
    if (progressBubble) progressBubble.textContent = "视频生成失败: " + err.message;
    else pushBubble("视频生成失败: " + err.message, "system");
  } finally {
    setBusy(false);
  }
});

// ----- ESC key → back to home -----
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !state.busy) {
    history.length > 1 ? history.back() : (location.href = "index.html");
  }
});

// ----- bootstrap -----
// Try to restore from localStorage first; fall back to fresh greeting
const hadSaved = !!localStorage.getItem(STORAGE_KEY);
if (hadSaved) {
  restoreState();
} else {
  pushBubble("先上传一张你的画吧,我等不及啦~ 🥚✨", "coach");
}

// ============================================================
// v2: 蛋蛋伙伴头像（同步首页等级）/ 涂鸦贴纸 / 语音输入
// ============================================================

// ----- 蛋伙伴：和首页 home.js 用同一份阶段表 + 同一个 localStorage key -----
const CAT_STAGES = [
  { lv: 1, xpStart: 0, img: "assets/cat/stages/1-egg.png", name: "猫猫蛋" },
  { lv: 5, xpStart: 10, img: "assets/cat/stages/2-hatchling.png", name: "破壳幼崽" },
  { lv: 10, xpStart: 30, img: "assets/cat/stages/3-kitten.png", name: "小奶猫" },
  { lv: 25, xpStart: 80, img: "assets/cat/stages/4-adult.png", name: "成年猫" },
  { lv: 50, xpStart: 200, img: "assets/cat/stages/5-star.png", name: "星辰猫" },
];
function loadStage() {
  const xp = parseInt(localStorage.getItem("kids.cat.xp") || "0", 10) || 0;
  for (let i = CAT_STAGES.length - 1; i >= 0; i--) {
    if (xp >= CAT_STAGES[i].xpStart) return CAT_STAGES[i];
  }
  return CAT_STAGES[0];
}
function renderCoach() {
  const s = loadStage();
  const a = document.getElementById("coachAvatar");
  const n = document.getElementById("coachName");
  if (a && a.dataset.stage !== s.img) {
    a.dataset.stage = s.img;
    a.src = s.img;
  }
  if (n) n.textContent = s.name;
}
renderCoach();
window.addEventListener("storage", (e) => {
  if (e.key === "kids.cat.xp") renderCoach();
});

// ----- 涂鸦 / 贴纸 编辑层 -----
const overlay = document.getElementById("canvasOverlay");
const editToolbar = document.getElementById("editToolbar");
let octx = overlay ? overlay.getContext("2d") : null;
let drawing = false;
let currentTool = "brush"; // "brush" | "eraser" | "sticker"
let currentColor = "#1a1a1a";
let pendingSticker = null;
let snapshots = []; // undo 栈

function fitOverlay() {
  if (!overlay || !octx || easelArt.hidden) return;
  const ir = easelArt.getBoundingClientRect();
  const sr = document.getElementById("easelFrame").getBoundingClientRect();
  const w = Math.max(1, Math.round(ir.width));
  const h = Math.max(1, Math.round(ir.height));
  overlay.style.width = w + "px";
  overlay.style.height = h + "px";
  overlay.style.left = ir.left - sr.left + "px";
  overlay.style.top = ir.top - sr.top + "px";
  if (overlay.width !== w || overlay.height !== h) {
    // 保留已有涂鸦
    const tmp = document.createElement("canvas");
    tmp.width = overlay.width || 1;
    tmp.height = overlay.height || 1;
    if (overlay.width > 0 && overlay.height > 0) tmp.getContext("2d").drawImage(overlay, 0, 0);
    overlay.width = w;
    overlay.height = h;
    octx.drawImage(tmp, 0, 0, w, h);
  }
}
easelArt.addEventListener("load", () => {
  if (!overlay) return;
  overlay.hidden = false;
  // 等图片完成布局
  requestAnimationFrame(fitOverlay);
  if (editToolbar) editToolbar.dataset.disabled = "false";
});
window.addEventListener("resize", fitOverlay);

function localPoint(e) {
  const r = overlay.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (overlay.width / r.width),
    y: (e.clientY - r.top) * (overlay.height / r.height),
  };
}
function pushSnapshot() {
  if (!octx || !overlay.width || !overlay.height) return;
  try {
    snapshots.push(octx.getImageData(0, 0, overlay.width, overlay.height));
    if (snapshots.length > 30) snapshots.shift();
  } catch {}
}

if (overlay) {
  overlay.addEventListener("pointerdown", (e) => {
    if (currentTool === "sticker") {
      // 贴纸：单击放置
      if (!pendingSticker) return;
      pushSnapshot();
      const p = localPoint(e);
      octx.font = "48px serif";
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.globalCompositeOperation = "source-over";
      octx.fillText(pendingSticker, p.x, p.y);
      return;
    }
    drawing = true;
    pushSnapshot();
    overlay.setPointerCapture(e.pointerId);
    octx.beginPath();
    octx.lineCap = "round";
    octx.lineJoin = "round";
    if (currentTool === "eraser") {
      octx.globalCompositeOperation = "destination-out";
      octx.lineWidth = currentBrushSize * 4; // 橡皮比画笔粗
    } else {
      octx.globalCompositeOperation = "source-over";
      octx.strokeStyle = currentColor;
      octx.lineWidth = currentBrushSize;
    }
    const p = localPoint(e);
    octx.moveTo(p.x, p.y);
    octx.lineTo(p.x + 0.01, p.y + 0.01);
    octx.stroke();
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = localPoint(e);
    octx.lineTo(p.x, p.y);
    octx.stroke();
  });
  const stop = () => {
    if (drawing) {
      drawing = false;
      // 一笔结束就持久化（debounce 简单实现）
      clearTimeout(stop._t);
      stop._t = setTimeout(saveState, 400);
    }
  };
  overlay.addEventListener("pointerup", stop);
  overlay.addEventListener("pointercancel", stop);
  overlay.addEventListener("pointerleave", stop);
}

function handleBrushToolClick(e) {
  const t = e.target.closest("button");
  if (!t) return;
  const root = t.closest(".sidebar-brush, .edit-toolbar") || document;

  if (t.dataset.sticker) {
    pendingSticker = t.dataset.sticker;
    pendingStickerImg = null;
    currentTool = "sticker";
    root.querySelectorAll(".tool-btn,.swatch").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    if (overlay) overlay.style.cursor = "copy";
    return;
  }
  if (t.dataset.tool) {
    currentTool = t.dataset.tool;
    pendingSticker = null;
    pendingStickerImg = null;
    root.querySelectorAll(".tool-btn, .big-tool-btn").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    // 离开 sticker 模式时，清掉素材库的高亮
    const grid = document.getElementById("assetGrid");
    if (grid) grid.querySelectorAll(".asset-cell").forEach((c) => c.classList.remove("active"));
    if (overlay) overlay.style.cursor = currentTool === "eraser" ? "cell" : "crosshair";
    return;
  }
  if (t.dataset.color) {
    currentColor = t.dataset.color;
    root.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
    t.classList.add("active");
    if (currentTool !== "brush") {
      currentTool = "brush";
      pendingSticker = null;
      pendingStickerImg = null;
      const brushBtn = root.querySelector('[data-tool="brush"]');
      root
        .querySelectorAll("[data-tool],[data-sticker]")
        .forEach((b) => b.classList.remove("active"));
      if (brushBtn) brushBtn.classList.add("active");
      if (overlay) overlay.style.cursor = "crosshair";
    }
    return;
  }
  if (t.id === "undoBtn") {
    const last = snapshots.pop();
    if (last && octx) octx.putImageData(last, 0, 0);
    return;
  }
  if (t.id === "clearOverlayBtn") {
    pushSnapshot();
    if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
    return;
  }
}

const _panelBrush = document.getElementById("panelBrush");
if (_panelBrush) _panelBrush.addEventListener("click", handleBrushToolClick);

// ----- 语音输入（MediaRecorder 录音 → 后端转给 MiniMax ASR） -----
const micBtn = document.getElementById("micBtn");
let micRec = null;

if (micBtn && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
  micBtn.addEventListener("click", () => {
    if (micRec) {
      try {
        micRec.recorder.stop();
      } catch {}
    } else {
      startMicRec();
    }
  });
} else if (micBtn) {
  micBtn.disabled = true;
  micBtn.title = "当前浏览器不支持麦克风录音";
}

async function startMicRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const baseValue = chatInput.value;
    const startTs = Date.now();

    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) chunks.push(e.data);
    });
    recorder.addEventListener("stop", async () => {
      micBtn.classList.remove("recording");
      micBtn.title = "语音输入";
      micRec = null;
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {}
      }
      const usedMime = recorder.mimeType || mime || "audio/webm";
      const blob = new Blob(chunks, { type: usedMime });
      const durMs = Date.now() - startTs;
      console.log("[mic] 录音结束，大小", blob.size, "bytes，时长", durMs, "ms，mime=", usedMime);
      // 调试：localStorage.kidsMicDebug = "1" 时把刚录的音频本地播一遍 + 给一个下载链接
      if (localStorage.getItem("kidsMicDebug") === "1") {
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        a.play().catch(() => {});
        console.log("[mic][debug] 录音 URL（右键另存为 .webm）:", url);
      }
      if (durMs < 500) {
        console.warn("[mic] 录音太短（不到 0.5 秒），按住麦克风再说一次");
        chatInput.placeholder = "录音太短，多说几个字～";
        setTimeout(() => {
          chatInput.placeholder = "说点什么，或按右边话筒用嘴巴说…";
        }, 2500);
        return;
      }

      micBtn.classList.add("transcribing");
      micBtn.title = "识别中…";
      try {
        const r = await fetch("/api/creation/stt", {
          method: "POST",
          headers: { "content-type": usedMime },
          body: blob,
        });
        const data = await r.json();
        if (!r.ok) {
          console.warn("[mic] STT error:", data);
          chatInput.placeholder = "识别失败，再试一次…";
          setTimeout(() => {
            chatInput.placeholder = "说点什么，或按右边话筒用嘴巴说…";
          }, 2500);
        } else if (data.text) {
          chatInput.value = (baseValue ? baseValue + " " : "") + data.text;
          chatInput.focus();
        } else {
          console.warn("[mic] STT 返回空文本", data);
          chatInput.placeholder = "没听清，靠近麦克风再说一次～";
          setTimeout(() => {
            chatInput.placeholder = "说点什么，或按右边话筒用嘴巴说…";
          }, 2500);
        }
      } catch (err) {
        console.warn("[mic] STT 请求失败:", err);
      } finally {
        micBtn.classList.remove("transcribing");
        micBtn.title = "语音输入";
      }
    });

    recorder.start(250); // 250ms 一次 dataavailable，保证 webm 容器有完整数据
    micRec = { recorder, stream };
    micBtn.classList.add("recording");
    micBtn.title = "正在录音… 再点一下停止";
  } catch (err) {
    console.warn("[mic] start failed:", err);
    micBtn.classList.remove("recording");
    micRec = null;
  }
}

// 留着下面这两个 helper 兼容其他地方（生图等可能 import）
function resampleFloat32(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.round(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0,
      c = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      c++;
    }
    out[i] = c ? sum / c : 0;
  }
  return out;
}

function float32ToRawBase64(f32) {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let str = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    str += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(str);
}

// ============================================================
// v3: 左侧 sidebar (素材库/画笔) + 主毛玻璃按钮 (生视频/生图/清空)
// ============================================================

// ----- tab 切换 -----
const sidebarTabs = document.querySelectorAll(".sidebar-tab");
const sidebarPanels = {
  assets: document.getElementById("panelAssets"),
  brush: document.getElementById("panelBrush"),
};
sidebarTabs.forEach((t) => {
  t.addEventListener("click", () => {
    const panel = t.dataset.panel;
    sidebarTabs.forEach((b) => {
      const active = b === t;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    Object.entries(sidebarPanels).forEach(([k, el]) => {
      if (!el) return;
      const show = k === panel;
      el.hidden = !show;
      el.classList.toggle("active", show);
    });
  });
});

// ----- 素材库：食物 + 物品（manifest 驱动） -----
const STICKER_CATEGORIES = {
  foods: { dir: "assets/ui/stickers/foods", list: [] },
  items: { dir: "assets/ui/stickers/items", list: [] },
};
let currentCategory = "foods";
let pendingStickerImg = null;
const stickerImgCache = new Map();

function getStickerImage(category, filename) {
  const key = `${category}/${filename}`;
  if (stickerImgCache.has(key)) return stickerImgCache.get(key);
  const img = new Image();
  img.src = `${STICKER_CATEGORIES[category].dir}/${filename}`;
  stickerImgCache.set(key, img);
  return img;
}

const assetGrid = document.getElementById("assetGrid");

function renderAssetGrid(cat) {
  if (!assetGrid) return;
  assetGrid.innerHTML = "";
  const { dir, list } = STICKER_CATEGORIES[cat] || {};
  if (!list || list.length === 0) {
    assetGrid.innerHTML =
      '<div style="grid-column:1/-1;color:rgba(255,248,231,0.5);text-align:center;padding:20px;font-size:13px;">加载中…</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of list) {
    const cell = document.createElement("button");
    cell.className = "asset-cell";
    cell.type = "button";
    cell.title = f
      .replace(/^\d+_/, "")
      .replace(/\.png$/, "")
      .replace(/_/g, " ");
    const im = document.createElement("img");
    im.src = `${dir}/${f}`;
    im.alt = "";
    im.loading = "lazy";
    cell.appendChild(im);
    cell.addEventListener("click", () => {
      assetGrid.querySelectorAll(".asset-cell").forEach((c) => c.classList.remove("active"));
      cell.classList.add("active");
      currentTool = "sticker";
      pendingStickerImg = getStickerImage(cat, f);
      pendingSticker = null;
      if (overlay) overlay.style.cursor = "copy";
      if (editToolbar) editToolbar.dataset.disabled = "false";
    });
    frag.appendChild(cell);
  }
  assetGrid.appendChild(frag);
}

// 拉取 manifest，然后渲染默认（foods）
fetch("assets/ui/stickers/manifest.json")
  .then((r) => r.json())
  .then((m) => {
    STICKER_CATEGORIES.foods.list = Array.isArray(m.foods) ? m.foods : [];
    STICKER_CATEGORIES.items.list = Array.isArray(m.items) ? m.items : [];
    renderAssetGrid(currentCategory);
  })
  .catch((err) => console.warn("[stickers] manifest load failed:", err));

// 子 tab 切换（食物 / 物品）
document.querySelectorAll(".asset-subtab").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".asset-subtab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    currentCategory = b.dataset.cat;
    renderAssetGrid(currentCategory);
  });
});

// ----- 把 emoji 贴纸的旧落点逻辑改为：优先 drawImage(食物 PNG) -----
if (overlay) {
  overlay.addEventListener(
    "pointerdown",
    (e) => {
      if (currentTool !== "sticker" || !pendingStickerImg) return;
      if (!pendingStickerImg.complete) return;
      pushSnapshot();
      const p = localPoint(e);
      const baseSize = Math.max(48, Math.min(overlay.width, overlay.height) * 0.12);
      const ratio =
        pendingStickerImg.naturalWidth && pendingStickerImg.naturalHeight
          ? pendingStickerImg.naturalWidth / pendingStickerImg.naturalHeight
          : 1;
      const w = ratio >= 1 ? baseSize : baseSize * ratio;
      const h = ratio >= 1 ? baseSize / ratio : baseSize;
      octx.globalCompositeOperation = "source-over";
      octx.imageSmoothingEnabled = false;
      octx.drawImage(pendingStickerImg, p.x - w / 2, p.y - h / 2, w, h);
    },
    true,
  ); // capture: 抢在原 sticker handler 之前处理图像贴纸
}

// ----- 生图 按钮（占位：让蛋蛋接话） -----
const genImageBtn = document.getElementById("generateImageBtn");
if (genImageBtn) {
  genImageBtn.addEventListener("click", () => {
    if (state.busy) return;
    pushBubble("好呀好呀！告诉我你想画什么，我来帮你变出来 ✨", "coach");
    chatInput.focus();
  });
}

// ----- 36 色圆形色板 -----
const COLOR_PALETTE_36 = [
  // 黑灰白（含一档暖米）
  "#000000",
  "#404040",
  "#7a7a7a",
  "#b8b8b8",
  "#ffffff",
  "#f5deb3",
  // 红 / 粉
  "#b71c1c",
  "#e53935",
  "#ff7043",
  "#ff9aa2",
  "#ffc1cc",
  "#ffe1ee",
  // 橙 / 黄
  "#e65100",
  "#fb8c00",
  "#ffb74d",
  "#ffd54f",
  "#fff176",
  "#fff9c4",
  // 绿
  "#1b5e20",
  "#43a047",
  "#66bb6a",
  "#a5d6a7",
  "#c5e1a5",
  "#dcedc8",
  // 蓝 / 青
  "#0d47a1",
  "#1e88e5",
  "#42a5f5",
  "#90caf9",
  "#80deea",
  "#b2ebf2",
  // 紫 / 棕
  "#4a148c",
  "#8e24aa",
  "#ab47bc",
  "#ce93d8",
  "#8d6e63",
  "#5d4037",
];

const colorGrid = document.getElementById("colorGrid");
if (colorGrid) {
  COLOR_PALETTE_36.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (c === "#000000" ? " active" : "");
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute("aria-label", `颜色 ${c}`);
    colorGrid.appendChild(b);
  });
  // 默认色 → 黑色
  currentColor = "#000000";
}

// ----- 画笔粗细 -----
let currentBrushSize = 5;
const sizeRow = document.getElementById("sizeRow");
if (sizeRow) {
  sizeRow.addEventListener("click", (e) => {
    const b = e.target.closest(".size-btn");
    if (!b) return;
    sizeRow.querySelectorAll(".size-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    currentBrushSize = parseInt(b.dataset.size, 10) || 5;
  });
}

// ============================================================
// 蛋蛋"看得见"：孩子贴东西/画东西时，节流后偷偷推一条系统观察给蛋蛋
// ============================================================
let _actionBuf = [];
let _actionTimer = null;

function noteAction(desc) {
  _actionBuf.push(desc);
  if (_actionTimer) clearTimeout(_actionTimer);
  _actionTimer = setTimeout(flushActions, 4500);
}

async function flushActions() {
  _actionTimer = null;
  if (_actionBuf.length === 0) return;
  // 蛋蛋正在回话 / 孩子正在打字：不丢，过 2 秒再试
  if (state.busy || (chatInput && document.activeElement === chatInput && chatInput.value.trim())) {
    _actionTimer = setTimeout(flushActions, 2000);
    return;
  }
  const observed = _actionBuf.join("，");
  _actionBuf = [];

  // 用括号包起来作为"前端观察"，让蛋蛋明白这不是孩子说的话
  const observation = `（前端看到：孩子刚刚${observed}。请你像看到了一样，自然地接一两句话。）`;
  state.messages.push({ role: "user", content: observation });

  setBusy(true);
  const typing = showTyping();
  try {
    const res = await apiPost("/api/storyboard/coach", {
      messages: state.messages,
      image_description: state.imageDescription || "",
    });
    clearTyping();
    state.messages.push({ role: "assistant", content: res.reply });
    pushBubble(res.reply, "coach");
    saveState();
  } catch (err) {
    clearTyping();
    console.warn("[noteAction]", err);
  } finally {
    setBusy(false);
  }
}

// 把贴纸名字简化成蛋蛋能用的人话
function describeStickerFile(category, filename) {
  const stem = filename
    .replace(/^\d+_/, "")
    .replace(/\.png$/, "")
    .replace(/_/g, " ")
    .trim();
  if (category === "foods") return `把"${stem}"贴到了画上`;
  return `贴了一个小东西（${stem}）`;
}

// 把贴纸 click 接到 noteAction —— 因为原本 click 已经 set sticker mode，
// 真正"贴下去"是在画板 pointerdown 时发生。我们在贴下后再上报。
// 记录孩子贴在画上的素材（按时间顺序，重复贴算多次）
state.placedStickers = state.placedStickers || [];

if (overlay) {
  overlay.addEventListener(
    "pointerdown",
    (e) => {
      if (currentTool !== "sticker" || !pendingStickerImg) return;
      if (!pendingStickerImg.complete) return;
      const src = pendingStickerImg.src || "";
      const m = src.match(/stickers\/(foods|items)\/([^/?#]+)/);
      if (!m) return;
      const cat = m[1];
      const file = decodeURIComponent(m[2]);
      const niceName = file
        .replace(/^\d+_/, "")
        .replace(/\.png$/, "")
        .replace(/_/g, " ")
        .trim();
      state.placedStickers.push({ category: cat, file, name: niceName, t: Date.now() });
      noteAction(describeStickerFile(cat, file));
      // 短延迟后保存（让 overlay 绘制完成）
      setTimeout(saveState, 100);
    },
    true,
  );
}

// ============================================================
// 第 4 步：生图 / 生视频 —— 拼贴 + 聊天 → AI 重画 / 拍成动画
// ============================================================

// 把当前画板（图 + overlay 的涂鸦+贴纸）合成成一张 PNG dataURL
function compositeCanvas() {
  if (!easelArt || easelArt.hidden || !easelArt.naturalWidth) return null;
  const w = easelArt.naturalWidth;
  const h = easelArt.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d");
  cx.drawImage(easelArt, 0, 0, w, h);
  if (overlay && !overlay.hidden && overlay.width > 0 && overlay.height > 0) {
    cx.drawImage(overlay, 0, 0, w, h);
  }
  return c.toDataURL("image/png");
}

// ---- 画板幻灯片：原图 + 生成的图，可左右翻 ----
const stageEl = document.getElementById("easelFrame");
const slidePrev = document.getElementById("slidePrev");
const slideNext = document.getElementById("slideNext");
const slideDots = document.getElementById("slideDots");
let currentSlideIdx = 0;
let totalSlides = 1; // 第 0 页是原图

function refreshSlideUI() {
  const slides = stageEl.querySelectorAll(".canvas-slide");
  totalSlides = slides.length;
  slides.forEach((s, i) => s.classList.toggle("active", i === currentSlideIdx));

  // 翻页按钮 / 页码点 仅在多于一张时显示
  const multi = totalSlides > 1;
  if (slidePrev) {
    slidePrev.hidden = !multi;
    slidePrev.disabled = currentSlideIdx === 0;
  }
  if (slideNext) {
    slideNext.hidden = !multi;
    slideNext.disabled = currentSlideIdx === totalSlides - 1;
  }
  if (slideDots) {
    slideDots.hidden = !multi;
    slideDots.innerHTML = "";
    for (let i = 0; i < totalSlides; i++) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "canvas-dot" + (i === currentSlideIdx ? " active" : "");
      dot.setAttribute("aria-label", `第 ${i + 1} 张`);
      dot.addEventListener("click", () => {
        currentSlideIdx = i;
        refreshSlideUI();
      });
      slideDots.appendChild(dot);
    }
  }
}
function gotoSlide(delta) {
  currentSlideIdx = Math.max(0, Math.min(totalSlides - 1, currentSlideIdx + delta));
  refreshSlideUI();
}
if (slidePrev) slidePrev.addEventListener("click", () => gotoSlide(-1));
if (slideNext) slideNext.addEventListener("click", () => gotoSlide(1));

// 加一张生成结果到幻灯（图 / 视频通用）
function pushGeneratedSlide(kind, url) {
  const slide = document.createElement("div");
  slide.className = "canvas-slide";
  slide.dataset.slide = String(stageEl.querySelectorAll(".canvas-slide").length);
  if (kind === "image") {
    const im = document.createElement("img");
    im.src = url;
    im.alt = "蛋蛋画的";
    slide.appendChild(im);
  } else {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    v.autoplay = true;
    slide.appendChild(v);
  }
  // 插在 nav/dots 之前
  const beforeEl = stageEl.querySelector(".canvas-nav, .canvas-dots, .gen-hint");
  if (beforeEl) stageEl.insertBefore(slide, beforeEl);
  else stageEl.appendChild(slide);

  // 自动跳到新一页
  currentSlideIdx = stageEl.querySelectorAll(".canvas-slide").length - 1;
  refreshSlideUI();
}

// 轻量行内提示（替代弹窗）
let _hintEl = null;
function showGenHint(text) {
  if (!_hintEl) {
    _hintEl = document.createElement("div");
    _hintEl.className = "gen-hint";
    stageEl.appendChild(_hintEl);
  }
  _hintEl.textContent = text;
  _hintEl.hidden = false;
}
function setGenHint(text) {
  if (_hintEl) _hintEl.textContent = text;
}
function hideGenHint() {
  if (_hintEl) _hintEl.hidden = true;
}

// ----- 生图 按钮 -----
const _genImageBtn = document.getElementById("generateImageBtn");
if (_genImageBtn) {
  // 移除前面占位的 click（如果还在）
  const cloned = _genImageBtn.cloneNode(true);
  _genImageBtn.parentNode.replaceChild(cloned, _genImageBtn);
  cloned.addEventListener("click", async () => {
    if (state.busy) return;
    const png = compositeCanvas();
    if (!png) {
      pushBubble("先放一张你的画上来吧~ 我才好画给你看 ✨", "coach");
      return;
    }
    setBusy(true);
    showGenHint("蛋蛋正在画…");
    pushBubble("好嘞~ 我去画啦！等等我哦 🎨", "coach");
    try {
      const res = await apiPost("/api/creation/generate-image", {
        canvasPng: png,
        messages: state.messages,
        imageDescription: state.imageDescription || "",
        placedStickers: state.placedStickers || [],
      });
      if (!res.url) throw new Error("没有返回图");
      state.latestGeneratedImageUrl = res.url; // 给生视频默认用最新的图
      pushGeneratedSlide("image", res.url);
      hideGenHint();
      pushBubble("画好啦！你看 ✨ （箭头可以翻回原图）", "coach");
      logEvent("creation-image", { prompt: (res.prompt || "").slice(0, 200) });
      saveState();
    } catch (err) {
      console.error("[gen-image]", err);
      hideGenHint();
      pushBubble("我画到一半笔掉啦…再试一次?(" + (err.message || "?") + ")", "system");
    } finally {
      setBusy(false);
    }
  });
}

// ----- 生视频 按钮 -----
// 把原 storyboard 视频按钮的旧逻辑解开 —— 重新接到新的 /api/creation/generate-video
{
  const oldBtn = document.getElementById("generateVideoBtn");
  if (oldBtn) {
    const cloned = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(cloned, oldBtn);
    cloned.addEventListener("click", async () => {
      if (state.busy) return;

      // 默认用最新生成的图作为视频起点；没有就回退到原始拼贴
      const sourcePng = state.latestGeneratedImageUrl || compositeCanvas();
      if (!sourcePng) {
        pushBubble("先放一张你的画上来吧~ 我才好把它变成会动的故事", "coach");

        return;
      }

      // 故事完整度检查 —— 不够就让蛋蛋引导，不开始拍
      const ready = checkStoryReady();
      if (!ready.ok) {
        pushBubble(ready.askEgg, "coach");
        chatInput?.focus();
        return;
      }

      setBusy(true);
      showGenHint("蛋蛋正在拍…（约 1-3 分钟）");
      pushBubble("好嘞，故事我都听明白啦！我去把它拍成会动的~", "coach");
      try {
        const submit = await apiPost("/api/creation/generate-video", {
          canvasPng: sourcePng,
          messages: state.messages,
          imageDescription: state.imageDescription || "",
          placedStickers: state.placedStickers || [],
        });
        const taskId = submit.taskId;
        if (!taskId) throw new Error("没拿到任务 id");

        // 轮询
        await new Promise((resolve, reject) => {
          const interval = setInterval(async () => {
            try {
              const r = await fetch(`/api/creation/video/${taskId}`);
              const j = await r.json().catch(() => ({}));
              if (!r.ok) {
                clearInterval(interval);
                return reject(new Error(j.error || `poll ${r.status}`));
              }
              if (j.progress) setGenHint(j.progress);
              if (j.status === "done") {
                clearInterval(interval);
                resolve(j.videoUrl);
              } else if (j.status === "error") {
                clearInterval(interval);
                reject(new Error(j.error || "视频生成失败"));
              }
            } catch (e) {
              clearInterval(interval);
              reject(e);
            }
          }, 5000);
        }).then((videoUrl) => {
          pushGeneratedSlide("video", videoUrl);
          hideGenHint();
          pushBubble("拍好啦！快看~ 🎬 （箭头可以翻回原图）", "coach");
          logEvent("creation-video", { url: String(videoUrl).slice(0, 200) });
          saveState();
        });
      } catch (err) {
        console.error("[gen-video]", err);
        hideGenHint();
        pushBubble("我拍到一半摔了一跤…再来一次?(" + (err.message || "?") + ")", "system");
      } finally {
        setBusy(false);
      }
    });
  }
}

// ----- 故事完整度检查（生视频前用）-----
// 数 "真正" 由孩子说的消息（剔除上传提示和前端观察）
function realKidMessages() {
  return (state.messages || []).filter((m) => {
    if (!m || m.role !== "user") return false;
    const c = String(m.content || "").trim();
    if (!c) return false;
    if (c.startsWith("（前端看到")) return false;
    if (c.startsWith("（我刚刚上传")) return false;
    return true;
  });
}

function checkStoryReady() {
  const kid = realKidMessages();

  // 只需要孩子说过一句话就够了
  if (kid.length >= 1) return { ok: true };

  return { ok: false, askEgg: "等等～你还没跟我说这是什么故事呢！\n先告诉我一下吧~" };
}

// 自动生视频（孩子第一次说完故事后触发）
async function autoGenerateVideo(storyText) {
  const sourcePng = state.latestGeneratedImageUrl || compositeCanvas();
  if (!sourcePng) return;

  setBusy(true);
  showGenHint("蛋蛋正在拍…（约 1-3 分钟）");
  try {
    const submit = await apiPost("/api/creation/generate-video", {
      canvasPng: sourcePng,
      messages: state.messages,
      imageDescription: storyText || state.imageDescription || "",
      placedStickers: state.placedStickers || [],
    });
    const taskId = submit.taskId;
    if (!taskId) throw new Error("没拿到任务 id");

    await new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const r = await fetch(`/api/creation/video/${taskId}`);
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            clearInterval(interval);
            return reject(new Error(j.error || `poll ${r.status}`));
          }
          if (j.progress) setGenHint(j.progress);
          if (j.status === "done") {
            clearInterval(interval);
            resolve(j.videoUrl);
          } else if (j.status === "error") {
            clearInterval(interval);
            reject(new Error(j.error || "视频生成失败"));
          }
        } catch (e) {
          clearInterval(interval);
          reject(e);
        }
      }, 5000);
    }).then((videoUrl) => {
      pushGeneratedSlide("video", videoUrl);
      hideGenHint();
      pushBubble("拍好啦！快看~", "coach");
      logEvent("creation-video", { url: String(videoUrl).slice(0, 200) });
      saveState();
    });
  } catch (err) {
    console.error("[auto-gen-video]", err);
    hideGenHint();
    pushBubble("我拍到一半摔了一跤…再来一次?(" + (err.message || "?") + ")", "system");
  } finally {
    setBusy(false);
  }
}
