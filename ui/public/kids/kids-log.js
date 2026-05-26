/**
 * kids-log.js — 共享事件日志（所有孩子端房间用同一份）
 *
 * 用法：
 *   import { logEvent } from "./kids-log.js";
 *   logEvent("emotion-message", { role: "assistant", text: "..." });
 *
 * 存到 localStorage["kids.events"]，容量上限 200 条循环淘汰。
 */

const KEY = "kids.events";
const MAX = 200;

export function logEvent(type, payload = {}) {
  const evt = { ts: Date.now(), type, ...payload };
  let arr = [];
  try {
    arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(arr)) arr = [];
  } catch {}
  arr.push(evt);
  if (arr.length > MAX) arr = arr.slice(-MAX);
  try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch {}

  // 同步到服务端（供微信 bot 查询），失败静默忽略
  fetch("/api/kids/sync-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: evt }),
  }).catch(() => {});

  // 同步更新最近活动时间和计数
  localStorage.setItem("kids.stats.lastActive", String(Date.now()));
  if (type === "emotion-message" && payload.role === "assistant") {
    bumpCount("kids.stats.emotion");
  } else if (type === "math-success") {
    bumpCount("kids.stats.math");
  } else if (type === "creation-video") {
    bumpCount("kids.stats.creation");
  }

  // 完成任务 → 给猫加能量（孩子之后可在主页喂食/玩耍换 XP）
  // 不同事件不同奖励：积小动作，攒大快乐
  const ENERGY_REWARD = {
    "emotion-message":     1,    // 蛋蛋每回一句也给 1（积少成多）
    "emotion-session-end": 5,    // 完整聊一次情绪
    "math-success":        8,    // 数学最优解
    "math-suboptimal":     3,    // 数学完成（非最优）
    "creation-painting":   3,    // 上传一张画
    "creation-story":      6,    // 跟蛋蛋编出一个故事
    "creation-image":      8,    // 生一张 AI 图
    "creation-video":      12,   // 生一段视频
  };
  const reward = ENERGY_REWARD[type];
  if (reward) {
    const cur = parseInt(localStorage.getItem("kids.cat.energy") || "0", 10) || 0;
    localStorage.setItem("kids.cat.energy", String(cur + reward));
  }
}

function bumpCount(key) {
  const n = parseInt(localStorage.getItem(key) || "0", 10) || 0;
  localStorage.setItem(key, String(n + 1));
}

export function loadEvents({ limit = 50, since = 0 } = {}) {
  let arr = [];
  try {
    arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(arr)) arr = [];
  } catch {}
  if (since) arr = arr.filter((e) => e.ts >= since);
  return arr.slice(-limit);
}

export function clearEvents() {
  localStorage.removeItem(KEY);
}

// 模块加载时把 localStorage 全部事件推到服务端（供微信 bot 查询）
// 用 requestIdleCallback 等浏览器空闲再跑，不影响页面启动速度
function _bulkSyncOnLoad() {
  const evts = loadEvents({ limit: 200 });
  if (!evts.length) return;
  fetch("/api/kids/sync-events/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: evts }),
  }).catch(() => {});
}
if (typeof window !== "undefined") {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(_bulkSyncOnLoad);
  } else {
    setTimeout(_bulkSyncOnLoad, 2000);
  }
}
