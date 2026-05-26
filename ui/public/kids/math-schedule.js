import { logEvent } from "./kids-log.js";

/**
 * math-schedule.js — 数学岛 · 合理安排时间（甘特图拖拽题）
 *
 * 数据模型：
 *   每题包含 tracks（资源/演员）+ tasks（任务）
 *   每个 task 必须放到指定 needs 的 track 上
 *   tasks 之间有 after 依赖（后置任务必须在依赖任务结束之后开始）
 *   autoplay = true 表示这条任务"自动跑"（如电饭煲），不阻塞操作者
 *
 * 拖拽：用 pointer events 自实现，按住的偏移会被补偿，
 *       拖动时显示落点预览，落点按分钟取整并避免重叠。
 */

// ==================== 题库 ====================
const QUESTIONS = [
  {
    id: "cook-mom",
    title: "妈妈下班回家做饭",
    desc: "妈妈下班回家做饭。煮饭用电饭煲（电饭煲会自动煮，妈妈不用守着），炒菜用炒锅。怎样安排用时最少？",
    tracks: [
      { id: "mom",  name: "妈妈",   icon: "👩" },
      { id: "rice", name: "电饭煲", icon: "🍚" },
      { id: "pan",  name: "炒锅",   icon: "🍳" },
    ],
    tasks: [
      { id: "wash",  name: "淘米",  duration: 3,  color: "#f4a44a", needs: "mom" },
      { id: "veg",   name: "洗菜",  duration: 8,  color: "#3aa87a", needs: "mom",  after: ["wash"] },
      { id: "cut",   name: "切菜",  duration: 10, color: "#2d7a9b", needs: "mom",  after: ["veg"] },
      { id: "cook",  name: "煮饭",  duration: 30, color: "#e89a3c", needs: "rice", after: ["wash"], autoplay: true },
      { id: "fry",   name: "炒菜",  duration: 10, color: "#e74c4c", needs: "pan",  after: ["cut"] },
    ],
    optimal: 33,
    hint: "煮饭用电饭煲自动跑 30 分钟，妈妈不用守着。在这 30 分钟里同步完成洗菜+切菜+炒菜！",
  },

  {
    id: "morning-dandan",
    title: "丹丹的周末早晨",
    desc: "冬日周末，丹丹早上要做这些事。听故事可以一边做别的事。怎样安排最节省时间？",
    tracks: [
      { id: "dandan", name: "丹丹",     icon: "🧒" },
      { id: "story",  name: "故事机",   icon: "📻" },
    ],
    tasks: [
      { id: "dress", name: "起床穿衣", duration: 3,  color: "#f4a44a", needs: "dandan" },
      { id: "wash",  name: "刷牙洗脸", duration: 2,  color: "#5db8d4", needs: "dandan", after: ["dress"] },
      { id: "tidy",  name: "整理房间", duration: 5,  color: "#a86bd4", needs: "dandan", after: ["wash"] },
      { id: "eat",   name: "吃早点",   duration: 10, color: "#e74c4c", needs: "dandan", after: ["tidy"] },
      { id: "listen",name: "听故事",   duration: 20, color: "#e89a3c", needs: "story",  after: ["dress"], autoplay: true },
    ],
    optimal: 25,
    hint: "听故事 20 分钟自己跑，丹丹同时刷牙(2)+整理(5)+吃早点(10) = 17 分钟，全塞进去！",
  },

  {
    id: "homework-duoduo",
    title: "多多的作业安排",
    desc: "多多今天要完成这些作业。打印资料时打印机自己干活，多多可以做别的事。怎样安排用时最少？",
    tracks: [
      { id: "duoduo", name: "多多",   icon: "📚" },
      { id: "printer",name: "打印机", icon: "🖨" },
    ],
    tasks: [
      { id: "search",  name: "上网查资料", duration: 10, color: "#f4a44a", needs: "duoduo" },
      { id: "print",   name: "打印资料",   duration: 5,  color: "#e89a3c", needs: "printer", after: ["search"], autoplay: true },
      { id: "english", name: "读英语故事", duration: 4,  color: "#3aa87a", needs: "duoduo",  after: ["search"] },
      { id: "math",    name: "练口算",     duration: 3,  color: "#a86bd4", needs: "duoduo",  after: ["search"] },
    ],
    optimal: 15,
    hint: "上网查资料 10 分钟后，让打印机自己打 5 分钟。这 5 分钟里同时读英语(4)+口算(1)，剩 2 分钟继续口算。",
  },

  {
    id: "egg-tiantian",
    title: "甜甜学做炒鸡蛋",
    desc: "甜甜要学做炒鸡蛋。烧热锅、烧热油是灶台自动加热的，不用一直守着。最少需要多少分钟？",
    tracks: [
      { id: "tian",  name: "甜甜",   icon: "👧" },
      { id: "stove", name: "灶台",   icon: "🔥" },
    ],
    tasks: [
      { id: "knock", name: "敲蛋",     duration: 1, color: "#f6cb4a", needs: "tian" },
      { id: "stir",  name: "搅蛋",     duration: 1, color: "#f4a44a", needs: "tian", after: ["knock"] },
      { id: "onion", name: "切葱",     duration: 1, color: "#3aa87a", needs: "tian", after: ["stir"] },
      { id: "wash",  name: "洗锅",     duration: 2, color: "#5db8d4", needs: "tian", after: ["onion"] },
      { id: "heat1", name: "烧热锅",   duration: 2, color: "#c47436", needs: "stove",after: ["wash"], autoplay: true },
      { id: "heat2", name: "烧热油",   duration: 1, color: "#e89a3c", needs: "stove",after: ["heat1"], autoplay: true },
      { id: "fry",   name: "炒蛋",     duration: 4, color: "#e74c4c", needs: "tian", after: ["heat2"] },
    ],
    optimal: 11,
    hint: "敲蛋+搅蛋+切葱+洗锅 = 5 分钟，然后让灶台自动烧热(2)+热油(1) = 3 分钟，最后炒蛋(4) = 12... 但烧热锅时可以做其他？",
  },
];

// ==================== 状态 ====================
let currentQ = null;
let placements = {};   // taskId → { trackId, startMin } 或 null（在池里）
const PIXELS_PER_MIN = 18;
const TIMELINE_PADDING = 4;

// ==================== DOM ====================
const els = {
  title: document.getElementById("puzzleTitle"),
  desc: document.getElementById("puzzleDesc"),
  pool: document.getElementById("poolItems"),
  axis: document.getElementById("ganttAxis"),
  tracks: document.getElementById("ganttTracks"),
  totalLine: document.getElementById("totalLine"),
  totalLineLabel: document.getElementById("totalLineLabel"),
  timeReadout: document.getElementById("timeReadout"),
  resultMsg: document.getElementById("resultMsg"),
  newBtn: document.getElementById("newBtn"),
  resetBtn: document.getElementById("resetBtn"),
  hintBtn: document.getElementById("hintBtn"),
  submitBtn: document.getElementById("submitBtn"),
};

// ==================== 渲染 ====================
function loadQuestion(q) {
  currentQ = q;
  placements = {};
  for (const t of q.tasks) placements[t.id] = null;

  els.title.textContent = q.title;
  els.desc.textContent  = q.desc;
  els.resultMsg.textContent = "";
  els.resultMsg.className = "result-msg";

  renderAll();
}

function getMinutePx() {
  return parseFloat(document.documentElement.style.getPropertyValue("--minute-px")) || PIXELS_PER_MIN;
}

function renderAll() {
  renderAxis();
  renderTracks();
  renderPool();
  updateTotalTime();
}

function renderAxis() {
  const totalMin = currentQ.optimal + TIMELINE_PADDING + 4;
  els.axis.innerHTML = "";
  // 把整条轨道按可用宽度均匀分配，刻度始终铺满整条；不再有"右侧空白"或"溢出"问题
  const trackArea = els.axis.offsetWidth - 100;  // 减去左侧标签宽
  const minutePx = trackArea / totalMin;
  document.documentElement.style.setProperty("--minute-px", `${minutePx}px`);

  // 关键档（0/10/20/...）显示数字，中间档（每 5 分钟）只显示一个小点
  const minorStep = totalMin <= 20 ? 2 : 5;
  for (let m = 0; m <= totalMin; m += minorStep) {
    const tick = document.createElement("span");
    const isMajor = m % 10 === 0;
    tick.className = "tick" + (isMajor ? " major" : " minor");
    tick.textContent = isMajor ? m : "";
    tick.style.left = `${100 + m * minutePx}px`;
    els.axis.appendChild(tick);
  }
  return minutePx;
}

function renderTracks() {
  els.tracks.innerHTML = "";
  for (const tr of currentQ.tracks) {
    const row = document.createElement("div");
    row.className = "gantt-track";
    row.dataset.trackId = tr.id;

    const lab = document.createElement("div");
    lab.className = "track-label";
    // 优先使用 iconUrl（像素图片），没有则回退到 emoji icon
    const iconHtml = tr.iconUrl
      ? `<img src="${tr.iconUrl}" alt="">`
      : (tr.icon || "");
    lab.innerHTML = `<span class="track-icon">${iconHtml}</span><span>${tr.name}</span>`;

    const area = document.createElement("div");
    area.className = "track-area";
    area.dataset.trackId = tr.id;

    row.appendChild(lab);
    row.appendChild(area);
    els.tracks.appendChild(row);
  }

  // 把已放置的任务画上去
  for (const t of currentQ.tasks) {
    const p = placements[t.id];
    if (!p) continue;
    const trackArea = els.tracks.querySelector(`.track-area[data-track-id="${p.trackId}"]`);
    if (trackArea) trackArea.appendChild(makeTaskBlock(t, true, p.startMin));
  }
}

function renderPool() {
  els.pool.innerHTML = "";
  let unplaced = 0;
  for (const t of currentQ.tasks) {
    if (placements[t.id]) continue;
    unplaced++;
    els.pool.appendChild(makeTaskBlock(t, false));
  }
  if (unplaced === 0) {
    els.pool.innerHTML = '<span class="pool-empty">所有任务都安排好了！</span>';
  }
}

function makeTaskBlock(task, placed, startMin = null) {
  const minutePx = getMinutePx();
  const el = document.createElement("div");
  el.className = "task-block";
  el.dataset.taskId = task.id;
  el.dataset.placed = placed ? "true" : "false";
  if (task.autoplay) el.dataset.autoplay = "true";
  el.style.setProperty("--block-color", task.color);

  if (placed) {
    el.style.left = `${startMin * minutePx}px`;
    el.style.width = `${task.duration * minutePx}px`;
  } else {
    // 任务池里的方块宽度根据名字长度，不跟时间轴绑定，避免长任务挤换行
    el.style.minWidth = `${Math.max(80, task.name.length * 18 + 36)}px`;
  }

  el.title = `${task.name} · ${task.duration}分钟${task.autoplay ? "（自动）" : ""}`;
  el.innerHTML = `
    <div class="tb-name">${task.name}</div>
    <div class="tb-time">${task.duration}分钟${task.autoplay ? " · 自动" : ""}</div>
    ${placed ? `<button class="tb-remove" type="button" aria-label="移除">×</button>` : ""}
  `;

  // 已放置的方块上 × 按钮 → 移回池
  const removeBtn = el.querySelector(".tb-remove");
  if (removeBtn) {
    removeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      placements[task.id] = null;
      renderAll();
    });
  }

  el.addEventListener("pointerdown", (e) => onPointerDown(e, task, el, placed));

  return el;
}

// ==================== 拖拽（pointer events） ====================
function onPointerDown(e, task, blockEl, fromPlaced) {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  if (e.target.closest(".tb-remove")) return;
  e.preventDefault();

  const rect = blockEl.getBoundingClientRect();
  const minutePx = getMinutePx();
  const grabOffsetX = e.clientX - rect.left;
  const grabOffsetY = e.clientY - rect.top;
  const blockW = rect.width;
  const blockH = rect.height;

  blockEl.classList.add("dragging");

  // 创建跟随指针的镜像
  const ghost = document.createElement("div");
  ghost.className = "task-block dragging-ghost";
  if (task.autoplay) ghost.dataset.autoplay = "true";
  ghost.style.setProperty("--block-color", task.color);
  ghost.style.position = "fixed";
  ghost.style.left = `${e.clientX - grabOffsetX}px`;
  ghost.style.top = `${e.clientY - grabOffsetY}px`;
  ghost.style.width = `${blockW}px`;
  ghost.style.height = `${blockH}px`;
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "9999";
  ghost.innerHTML = `
    <div class="tb-name">${task.name}</div>
    <div class="tb-time">${task.duration}分钟${task.autoplay ? " · 自动" : ""}</div>
  `;
  document.body.appendChild(ghost);

  // 落点信息标签（"第 X 分钟 → 第 Y 分钟"）
  const tip = document.createElement("div");
  tip.className = "drag-tip";
  tip.style.position = "fixed";
  tip.style.pointerEvents = "none";
  tip.style.zIndex = "10000";
  tip.style.display = "none";
  document.body.appendChild(tip);

  let previewEl = null;
  let activeArea = null;

  function clearAreaState() {
    document.querySelectorAll(".track-area").forEach((a) => {
      a.classList.remove("drag-over", "drag-invalid");
    });
    if (previewEl) { previewEl.remove(); previewEl = null; }
    tip.style.display = "none";
    activeArea = null;
  }

  function findAreaUnder(x, y) {
    ghost.style.display = "none";
    const el = document.elementFromPoint(x, y);
    ghost.style.display = "";
    return el?.closest?.(".track-area") || null;
  }

  function onMove(ev) {
    ghost.style.left = `${ev.clientX - grabOffsetX}px`;
    ghost.style.top = `${ev.clientY - grabOffsetY}px`;

    const area = findAreaUnder(ev.clientX, ev.clientY);
    if (area !== activeArea) clearAreaState();
    activeArea = area;

    if (!area) return;
    const valid = area.dataset.trackId === task.needs;
    if (!valid) {
      area.classList.add("drag-invalid");
      area.classList.remove("drag-over");
      return;
    }
    area.classList.add("drag-over");
    area.classList.remove("drag-invalid");

    // 落点 = 指针在轨道内的 x 减去抓取偏移
    const arect = area.getBoundingClientRect();
    const xInTrack = ev.clientX - arect.left - grabOffsetX;
    let startMin = Math.max(0, Math.round(xInTrack / minutePx));
    startMin = clampToFreeSlot(task, area.dataset.trackId, startMin);

    if (!previewEl) {
      previewEl = document.createElement("div");
      previewEl.className = "drop-preview";
      area.appendChild(previewEl);
    } else if (previewEl.parentElement !== area) {
      area.appendChild(previewEl);
    }
    previewEl.style.left = `${startMin * minutePx}px`;
    previewEl.style.width = `${task.duration * minutePx}px`;

    // 时间提示标签
    const endMin = startMin + task.duration;
    tip.textContent = `第 ${startMin} → ${endMin} 分钟`;
    tip.style.display = "block";
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY - 36}px`;
  }

  function onUp(ev) {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);

    const area = findAreaUnder(ev.clientX, ev.clientY);
    let landed = false;
    let invalidTrack = false;

    if (area) {
      if (area.dataset.trackId === task.needs) {
        const arect = area.getBoundingClientRect();
        const xInTrack = ev.clientX - arect.left - grabOffsetX;
        let startMin = Math.max(0, Math.round(xInTrack / minutePx));
        startMin = clampToFreeSlot(task, area.dataset.trackId, startMin);
        placements[task.id] = { trackId: area.dataset.trackId, startMin };
        landed = true;
      } else {
        invalidTrack = true;
      }
    } else {
      // 拖出所有轨道 → 回池
      placements[task.id] = null;
      landed = true;
    }

    ghost.remove();
    tip.remove();
    clearAreaState();
    blockEl.classList.remove("dragging");

    if (invalidTrack) {
      // 不更改 placement，给一个反馈
      blockEl.classList.add("shake");
      setTimeout(() => blockEl.classList.remove("shake"), 360);
    }

    if (landed) renderAll();
  }

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onUp);
}

function clampToFreeSlot(task, trackId, desiredStart) {
  const others = currentQ.tasks
    .filter((t) => t.id !== task.id && placements[t.id]?.trackId === trackId)
    .map((t) => ({ start: placements[t.id].startMin, end: placements[t.id].startMin + t.duration }))
    .sort((a, b) => a.start - b.start);

  let start = desiredStart;
  let attempts = 0;
  while (attempts++ < 50) {
    const end = start + task.duration;
    const conflict = others.find((o) => start < o.end && end > o.start);
    if (!conflict) return start;
    start = conflict.end;
  }
  return desiredStart;
}

// ==================== 校验 / 总时间 ====================
function calcTotalTime() {
  let total = 0;
  for (const t of currentQ.tasks) {
    const p = placements[t.id];
    if (!p) return null;
    total = Math.max(total, p.startMin + t.duration);
  }
  return total;
}

function checkConstraints() {
  const errs = [];
  for (const t of currentQ.tasks) {
    const p = placements[t.id];
    if (!p) { errs.push(`「${t.name}」还没放上去`); continue; }
    if (p.trackId !== t.needs) errs.push(`「${t.name}」放错位置了`);
    if (t.after) {
      for (const depId of t.after) {
        const dp = placements[depId];
        const dep = currentQ.tasks.find((x) => x.id === depId);
        if (!dp || !dep) continue;
        if (p.startMin < dp.startMin + dep.duration) {
          errs.push(`「${t.name}」必须在「${dep.name}」之后`);
        }
      }
    }
  }
  return errs;
}

function updateTotalTime() {
  const total = calcTotalTime();
  if (total == null) {
    els.timeReadout.textContent = "--";
    els.totalLine.hidden = true;
    return;
  }
  els.timeReadout.textContent = total;
  const minutePx = getMinutePx();
  els.totalLine.style.left = `${16 + 100 + total * minutePx}px`;
  els.totalLineLabel.textContent = `${total} 分钟`;
  els.totalLine.hidden = false;
}

function submit() {
  const errs = checkConstraints();
  if (errs.length) {
    els.resultMsg.textContent = "❌ " + errs.slice(0, 2).join("；");
    els.resultMsg.className = "result-msg fail";
    logEvent("math-fail", { problemId: currentQ.id, title: currentQ.title, reason: errs[0] });
    return;
  }
  const total = calcTotalTime();
  if (total <= currentQ.optimal) {
    els.resultMsg.textContent = `🎉 太棒了！${total} 分钟，最优解！+10 经验`;
    els.resultMsg.className = "result-msg success";
    logEvent("math-success", {
      problemId: currentQ.id, title: currentQ.title,
      totalMin: total, optimal: currentQ.optimal,
    });
    if (typeof window.parent?.addCatXp === "function") window.parent.addCatXp(10);
    else if (typeof window.addCatXp === "function") window.addCatXp(10);
  } else {
    els.resultMsg.textContent = `🤔 完成是 ${total} 分钟，但最少只需 ${currentQ.optimal} 分钟，再优化一下？`;
    els.resultMsg.className = "result-msg fail";
    logEvent("math-suboptimal", {
      problemId: currentQ.id, title: currentQ.title,
      totalMin: total, optimal: currentQ.optimal,
    });
  }
}

// ==================== 控制 ====================
function pickRandom() {
  const i = Math.floor(Math.random() * QUESTIONS.length);
  loadQuestion(QUESTIONS[i]);
}

els.newBtn.addEventListener("click", pickRandom);
els.resetBtn.addEventListener("click", () => loadQuestion(currentQ));
els.hintBtn.addEventListener("click", () => {
  els.resultMsg.textContent = "💡 " + currentQ.hint;
  els.resultMsg.className = "result-msg hint";
});
els.submitBtn.addEventListener("click", submit);
window.addEventListener("resize", () => { renderAxis(); renderTracks(); updateTotalTime(); });

// ==================== 启动 ====================
pickRandom();
