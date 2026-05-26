const tabs = document.querySelectorAll(".tab-button");
const menuButtons = document.querySelectorAll(".menu-button");
const player = document.getElementById("mapPlayer");

const BASE_WORLD = { width: 1656, height: 1172 };
const WORLD = { width: 1548, height: 1096 };
const SCALE = {
  x: WORLD.width / BASE_WORLD.width,
  y: WORLD.height / BASE_WORLD.height
};
const PLAYER = {
  width: 72 * SCALE.x,
  height: 100 * SCALE.y,
  speed: 5 * SCALE.x
};

const keys = new Set();
let position = point(818, 934);
let pendingRoom = null;

const rooms = {
  emotion: {
    href: "emotion.html",
    door: rect(405, 635, 155, 150)
  },
  learning: {
    href: "learning.html",
    door: rect(735, 635, 155, 150)
  },
  creation: {
    href: "creation.html",
    door: rect(1130, 635, 165, 150)
  }
};

const walkZones = [
  rect(88, 600, 1490, 445),
  rect(110, 95, 490, 505),
  rect(620, 90, 430, 510),
  rect(1068, 90, 430, 510),
  rect(645, 1020, 360, 140)
];

const walls = [
  rect(0, 0, 84, 1172),
  rect(1568, 0, 88, 1172),
  rect(0, 0, 1656, 80),
  rect(600, 70, 38, 640),
  rect(1048, 70, 38, 640),
  rect(94, 586, 305, 45),
  rect(560, 586, 178, 45),
  rect(898, 586, 230, 45),
  rect(1294, 586, 270, 45),
  rect(570, 1000, 60, 172),
  rect(755, 1000, 58, 172),
  rect(970, 1000, 58, 172)
];

function point(x, y) {
  return {
    x: x * SCALE.x,
    y: y * SCALE.y
  };
}

function rect(x, y, width, height) {
  return {
    x: x * SCALE.x,
    y: y * SCALE.y,
    width: width * SCALE.x,
    height: height * SCALE.y
  };
}

function setActive(buttons, activeButton) {
  buttons.forEach((button) => {
    button.classList.toggle("active", button === activeButton);
  });
}

tabs.forEach((button) => {
  button.addEventListener("click", () => setActive(tabs, button));
});

// menu-button 已删除（情绪/学习/创造），保留向下兼容
if (menuButtons.length) {
  menuButtons.forEach((button) => {
    button.addEventListener("click", () => setActive(menuButtons, button));
  });
}

// ===== 小猫经验值 & 进化系统 =====
const CAT_STAGES = [
  { lv: 1,  xpStart: 0,    xpEnd: 10,   img: "assets/cat/stages/1-egg.png",       name: "猫猫蛋"   },
  { lv: 5,  xpStart: 10,   xpEnd: 30,   img: "assets/cat/stages/2-hatchling.png", name: "破壳幼崽" },
  { lv: 10, xpStart: 30,   xpEnd: 80,   img: "assets/cat/stages/3-kitten.png",    name: "小奶猫"   },
  { lv: 25, xpStart: 80,   xpEnd: 200,  img: "assets/cat/stages/4-adult.png",     name: "成年猫"   },
  { lv: 50, xpStart: 200,  xpEnd: 999,  img: "assets/cat/stages/5-star.png",      name: "星辰猫"   },
];

function loadXp() {
  const v = parseInt(localStorage.getItem("kids.cat.xp") || "0", 10);
  return isNaN(v) ? 0 : v;
}
function saveXp(xp) { localStorage.setItem("kids.cat.xp", String(xp)); }

function stageOfXp(xp) {
  for (let i = CAT_STAGES.length - 1; i >= 0; i--) {
    if (xp >= CAT_STAGES[i].xpStart) return CAT_STAGES[i];
  }
  return CAT_STAGES[0];
}

function renderStagesTrack(currentStage) {
  const track = document.getElementById("catStagesTrack");
  if (!track) return;
  track.innerHTML = "";
  CAT_STAGES.forEach((s) => {
    const isActive = s.lv === currentStage.lv;
    const isUnlocked = s.lv <= currentStage.lv;
    const thumb = document.createElement("div");
    thumb.className = "cat-stage-thumb" + (isActive ? " active" : isUnlocked ? " unlocked" : " locked");
    thumb.dataset.name = s.name;
    const wrap = document.createElement("div");
    wrap.className = "cat-stage-img-wrap";
    const imgEl = document.createElement("img");
    imgEl.src = s.img;
    imgEl.alt = s.name;
    imgEl.loading = "lazy";
    // Stage 4 (adult) is portrait-shaped — anchor to top so the face shows
    if (s.img.includes("4-adult")) imgEl.dataset.portrait = "true";
    wrap.appendChild(imgEl);
    thumb.appendChild(wrap);
    track.appendChild(thumb);
  });
}

function renderCatEvolution() {
  const xp = loadXp();
  const stage = stageOfXp(xp);
  const img = document.getElementById("catEvoImg");
  const name = document.getElementById("catEvoName");
  const xpLabel = document.getElementById("xpLabel");
  const xpBar = document.getElementById("xpBar");
  const lvLabel = document.getElementById("playerLevelLabel");
  if (!img) return;

  // 切换图片（如果变了）
  const prevSrc = img.dataset.stage || "";
  if (prevSrc !== stage.img) {
    img.dataset.stage = stage.img;
    img.src = stage.img;
    if (prevSrc) {
      // 进化闪光特效
      const frame = document.getElementById("catEvoFrame");
      frame?.classList.remove("evolving");
      void frame?.offsetWidth;
      frame?.classList.add("evolving");
    }
  }
  if (name) name.textContent = stage.name;
  if (lvLabel) lvLabel.textContent = `Lv ${stage.lv} ${stage.name}`;

  // 进度条（当前阶段内的进度）
  const progress = Math.min(1, (xp - stage.xpStart) / Math.max(1, stage.xpEnd - stage.xpStart));
  if (xpBar) xpBar.style.width = `${progress * 100}%`;
  if (xpLabel) {
    xpLabel.textContent = stage.lv >= 50 ? `${xp} EXP（满级）` : `${xp - stage.xpStart} / ${stage.xpEnd - stage.xpStart}`;
  }

  renderStagesTrack(stage);
}

// 暴露给其他页面调 (e.g. emotion 页面会话结束 +5 XP)
window.addCatXp = function(delta = 1) {
  const xp = loadXp() + delta;
  saveXp(xp);
  renderCatEvolution();
};

// ===== 能量系统：孩子在各房间完成任务 -> +能量；喂食/玩耍 -> 用能量换 XP =====
function loadEnergy() {
  const v = parseInt(localStorage.getItem("kids.cat.energy") || "0", 10);
  return isNaN(v) ? 0 : Math.max(0, v);
}
function saveEnergy(e) { localStorage.setItem("kids.cat.energy", String(Math.max(0, Math.floor(e)))); }
function renderEnergy() {
  const el = document.getElementById("energyLabel");
  if (el) el.textContent = String(loadEnergy());
  // 让按钮根据能量是否足够变灰
  document.querySelectorAll(".cat-care-btn").forEach((b) => {
    const cost = parseInt(b.dataset.cost || "0", 10);
    b.disabled = loadEnergy() < cost;
  });
}
window.addCatEnergy = function(delta = 1) {
  const e = loadEnergy() + delta;
  saveEnergy(e);
  renderEnergy();
};

// 喂食 / 玩耍 ：消耗能量，加 XP，飘字 + 反馈
function popXp(originEl, amount) {
  const r = originEl.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "xp-pop";
  el.textContent = `+${amount} XP`;
  el.style.left = (r.left + r.width / 2 - 24) + "px";
  el.style.top = (r.top - 6) + "px";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}
function bindCareBtn(id) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", () => {
    const cost = parseInt(btn.dataset.cost || "0", 10);
    const xp   = parseInt(btn.dataset.xp || "0", 10);
    const cur  = loadEnergy();
    if (cur < cost) return;
    saveEnergy(cur - cost);
    window.addCatXp(xp);
    renderEnergy();
    popXp(btn, xp);
    btn.classList.remove("flash");
    void btn.offsetWidth;
    btn.classList.add("flash");
  });
}
bindCareBtn("feedBtn");
bindCareBtn("playBtn");

// 喂食/玩耍 按钮的 SVG 图标
const CARE_ICONS = {
  bowl: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M3 12a9 4 0 0 0 18 0z"/><path d="M3 12a9 4 0 0 1 18 0"/><path d="M12 6v3"/><circle cx="9" cy="5" r="0.6" fill="currentColor"/><circle cx="14" cy="4" r="0.6" fill="currentColor"/></svg>',
  ball: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><circle cx="12" cy="12" r="9"/><path d="M3 12c4 0 6-3 9-3s5 3 9 3"/><path d="M3 12c4 0 6 3 9 3s5-3 9-3"/></svg>',
};
document.querySelectorAll("[data-care-icon]").forEach((el) => {
  const k = el.dataset.careIcon;
  if (CARE_ICONS[k]) el.innerHTML = CARE_ICONS[k];
});

renderCatEvolution();
renderEnergy();
// 跨页面：localStorage 变化（其他 tab/iframe）也刷新
window.addEventListener("storage", (e) => {
  if (e.key === "kids.cat.xp") renderCatEvolution();
  if (e.key === "kids.cat.energy") renderEnergy();
});

// 重置等级按钮
const resetLevelBtn = document.getElementById("resetLevelBtn");
if (resetLevelBtn) {
  resetLevelBtn.addEventListener("click", () => {
    if (!confirm("重置小猫等级和能量？活动记录不会删除。")) return;
    localStorage.removeItem("kids.cat.xp");
    localStorage.removeItem("kids.cat.energy");
    renderCatEvolution();
    renderEnergy();
  });
}

if (player) {

function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function playerRect(next = position) {
  return {
    x: next.x - PLAYER.width / 2,
    y: next.y - PLAYER.height,
    width: PLAYER.width,
    height: PLAYER.height
  };
}

function isInWalkZone(rect) {
  return walkZones.some((zone) => intersects(rect, zone));
}

function hitsWall(rect) {
  return walls.some((wall) => intersects(rect, wall));
}

function findRoomAt(rect) {
  return Object.values(rooms).find((room) => intersects(rect, room.door));
}

function canMoveTo(next) {
  const rect = playerRect(next);
  return isInWalkZone(rect) && !hitsWall(rect);
}

function render() {
  player.style.left = `${(position.x / WORLD.width) * 100}%`;
  player.style.top = `${(position.y / WORLD.height) * 100}%`;
}

function maybeEnterRoom() {
  const room = findRoomAt(playerRect());
  if (!room || pendingRoom === room.href) {
    return;
  }

  pendingRoom = room.href;
  window.setTimeout(() => {
    window.location.href = room.href;
  }, 180);
}

function update() {
  let dx = 0;
  let dy = 0;

  if (keys.has("arrowup") || keys.has("w")) dy -= PLAYER.speed;
  if (keys.has("arrowdown") || keys.has("s")) dy += PLAYER.speed;
  if (keys.has("arrowleft") || keys.has("a")) dx -= PLAYER.speed;
  if (keys.has("arrowright") || keys.has("d")) dx += PLAYER.speed;

  if (dx && dy) {
    dx *= 0.707;
    dy *= 0.707;
  }

  const moving = dx !== 0 || dy !== 0;
  player.classList.toggle("walking", moving);

  if (moving) {
    const nextX = { x: position.x + dx, y: position.y };
    if (canMoveTo(nextX)) {
      position = nextX;
    }

    const nextY = { x: position.x, y: position.y + dy };
    if (canMoveTo(nextY)) {
      position = nextY;
    }

    render();
    maybeEnterRoom();
  }

  requestAnimationFrame(update);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(key)) {
    keys.add(key);
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

render();
update();
}
