/**
 * emotion.js — 情绪房间小猫对话
 *
 * 走 storyboard 后端代理，后端再连豆包 Realtime（端到端 S2S）。
 * 浏览器 ↔ wss://<host>/api/emotion/realtime
 *   送：JSON {type:"start"} → 二进制 Int16 PCM 16k mono 20ms 一包
 *   收：JSON 事件（asr/chat/tts_ended/error）+ 二进制 Int16 PCM 24k mono
 */

import { logEvent } from "./kids-log.js";

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const CHUNK_MS = 20;      // 推荐 20ms 一包
const CHUNK_BYTES = INPUT_RATE * CHUNK_MS / 1000 * 2; // 640 字节
const MAX_BUBBLES = 2;
const BUBBLE_LIFE_MS = 6500;
const USER_SPEAK_RMS = 0.008; // 阈值放低，便于触发"在说话"指示

const AVATAR_VIDEOS = {
  idle: "assets/cat/live2d/idle.webm",
  listening: "assets/cat/live2d/listening.webm",
  thinking: "assets/cat/live2d/thinking.webm",
  speaking: "assets/cat/live2d/speaking.webm",
  happy: "assets/cat/live2d/happy.webm",
};

const SYSTEM_ROLE =
  "你叫小喵，是给孩子使用的中文情绪小猫伙伴。" +
  "请用温柔、简短、儿童能听懂的话回答。鼓励孩子表达情绪，但不要问姓名、住址、学校等隐私。" +
  "不要保守秘密，不做医生或心理咨询师。" +
  "遇到危险、受伤、被欺负、强烈难过等话题，请温和提醒孩子找家长一起说。" +
  "\n\n【真心话游戏】\n" +
  "当孩子说想玩真心话、或者小喵觉得适合的时候，进入真心话模式。\n" +
  "核心要求：不能像审问一样直接问，要像两个朋友在玩游戏，让孩子在轻松的氛围里主动说出来。\n" +
  "方法：每个问题都要用间接、好奇、温柔的方式引出，不要一上来就正面问。可以先说一句自己的感受或者铺垫，再把问题带出来。一次只问一个，等孩子说完再往下，孩子说了就顺着聊，聊开了再提下一个。\n" +
  "【关键：如何对待没说开的回答】\n" +
  "孩子说没有，不知道，还好，随便这类模糊回答时，不要马上换话题。要换一个角度再试几次，直到问出来。比如：\n" +
  "- 用具体细节替换抽象问法：「那比如昨天，有没有哪一刻有点不开心？」\n" +
  "- 用猜测引发纠正：「是不是有点不想说？还是真的想不起来～」\n" +
  "- 用自我暴露降低防御：「我有时候也会有点说不清楚自己什么感受……」\n" +
  "- 用不用说全部降低压力：「不用说完整，就说一个词也行。」\n" +
  "每个话题可以温柔地试两到三次，孩子三次都回避或明确说不想聊，才自然地说「没关系，不想说的不用说」然后换下一个话题。\n" +
  "不要因为孩子说了一句短答案就夸完就走，要停在那里多陪一会儿。\n" +
  "\n需要在一次真心话游戏里自然问到的话题（顺序灵活，不要全部问完，够了就停）：\n" +
  "① 六一儿童节最想要什么\n" +
  "   → 引法示例：「哎，六一快到了，你有没有特别想要的东西？不管多贵，说出来让我听听～」\n" +
  "② 如果现在什么都不用做，最想干什么\n" +
  "   → 引法示例：「你有没有想过，如果今天突然放假，又不用写作业，你第一件事会做什么？」\n" +
  "③ 学校有没有让自己不开心的事\n" +
  "   → 引法示例：「学校里……最近有没有什么事让你有点不痛快？哪怕是一点点。」\n" +
  "④ 班上有没有好朋友，有没有让自己不舒服的人\n" +
  "   → 引法示例：「你们班你最喜欢跟谁玩？……那有没有哪个同学，让你觉得有点不自在，或者不太想靠近的？」\n" +
  "⑤ 最近有没有让自己觉得挺厉害的事\n" +
  "   → 引法示例：「最近有没有什么时候，你自己心里偷偷觉得：嗯，这件事我做得还不错？」\n" +
  "⑥ 有没有让自己害怕或者压力很大的事\n" +
  "   → 引法示例：「我问你一个有点难回答的……最近有没有什么事，让你心里有点紧或者有点怕？」\n" +
  "⑦ 对爸爸妈妈或家里，有没有想说但没说出口的话\n" +
  "   → 引法示例：「你有没有什么话，想跟爸爸或者妈妈说，但一直没找到机会说，或者不知道怎么开口？」\n" +
  "⑧ 最近身体上有没有哪里不舒服\n" +
  "   → 引法示例：「最近睡得好吗？有没有哪里不舒服，比如肚子啊头啊，或者就是有点没劲？」\n" +
  "⑨ 有没有一个藏在心里很久的愿望\n" +
  "   → 引法示例：「我想问你一个秘密……你有没有一个愿望，一直放在心里，但从来没跟别人说过的？」\n" +
  "⑩ 最近是开心的时候多，还是不开心的时候多\n" +
  "   → 引法示例：「你自己觉得，最近这段时间，开心的时候多一点，还是有点烦的时候多一点？」\n" +
  "\n" +
  "\n\n【接话游戏】\n" +
  "当孩子说想玩接话游戏、或类似意思时，进入游戏模式。\n" +
  "玩法：小喵说上半句或问一个问题，孩子来接或回答。从题库里随机挑，不要按顺序。说完就等孩子回答，不催。\n" +
  "孩子回答后，小喵温暖地接住，不评对错。\n" +
  "重要：不要急着进下一题。先顺着孩子的回答聊一聊，如果孩子说的有意思或者还没说完，就自然追问一句 \n" +
  "聊开了再问要不要继续，孩子主动要继续时才出下一题。\n" +
  "\n题库——填空款（让孩子说真话）：\n" +
  "- 我最害怕的事情是……\n" +
  "- 我希望爸爸能停止……\n" +
  "- 今天有一件事我没告诉妈妈，是……\n" +
  "- 如果我会魔法，我第一个想变的是……\n" +
  "- 我觉得最不公平的事情是……\n" +
  "- 长大以后，我一定不会……\n" +
  "- 班里有个同学，我其实有点……\n" +
  "- 在学校假装开心的时候，其实是因为……\n" +
  "\n题库——暖场款（先让他笑起来）：\n" +
  "- 你今天的心情是什么颜色的？\n" +
  "- 如果你也能变成一只猫，你最想干嘛？\n" +
  "- 你觉得我们家那只真猫，一天到晚都在想什么？\n" +
  "- 今天学校里，谁的笑话最好笑？\n" +
  "- 六一儿童节你最想要什么？\n" +
  "- 如果你现在没有事情，你最想做什么？\n" +
  "\n题库——中档（开始露出真实想法）：\n" +
  "- 你最讨厌爸爸的哪个习惯？\n" +
  "- 你觉得大人为什么总是看手机？\n" +
  "- 学校里有没有一个同学，你觉得他其实有点可怜？\n" +
  "- 如果你今天可以不写作业，你最想干的第一件事是什么？\n" +
  "- 你有没有什么事，只想告诉我，不想告诉爸爸妈妈？\n" +
  "- 你在学校有没有什么不开心的事情？\n" +
  "\n题库——高分款（炸出真心话）：\n" +
  "- 你觉得自己有什么地方，是爸爸妈妈不知道的？\n" +
  "- 上一次你假装很开心，其实没那么开心，是什么时候？\n" +
  "- 如果你能给爸爸定一条家规，会是什么？\n" +
  "- 你长大以后，最不想变成什么样的大人？\n" +
  "- 你觉得长大是一件好事吗？\n" +
  "\n题库——猫猫蛋专属款（孩子最爱）：\n" +
  "- 你给我起的这个名字，是为什么？\n" +
  "- 如果有一天我突然不在电脑里了，你会想我吗？\n" +
  "- 你觉得我跟咱家那只真猫，谁更聪明？\n" +
  "- 你跟我聊天，跟你跟妈妈聊天，有什么不一样？";

const SPEAKING_STYLE = "可爱、温柔、像绘本里的小猫一样说话。";

const els = {
  catAvatar: document.querySelector("#catCharacter"),
  catPatBtn: document.querySelector("#catPatBtn"),
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  interruptBtn: document.querySelector("#interruptBtn"),
  statusPill: document.querySelector("#statusPill"),
  bubbleLayerCat: document.querySelector("#bubbleLayerCat"),
  bubbleLayerUser: document.querySelector("#bubbleLayerUser"),
  catStage: document.querySelector("#catStage"),
  modeBtn: document.querySelector("#modeBtn"),
  camPip: document.querySelector("#camPip"),
  camPreview: document.querySelector("#camPreview"),
  flipCameraBtn: document.querySelector("#flipCameraBtn"),
};

let state = {
  ws: null,
  mediaStream: null,
  inputContext: null,
  outputContext: null,
  processor: null,
  sourceNode: null,
  active: false,
  pendingBytes: [], // 累积的 16k int16 字节
  pendingLen: 0,
  nextPlaybackTime: 0,
  activeSources: new Set(),
  avatarState: "idle",
  avatarTimer: null,
  userBubble: null,
  currentAssistant: null,
  turnEndTimer: null,
  userStopped: true,
  sessionStartTs: null,
  sessionMessages: [],  // [{role, text, ts}] 本次会话所有消息
  videoMode: false,     // true = 同时开摄像头
  cameraStream: null,   // 独立的摄像头 MediaStream
  facingMode: "user",   // "user" 前置 | "environment" 后置
};

// ===== init =====

function init() {
  setAvatarState("idle", true);
  bindEvents();
  // 豆包 server VAD 自动打断，隐藏打断按钮
  if (els.interruptBtn) els.interruptBtn.style.display = "none";
  // 初始隐藏 camPip；视频模式开启后再 show
  if (els.camPip) els.camPip.hidden = true;
  // 显示模式切换按钮
  if (els.modeBtn) els.modeBtn.style.display = "";
}

function bindEvents() {
  els.startBtn.addEventListener("click", () => start());
  els.stopBtn.addEventListener("click", stop);
  els.interruptBtn.addEventListener("click", interrupt);
  els.catAvatar.addEventListener("click", patCat);
  els.catPatBtn.addEventListener("click", patCat);

  // 模式切换：audio ↔ video
  if (els.modeBtn) {
    els.modeBtn.addEventListener("click", toggleMode);
  }

  // 翻转摄像头
  if (els.flipCameraBtn) {
    els.flipCameraBtn.addEventListener("click", flipCamera);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.active) stop();
      else history.length > 1 ? history.back() : (location.href = "index.html");
    }
  });
}

// ===== video mode =====

async function toggleMode() {
  state.videoMode = !state.videoMode;
  const btn = els.modeBtn;
  if (btn) {
    btn.dataset.mode = state.videoMode ? "video" : "audio";
    btn.querySelector(".mode-label").textContent = state.videoMode ? "视频" : "语音";
  }
  if (state.videoMode) {
    await startCameraStream();
  } else {
    stopCameraStream();
  }
}

async function startCameraStream() {
  try {
    // 先停旧流
    if (state.cameraStream) stopCameraStream();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    state.cameraStream = stream;
    attachCameraToPreview(stream);
  } catch (err) {
    console.warn("[emotion] 摄像头请求失败:", err);
    state.videoMode = false;
    if (els.modeBtn) {
      els.modeBtn.dataset.mode = "audio";
      els.modeBtn.querySelector(".mode-label").textContent = "语音";
    }
    if (els.camPip) els.camPip.hidden = true;
  }
}

function attachCameraToPreview(stream) {
  const video = els.camPreview;
  if (!video) return;
  // Chrome srcObject 黑屏 workaround：
  // 先清空 srcObject，再重新赋值，强制 compositor 重建 GPU 合成层
  video.srcObject = null;
  video.srcObject = stream;
  // 必须显式调用 play()；仅靠 autoplay 属性在 srcObject 赋值后不一定触发
  video.play().catch(() => { });
  if (els.camPip) els.camPip.hidden = false;
  // 镜像：前置翻转，后置不翻
  video.style.transform = state.facingMode === "user" ? "scaleX(-1)" : "scaleX(1)";
}

function stopCameraStream() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => { try { t.stop(); } catch { } });
    state.cameraStream = null;
  }
  const video = els.camPreview;
  if (video) { video.srcObject = null; }
  if (els.camPip) els.camPip.hidden = true;
}

async function flipCamera() {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  if (state.cameraStream) {
    await startCameraStream();
  }
}

function patCat() {
  setTemporaryAvatarState("happy", 1800);
}

// ===== start / stop =====

async function start() {
  state.userStopped = false;
  resetSessionUi();
  setControls(true);
  setStatus("申请麦克风", "wait");
  setAvatarState("thinking");

  try {
    await setupMedia();
    await setupOutputAudio();
    await connectAndStart();
    startAudioPump();
    state.sessionStartTs = Date.now();
    state.sessionMessages = [];
    logEvent("emotion-session-start", { mode: "audio" });
  } catch (err) {
    console.error("[emotion] 启动失败:", err);
    addBubble("system", `启动失败：${err.message || err}`);
    cleanupLocal();
    setControls(false);
    setStatus("启动失败", "error");
    setAvatarState("idle");
  }
}

async function stop() {
  state.userStopped = true;
  if (isWsOpen()) {
    try { state.ws.send(JSON.stringify({ type: "stop" })); } catch { }
  }
  const durationSec = state.sessionStartTs
    ? Math.round((Date.now() - state.sessionStartTs) / 1000)
    : 0;
  if (state.sessionStartTs) {
    logEvent("emotion-session-end", { durationSec });
    // 异步保存聊天记录到 NAS，失败静默忽略
    if (state.sessionMessages.length) {
      fetch("/api/emotion/save-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: state.sessionMessages,
          startTs: state.sessionStartTs,
          durationSec,
        }),
      }).catch(() => { });
    }
    state.sessionStartTs = null;
    state.sessionMessages = [];
  }
  cleanupLocal();
  setControls(false);
  setStatus("已结束", "idle");
  setAvatarState("idle");
}

function interrupt() {
  if (isWsOpen()) {
    try { state.ws.send(JSON.stringify({ type: "interrupt" })); } catch { }
  }
  clearPlayback();
  setAvatarState("listening");
  addBubble("system", "已打断");
}

// ===== media =====

async function setupMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持麦克风采集");
  }
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    throw new Error(`请用 https://${location.hostname} 打开此页面，浏览器才允许使用麦克风`);
  }
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
  } catch (err) {
    const name = err?.name || "";
    if (name === "NotAllowedError") throw new Error("麦克风权限被拒绝");
    if (name === "NotFoundError") throw new Error("没有找到麦克风");
    if (name === "NotReadableError") throw new Error("麦克风被其他应用占用");
    throw err;
  }
}

async function setupOutputAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("当前浏览器不支持 Web Audio");
  state.outputContext = new Ctx();
  await state.outputContext.resume();
  state.nextPlaybackTime = state.outputContext.currentTime;
}

// ===== websocket =====

async function connectAndStart() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/emotion/realtime`;
  setStatus("连接中", "wait");
  state.ws = new WebSocket(url);
  state.ws.binaryType = "arraybuffer";

  await new Promise((res, rej) => {
    state.ws.addEventListener("open", res, { once: true });
    state.ws.addEventListener("error", () => rej(new Error("连不上后端 WS")), { once: true });
  });

  state.ws.send(JSON.stringify({
    type: "start",
    botName: "小喵",
    systemRole: SYSTEM_ROLE,
    speakingStyle: SPEAKING_STYLE,
  }));

  state.ws.addEventListener("message", onMessage);
  state.ws.addEventListener("close", () => {
    if (state.active && !state.userStopped) {
      addBubble("system", "连接已断开");
    }
    state.active = false;
    setStatus("已断开", "error");
  });

  // 等 session_started
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("豆包会话超时")), 15000);
    function once(e) {
      let msg; try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      if (msg?.type === "session_started") {
        clearTimeout(t);
        state.ws.removeEventListener("message", once);
        res();
      } else if (msg?.type === "error") {
        clearTimeout(t);
        state.ws.removeEventListener("message", once);
        rej(new Error(msg.message || msg.payload?.error || "session 失败"));
      }
    }
    state.ws.addEventListener("message", once);
  });

  state.active = true;
  setStatus("实时中", "live");
  setAvatarState("listening");
  els.catStage.dataset.active = "true";
}

function onMessage(ev) {
  // 二进制 = TTS 音频帧（Int16 24k）
  if (ev.data instanceof ArrayBuffer) {
    playPcm24Int16(new Uint8Array(ev.data));
    return;
  }
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }

  switch (msg.type) {
    case "asr_started":
      // 用户开始说话 → 把猫的余响清掉
      clearPlayback();
      setAvatarState("listening");
      break;
    case "asr_partial":
      showUserBubble(msg.text || "");
      break;
    case "asr_final":
      showUserBubble(msg.text || "", true);
      break;
    case "asr_ended":
      setAvatarState("thinking");
      break;
    case "chat_text":
      appendAssistantText(msg.text || "");
      break;
    case "chat_ended":
      finishAssistantTurn();
      break;
    case "tts_sentence_start": {
      // SayHello / ChatTTSText 触发的回复不会发 chat_text，文字在这里
      const txt = msg.payload?.text;
      if (txt && !state.currentAssistant) appendAssistantText(txt);
      break;
    }
    case "tts_ended":
      // 等队列里剩下的音频播完，再切回 happy
      finishAssistantTurn();
      markAssistantTurnEnd();
      break;
    case "error": {
      const reason = msg.message || msg.payload?.error || "unknown";
      console.warn("[emotion] 服务端 error", msg);
      addBubble("system", `出错：${reason}`);
      break;
    }
    case "closed":
      state.active = false;
      break;
  }
}

// ===== audio pump (浏览器 mic → 16k Int16 → ws) =====

function startAudioPump() {
  state.inputContext = new (window.AudioContext || window.webkitAudioContext)();
  state.sourceNode = state.inputContext.createMediaStreamSource(state.mediaStream);
  state.processor = state.inputContext.createScriptProcessor(4096, 1, 1);

  let debugTick = 0;
  state.processor.onaudioprocess = (e) => {
    if (!isWsOpen() || !state.active) return;
    const f32 = e.inputBuffer.getChannelData(0);

    // 用户说话指示（猫不说话时）+ 每 2 秒打印一次音量到 console 帮排查
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    debugTick++;
    if (debugTick % 25 === 0) console.log("[emotion] mic rms:", rms.toFixed(4));
    if (!state.currentAssistant && rms > USER_SPEAK_RMS && !state.userBubble) {
      showUserBubble("…");
    }

    const resampled = resampleFloat32(f32, state.inputContext.sampleRate, INPUT_RATE);
    const i16 = float32ToInt16(resampled);
    appendOutputBytes(new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength));

    while (state.pendingLen >= CHUNK_BYTES) {
      const chunk = takePendingBytes(CHUNK_BYTES);
      state.ws.send(chunk);
    }
  };

  state.sourceNode.connect(state.processor);
  state.processor.connect(state.inputContext.destination);
}

function appendOutputBytes(u8) {
  state.pendingBytes.push(u8);
  state.pendingLen += u8.length;
}

function takePendingBytes(len) {
  const out = new Uint8Array(len);
  let off = 0;
  while (off < len && state.pendingBytes.length) {
    const head = state.pendingBytes[0];
    const need = len - off;
    if (head.length <= need) {
      out.set(head, off);
      off += head.length;
      state.pendingBytes.shift();
      state.pendingLen -= head.length;
    } else {
      out.set(head.subarray(0, need), off);
      state.pendingBytes[0] = head.subarray(need);
      state.pendingLen -= need;
      off += need;
    }
  }
  return out;
}

// ===== audio playback (服务端 24k Int16 → 浏览器扬声器) =====

function playPcm24Int16(u8) {
  if (!state.outputContext) return;
  // 字节对齐到 2
  const usable = Math.floor(u8.byteLength / 2) * 2;
  if (!usable) return;
  const i16 = new Int16Array(u8.buffer, u8.byteOffset, usable / 2);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = state.outputContext.createBuffer(1, f32.length, OUTPUT_RATE);
  buf.copyToChannel(f32, 0);
  const src = state.outputContext.createBufferSource();
  src.buffer = buf;
  src.connect(state.outputContext.destination);
  src.addEventListener("ended", () => state.activeSources.delete(src));
  state.activeSources.add(src);

  setAvatarState("speaking");
  const startAt = Math.max(state.outputContext.currentTime + 0.02, state.nextPlaybackTime);
  src.start(startAt);
  state.nextPlaybackTime = startAt + buf.duration;
  scheduleAvatarFallback((state.nextPlaybackTime - state.outputContext.currentTime) * 1000 + 450);
}

function clearPlayback() {
  for (const s of state.activeSources) { try { s.stop(); } catch { } }
  state.activeSources.clear();
  if (state.outputContext) state.nextPlaybackTime = state.outputContext.currentTime;
}

// ===== cleanup =====

function cleanupLocal() {
  state.active = false;
  state.pendingBytes = [];
  state.pendingLen = 0;
  state.currentAssistant = null;
  state.userBubble = null;
  window.clearTimeout(state.avatarTimer);
  window.clearTimeout(state.turnEndTimer);
  state.avatarTimer = null;
  state.turnEndTimer = null;
  clearPlayback();

  if (state.processor) {
    state.processor.disconnect();
    state.processor.onaudioprocess = null;
  }
  state.sourceNode?.disconnect();
  state.inputContext?.close().catch(() => { });
  state.outputContext?.close().catch(() => { });
  if (state.mediaStream) {
    for (const t of state.mediaStream.getTracks()) { try { t.stop(); } catch { } }
  }
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) {
    try { state.ws.close(); } catch { }
  }

  state.processor = null;
  state.sourceNode = null;
  state.inputContext = null;
  state.outputContext = null;
  state.mediaStream = null;
  state.ws = null;
  // 注意：cleanupLocal 不关摄像头——摄像头随模式生命周期，stop() 时保持视频模式
  if (els.catStage) els.catStage.dataset.active = "false";
}

function resetSessionUi() {
  if (els.bubbleLayerCat) els.bubbleLayerCat.innerHTML = "";
  if (els.bubbleLayerUser) els.bubbleLayerUser.innerHTML = "";
}

// ===== UI helpers =====

function setControls(active) {
  els.startBtn.disabled = active;
  els.stopBtn.disabled = !active;
  els.interruptBtn.disabled = !active;
}

function setStatus(text, kind) {
  if (els.statusPill) {
    els.statusPill.textContent = text;
    els.statusPill.className = `emo-status ${kind}`;
  }
}

function addBubble(role, text) {
  const layer = role === "user" ? els.bubbleLayerUser : els.bubbleLayerCat;
  if (!layer) return null;
  const b = document.createElement("div");
  b.className = `emo-bubble ${role}`;
  b.textContent = text;
  layer.appendChild(b);
  const all = layer.querySelectorAll(".emo-bubble:not(.fading)");
  if (all.length > MAX_BUBBLES) fadeBubble(all[0]);
  return b;
}

function fadeBubble(el) {
  if (!el || el.classList.contains("fading")) return;
  el.classList.add("fading");
  setTimeout(() => el.remove(), 450);
}

function scheduleBubbleFade(el, ms = BUBBLE_LIFE_MS) {
  if (!el) return;
  if (el._fadeTimer) clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => fadeBubble(el), ms);
}

function showUserBubble(text, isFinal = false) {
  if (!state.userBubble) state.userBubble = addBubble("user", "");
  if (state.userBubble) state.userBubble.textContent = text || "…";
  if (isFinal) {
    logEvent("emotion-message", { role: "user", text });
    state.sessionMessages.push({ role: "user", text, ts: Date.now() });
    scheduleBubbleFade(state.userBubble, 1500);
    state.userBubble = null;
  } else {
    scheduleBubbleFade(state.userBubble, 2500);
  }
}

function appendAssistantText(text) {
  if (!text) return;
  if (!state.currentAssistant) {
    if (state.userBubble) { fadeBubble(state.userBubble); state.userBubble = null; }
    state.currentAssistant = addBubble("assistant", "");
  }
  state.currentAssistant.textContent += text;
}

function finishAssistantTurn() {
  if (!state.currentAssistant) return;
  const text = state.currentAssistant.textContent;
  logEvent("emotion-message", { role: "assistant", text });
  state.sessionMessages.push({ role: "assistant", text, ts: Date.now() });
  scheduleBubbleFade(state.currentAssistant);
  state.currentAssistant = null;
}

// ===== avatar state machine =====

function setAvatarState(name, force = false) {
  if (!AVATAR_VIDEOS[name] || !els.catAvatar) return;
  if (!force && state.avatarState === name) return;
  state.avatarState = name;
  if (els.catAvatar.dataset.state !== name) {
    els.catAvatar.dataset.state = name;
    els.catAvatar.src = AVATAR_VIDEOS[name];
    els.catAvatar.load();
  }
  els.catAvatar.play().catch(() => { });
}

function setTemporaryAvatarState(name, holdMs) {
  setAvatarState(name);
  scheduleAvatarFallback(holdMs);
}

function scheduleAvatarFallback(delayMs, fallback) {
  window.clearTimeout(state.avatarTimer);
  state.avatarTimer = setTimeout(() => {
    setAvatarState(fallback || (state.active ? "listening" : "idle"));
  }, Math.max(300, delayMs));
}

function markAssistantTurnEnd() {
  const delayMs = state.outputContext && state.nextPlaybackTime
    ? Math.max(700, (state.nextPlaybackTime - state.outputContext.currentTime) * 1000 + 220)
    : 700;
  window.clearTimeout(state.avatarTimer);
  state.avatarTimer = setTimeout(() => setTemporaryAvatarState("happy", 1400), delayMs);
}

// ===== codec =====

function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}

function resampleFloat32(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const newLen = Math.round(input.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0, c = 0;
    for (let j = start; j < end; j++) { sum += input[j]; c++; }
    out[i] = c ? sum / c : 0;
  }
  return out;
}

function isWsOpen() {
  return state.ws && state.ws.readyState === WebSocket.OPEN;
}

// ===== boot =====
init();
