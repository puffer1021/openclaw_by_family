/**
 * parent.js — 父母端口
 * - PIN 验证
 * - 显示孩子最近活动日志
 * - 跟 AI 聊孩子的事（AI 自动看到孩子的活动）
 */
import { loadEvents } from "./kids-log.js";

const DEFAULT_PIN = "1234";

// ---- 内联 SVG 图标库（统一 24×24 viewBox，stroke 1.8，currentColor）----
const _SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
const ICONS = {
  cat:      _SVG_HEAD + '<path d="M4.5 3.5l3 4.2h9l3-4.2v8.5a7.5 7.5 0 0 1-7.5 7.5h0A7.5 7.5 0 0 1 4.5 12z"/><circle cx="9.5" cy="11.5" r="0.7" fill="currentColor"/><circle cx="14.5" cy="11.5" r="0.7" fill="currentColor"/><path d="M11 14.5h2"/></svg>',
  chat:     _SVG_HEAD + '<path d="M21 12a3 3 0 0 1-3 3H8l-4 4V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"/></svg>',
  heart:    _SVG_HEAD + '<path d="M20.4 4.6a5.5 5.5 0 0 0-7.8 0L12 5.2l-.6-.6a5.5 5.5 0 0 0-7.8 7.8l8.4 8.4 8.4-8.4a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  book:     _SVG_HEAD + '<path d="M3 5a2 2 0 0 1 2-2h6v18H5a2 2 0 0 1-2-2zM21 5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2z"/></svg>',
  graduationCap: _SVG_HEAD + '<path d="M2 9l10-4 10 4-10 4z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/><line x1="22" y1="9" x2="22" y2="15"/></svg>',
  palette:  _SVG_HEAD + '<circle cx="13.5" cy="6.5" r="1" fill="currentColor"/><circle cx="17.5" cy="10.5" r="1" fill="currentColor"/><circle cx="6.5" cy="12.5" r="1" fill="currentColor"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor"/><path d="M12 22a10 10 0 1 1 10-10c0 1.79-1.21 3-3 3h-2a2 2 0 0 0-1 3.75A1.3 1.3 0 0 1 14 22z"/></svg>',
  clock:    _SVG_HEAD + '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  mic:      _SVG_HEAD + '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/></svg>',
  check:    _SVG_HEAD + '<polyline points="4 12 9 17 20 6"/></svg>',
  target:   _SVG_HEAD + '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  thinking: _SVG_HEAD + '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 4"/><circle cx="12" cy="17.5" r="0.7" fill="currentColor"/></svg>',
  cross:    _SVG_HEAD + '<circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>',
  film:     _SVG_HEAD + '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="8" x2="21" y2="8"/><line x1="3" y1="16" x2="21" y2="16"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="16" y2="21"/></svg>',
  list:     _SVG_HEAD + '<line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="0.9" fill="currentColor"/><circle cx="4" cy="12" r="0.9" fill="currentColor"/><circle cx="4" cy="18" r="0.9" fill="currentColor"/></svg>',
  trendUp:  _SVG_HEAD + '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>',
  bulb:     _SVG_HEAD + '<line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M12 2a7 7 0 0 0-4 12.5c1 .8 1.5 1.6 1.5 2.5h5c0-.9.5-1.7 1.5-2.5A7 7 0 0 0 12 2z"/></svg>',
  paw:      _SVG_HEAD + '<circle cx="6" cy="11" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="11" r="2"/><path d="M8 16c0-2 2-3.5 4-3.5s4 1.5 4 3.5-2 5-4 5-4-3-4-5z"/></svg>',
};
function ico(name) {
  const svg = ICONS[name] || ICONS.paw;
  return `<span class="ico">${svg}</span>`;
}
// 把 HTML 里 <span class="ico" data-icon="xxx"></span> 占位符填上真正的 SVG
function hydrateIcons(root = document) {
  root.querySelectorAll(".ico[data-icon]").forEach((el) => {
    const name = el.dataset.icon;
    if (name && ICONS[name]) el.innerHTML = ICONS[name];
  });
}
hydrateIcons();

const CAT_STAGES = [
  { lv: 1,  xpStart: 0,    xpEnd: 10,  img: "assets/cat/stages/1-egg.png",       name: "猫猫蛋"   },
  { lv: 5,  xpStart: 10,   xpEnd: 30,  img: "assets/cat/stages/2-hatchling.png", name: "破壳幼崽" },
  { lv: 10, xpStart: 30,   xpEnd: 80,  img: "assets/cat/stages/3-kitten.png",    name: "小奶猫"   },
  { lv: 25, xpStart: 80,   xpEnd: 200, img: "assets/cat/stages/4-adult.png",     name: "成年猫"   },
  { lv: 50, xpStart: 200,  xpEnd: 999, img: "assets/cat/stages/5-star.png",      name: "星辰猫"   },
];

const $ = (id) => document.getElementById(id);

function getPin()   { return localStorage.getItem("kids.parent.pin") || DEFAULT_PIN; }
function setPin(v)  { localStorage.setItem("kids.parent.pin", v); }
function unlocked() { return sessionStorage.getItem("kids.parent.unlocked") === "1"; }
function unlock()   { sessionStorage.setItem("kids.parent.unlocked", "1"); }
function loadInt(k) { return parseInt(localStorage.getItem(k) || "0", 10) || 0; }

function stageOfXp(xp) {
  for (let i = CAT_STAGES.length - 1; i >= 0; i--) {
    if (xp >= CAT_STAGES[i].xpStart) return CAT_STAGES[i];
  }
  return CAT_STAGES[0];
}

function timeAgo(ts) {
  if (!ts) return "暂无";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// ===== 渲染 =====
function renderOverview() {
  const xp = loadInt("kids.cat.xp");
  const st = stageOfXp(xp);

  $("overviewCatImg").src = st.img;
  $("overviewLevel").textContent = `Lv ${st.lv} ${st.name}`;
  const progress = Math.min(1, (xp - st.xpStart) / Math.max(1, st.xpEnd - st.xpStart));
  $("overviewXpFill").style.width = `${progress * 100}%`;
  $("overviewXpText").textContent = st.lv >= 50 ? `${xp}` : `${xp - st.xpStart}/${st.xpEnd - st.xpStart}`;

  $("statEmotion").textContent  = loadInt("kids.stats.emotion");
  $("statMath").textContent     = loadInt("kids.stats.math");
  $("statCreation").textContent = loadInt("kids.stats.creation");
  $("statLastActive").textContent = timeAgo(loadInt("kids.stats.lastActive"));
}

const EVENT_META = {
  "emotion-message":      { icon: ICONS.heart,    label: (e) => `小猫说：${(e.text || "").slice(0, 40)}${e.text?.length > 40 ? "…" : ""}` },
  "emotion-session-start":{ icon: ICONS.mic,      label: (e) => `开始情绪聊天（${e.mode === "video" ? "看图" : "语音"}模式）` },
  "emotion-session-end":  { icon: ICONS.check,    label: (e) => `结束聊天 · 时长 ${Math.round((e.durationSec || 0) / 60 * 10) / 10} 分钟` },
  "math-success":         { icon: ICONS.target,   label: (e) => `答对：${e.title}（${e.totalMin} 分钟，最优）` },
  "math-suboptimal":      { icon: ICONS.thinking, label: (e) => `${e.title}：完成 ${e.totalMin} 分（最优 ${e.optimal}）` },
  "math-fail":            { icon: ICONS.cross,    label: (e) => `${e.title}：${e.reason || "未通过"}` },
  "creation-painting":    { icon: ICONS.palette,  label: (e) => `上传画作：${(e.description || "").slice(0, 50)}…` },
  "creation-story":       { icon: ICONS.book,     label: (e) => `编出故事（${e.frameCount} 个分镜）` },
  "creation-video":       { icon: ICONS.film,     label: (e) => `生成动画视频（${e.segments} 段）` },
};

function renderEvents() {
  const evts = loadEvents({ limit: 50 });
  const list = $("eventsList");
  if (!evts.length) {
    list.innerHTML = '<div class="events-empty">暂无活动 — 让小朋友先去玩玩</div>';
    return;
  }
  list.innerHTML = "";
  // 倒序显示（最新在上）
  for (let i = evts.length - 1; i >= 0; i--) {
    const e = evts[i];
    const meta = EVENT_META[e.type];
    if (!meta) continue;
    const div = document.createElement("div");
    div.className = "event-item";
    div.innerHTML = `
      <span class="ev-icon">${meta.icon}</span>
      <div class="ev-body">
        <div class="ev-text"></div>
        <div class="ev-time">${new Date(e.ts).toLocaleString("zh-CN", { hour12: false })}</div>
      </div>
    `;
    div.querySelector(".ev-text").textContent = meta.label(e);
    list.appendChild(div);
  }
}

function showDashboard() {
  $("pinOverlay").classList.add("hidden");
  $("parentDash").hidden = false;
  renderOverview();
  renderEvents();
  appendBubble("ai", "我是小喵，能看到小十二最近在家里做的事 — 情绪聊天、数学题、画作。问我什么都行，我会基于事实给你建议。");
  // 把 localStorage 的全部事件同步到服务端，微信 bot 也能查到
  syncEventsToServer();
}

function syncEventsToServer() {
  const evts = loadEvents({ limit: 200 });
  if (!evts.length) return;
  fetch("/api/kids/sync-events/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: evts }),
  }).catch(() => {});
}

// ===== 复制日志 =====
$("copyEventsBtn").addEventListener("click", async () => {
  const evts = loadEvents({ limit: 50 });
  if (!evts.length) { alert("还没有活动记录"); return; }
  const lines = evts.map((e) => {
    const meta = EVENT_META[e.type];
    if (!meta) return null;
    const t = new Date(e.ts).toLocaleString("zh-CN", { hour12: false });
    return `[${t}] ${meta.icon} ${meta.label(e)}`;
  }).filter(Boolean);
  const text = `小十二·活动日志\n\n${lines.join("\n")}`;
  try {
    await navigator.clipboard.writeText(text);
    $("copyEventsBtn").textContent = "✓ 已复制";
    setTimeout(() => { $("copyEventsBtn").textContent = "复制"; }, 1500);
  } catch {
    alert(text); // 复制失败就直接显示
  }
});

// ===== 一键日报 =====
$("dailyReportBtn").addEventListener("click", async () => {
  const btn = $("dailyReportBtn");
  if (btn.disabled) return;

  // 取今天 00:00 起的事件
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayEvts = loadEvents({ limit: 200 }).filter((e) => e.ts >= today.getTime());

  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = "生成中…";

  if (todayEvts.length === 0) {
    appendBubble("ai", "今天还没有活动记录哦~ 让小朋友先去玩玩再来 🐾");
    btn.disabled = false;
    btn.textContent = oldLabel;
    return;
  }

  const dateStr = today.toLocaleDateString("zh-CN");
  const question = `请基于今天（${dateStr}）的活动记录，给我生成一份"今日日报"。\n\n要求：\n1. 简洁易读，分 3-5 段（如：情绪、学习、创造、亮点、建议）。\n2. 用具体例子，不要泛泛。\n3. 末尾给一条今晚或明天可以做的小建议。\n4. 整体语气温和，像跟我聊天。`;

  try {
    await sendChat(question);
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
});

// ===== PIN =====
function tryUnlock() {
  if ($("pinInput").value.trim() === getPin()) {
    unlock();
    showDashboard();
  } else {
    $("pinError").textContent = "密码不对哦";
    document.querySelector(".pin-card").classList.remove("shake");
    void document.querySelector(".pin-card").offsetWidth;
    document.querySelector(".pin-card").classList.add("shake");
    $("pinInput").value = "";
    $("pinInput").focus();
  }
}
$("pinSubmit").addEventListener("click", tryUnlock);
$("pinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });

// ===== 设置按钮 =====
$("changePinBtn").addEventListener("click", () => {
  const cur = prompt("当前密码：");
  if (cur === null) return;
  if (cur !== getPin()) { alert("密码不对"); return; }
  const next = prompt("新密码（4–8 位数字）：");
  if (!next) return;
  if (!/^\d{4,8}$/.test(next)) { alert("必须是 4–8 位数字"); return; }
  setPin(next);
  alert("已更新 ✓");
});

$("resetBtn").addEventListener("click", () => {
  if (!confirm("清零小猫经验和所有学习/活动记录？不可恢复。")) return;
  ["kids.cat.xp", "kids.stats.emotion", "kids.stats.math", "kids.stats.creation",
   "kids.stats.lastActive", "kids.events"].forEach((k) => localStorage.removeItem(k));
  renderOverview();
  renderEvents();
  alert("已重新孵化 🥚");
});

// ===== 端口切换 =====
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.portal === "kid") location.href = "index.html";
  });
});

// ===== AI 聊天 =====
const chatHistory = []; // [{role:"user"|"assistant", content}]
const chatWin = $("chatWindow");

function appendBubble(role, text) {
  const b = document.createElement("div");
  b.className = `bubble ${role}`;
  b.textContent = text;
  chatWin.appendChild(b);
  chatWin.scrollTop = chatWin.scrollHeight;
  return b;
}

async function sendChat(question) {
  if (!question || !question.trim()) return;
  appendBubble("user", question);
  chatHistory.push({ role: "user", content: question });

  const thinking = appendBubble("ai thinking", "（小喵在看孩子的活动…）");
  $("chatInput").disabled = true;

  try {
    const events = loadEvents({ limit: 50 });
    const r = await fetch("/api/parent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events, messages: chatHistory }),
    });
    const data = await r.json();
    thinking.remove();
    if (data.error) {
      appendBubble("error", "出错了：" + data.error);
      chatHistory.pop();
    } else {
      appendBubble("ai", data.reply);
      chatHistory.push({ role: "assistant", content: data.reply });
    }
  } catch (err) {
    thinking.remove();
    appendBubble("error", "网络错误：" + err.message);
    chatHistory.pop();
  } finally {
    $("chatInput").disabled = false;
    $("chatInput").focus();
  }
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("chatInput").value.trim();
  if (!v) return;
  $("chatInput").value = "";
  sendChat(v);
});

document.querySelectorAll(".chip").forEach((c) => {
  c.addEventListener("click", () => sendChat(c.dataset.q));
});

// ===== 启动 =====
if (unlocked()) showDashboard();
else $("pinInput").focus();
