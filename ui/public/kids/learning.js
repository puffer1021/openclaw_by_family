/**
 * learning.js — 跟随主界面猫猫进化阶段更新右下角的猫
 */
const CAT_STAGES = [
  { lv: 1,  xpStart: 0,    img: "assets/cat/stages/1-egg.png" },
  { lv: 5,  xpStart: 10,   img: "assets/cat/stages/2-hatchling.png" },
  { lv: 10, xpStart: 30,   img: "assets/cat/stages/3-kitten.png" },
  { lv: 25, xpStart: 80,   img: "assets/cat/stages/4-adult.png" },
  { lv: 50, xpStart: 200,  img: "assets/cat/stages/5-star.png" },
];

function loadXp() {
  const v = parseInt(localStorage.getItem("kids.cat.xp") || "0", 10);
  return isNaN(v) ? 0 : v;
}

function stageOfXp(xp) {
  for (let i = CAT_STAGES.length - 1; i >= 0; i--) {
    if (xp >= CAT_STAGES[i].xpStart) return CAT_STAGES[i];
  }
  return CAT_STAGES[0];
}

function syncCat() {
  const xp = loadXp();
  const st = stageOfXp(xp);
  const img = document.getElementById("floatingCatImg");
  if (img && img.dataset.stage !== st.img) {
    img.dataset.stage = st.img;
    img.src = st.img;
  }
}

window.flashLocked = function(el) {
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
};

window.addEventListener("storage", (e) => {
  if (e.key === "kids.cat.xp") syncCat();
});

syncCat();
