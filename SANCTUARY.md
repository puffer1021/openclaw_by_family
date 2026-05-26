# Sanctuary · 小朋友的家

一个给 4–10 岁孩子用的 AI 陪伴桌面应用。
- **孩子模式**：上传画作 → 跟"蛋蛋"伙伴聊天 → 让 AI 重画 / 做成动画；做数学题；情绪聊天。
- **家长模式**：看孩子最近做了什么、一键生成今日日报、跟 AI 助手追问细节。
- **猫猫蛋经济系统**：孩子在每个房间做事 → 攒能量 → 主页喂食/玩耍消耗能量 → 猫攒经验进化（蛋 → 幼崽 → 小奶猫 → 成年猫 → 星辰猫）。

---

## 一、目录结构（核心部分）

```
ui/public/kids/                  ← 孩子端（vanilla HTML/CSS/JS）
├── index.html                   主页（猫 + 房间地图 + 喂食/玩耍）
├── home.js                      主页逻辑：经验/能量/进化/互动按钮
├── kids-log.js                  公共事件日志 + 能量奖励规则
├── creation.html / .css / .js   创造房间（核心）
├── emotion.html  / .css / .js   情绪房间（实时语音对话）
├── learning.html / .css / .js   学习房间入口（岛屿地图）
├── math.html / math-schedule.*  数学岛（拍照解题 + 时间分配游戏）
├── parent.html / .css / .js     家长模式（日志 + AI 助手 + 一键日报）
├── styles.css                   公共样式（顶栏 / 字体 / 通用按钮）
└── assets/
    ├── cat/stages/*.png         猫的 5 个进化阶段图
    ├── ui/stickers/foods/*      102 张食物贴纸
    ├── ui/stickers/items/*      1244 张物品贴纸
    └── ui/stickers/manifest.json 贴纸索引（前端自动 fetch）

services/storyboard/index.mjs    Node.js 后端（端口 3939）
├── /api/storyboard/coach        蛋蛋对话
├── /api/storyboard/describe     画作视觉描述
├── /api/creation/generate-image 拼贴 + 聊天 → AI 重画
├── /api/creation/generate-video 拼贴 + 聊天 → AI 动画
├── /api/parent/chat             家长助手对话 / 日报
└── /api/math/...                数学解题流

skills/kids-storyboard-coach/SKILL.md   蛋蛋的人设 prompt（重启后端才生效）
```

---

## 二、启动准备

### 1. 系统要求
- Node.js 22+
- pnpm（已在 repo 用）
- macOS / Linux（Windows 也行，但本项目是在 macOS 上开发的）

### 2. 安装依赖
```bash
pnpm install
```

### 3. API key（写在 repo 根目录的 `.env`）
```
MINIMAX_API_KEY=...        # 蛋蛋对话 / 家长助手
ARK_API_KEY=...            # 豆包：Seedream(生图) + Seedance(生视频) + Vision(看图)
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_IMAGE_MODEL=doubao-seedream-5-0-260128
ARK_VIDEO_MODEL=doubao-seedance-1-5-pro-251215
STORYBOARD_PORT=3939
```

> ⚠️ `.env` 已加到 `.gitignore`，**不要提交到 git**。

---

## 三、启动步骤

需要开两个终端：

### 终端 A · 后端（端口 3939）
```bash
cd <repo-root>
node --env-file=.env services/storyboard/index.mjs
```

启动成功会显示：
```
[storyboard] listening on http://127.0.0.1:3939
  ARK key: set (model doubao-seedream-5-0-260128)
  MiniMax key: set
```

### 终端 B · 前端（vite，端口 5173）
```bash
cd ui
pnpm dev
```

然后浏览器打开：

```
http://localhost:5173/kids/chat?session=agent%3Amain%3Amain
```

页面顶部有 `孩子模式` / `家长模式` tab，左右切换。

---

## 四、孩子模式

### 主页（房间地图）
- 左侧：玩家信息、猫的进化展示、经验值条、**能量 + 喂食/玩耍** 按钮
- 中间：屋子地图，三个房间入口（情绪 / 学习 / 创造）
- 顶部：Sanctuary logo + 模式切换 + 全屏 / 关闭

**互动**：点 `喂食` 消耗 5 能量得 +3 XP；点 `玩耍` 消耗 8 能量得 +5 XP。能量不够按钮变灰。

### 创造房间 ⭐ 核心
1. **左侧 sidebar 两个 tab**
   - **蛋蛋的口袋**：1346 张像素贴纸（食物/小东西），点选 → 在画板点击放置
   - **画笔**：4 档粗细 + 36 色圆形色板 + 撤销 + 擦掉涂鸦
2. **中央画板**：拍照 / 上传画作 → 在上面涂鸦 + 贴贴纸
3. **左下行动栏**（透明毛玻璃按钮）：
   - **拍照 / 上传**：导入新画
   - **生视频** / **生图**：把当前画板（含涂鸦+贴纸）+ 跟蛋蛋的聊天 → AI 重新画或拍成动画。结果作为新的幻灯页加入画板，左右箭头翻看
   - **清空**：清除所有内容回到初始
4. **右侧对话区**：
   - 头像跟着主页猫的等级走（蛋 / 幼崽 / 小奶猫 ...）
   - 文字输入 + 🎤 语音输入（浏览器原生 Web Speech，中文识别）
   - 蛋蛋"看得见"画板：你贴东西、涂笔时蛋蛋会自然接话（4.5 秒节流）

**生视频要求**：跟蛋蛋至少聊 3 句、累计 30 字才会触发。蛋蛋会按缺口提问。

**持久化**：原图、涂鸦、贴纸、生成的图、生成的视频、聊天记录都存在 `localStorage` 里（key: `creation_state_v1`），下次进来从上次的状态继续。

### 学习房间
- 进入是一张岛屿地图，目前可点击 `数学岛`，其他三个上锁
- **数学岛 - 拍照解题**：拍/上传题目 → AI Vision 识别 → 后端 manim 生成解题动画 → iframe 嵌入黑板黄虚线框播放
- **时间分配游戏**：拖拽任务到甘特图轨道，最优解奖最多能量

### 情绪房间
- 跟一只虚拟猫做实时语音聊天 + 看图
- 后端用的是 [MiniCPM-o 4.5 公开 API](https://minicpmo45.modelbest.cn)（免费但有时不稳）
- WebSocket：`wss://minicpmo45.modelbest.cn/v1/realtime`
- 想换更稳的可以：本地部署 [Comni](https://github.com/tc-mb/llama.cpp-omni)（Mac M 系列原生支持），或换豆包 Realtime（付费）

---

## 五、家长模式

需要 PIN 解锁（默认 `1234`，可在界面里改）。解锁后看到：

- **左上 · 概览卡**：猫的等级 / 经验进度 / 累计聊天 / 题数 / 作品 / 最近活动
- **左中 · 活动日志**：实时显示孩子在三个房间做的所有事，按时间倒序
  - **生成日报** 按钮：把今天 00:00 起所有事件 + 一段结构化指令发给 MiniMax，输出"情绪/学习/创造/亮点/建议" 五段日报
  - **复制** 按钮：把日志拷到剪贴板
- **左下**：修改密码 / 重置进度
- **右侧 · 小喵助手**：基于活动事件跟父母聊孩子的事，5 个快捷追问 chip（孩子今天怎么样 / 情绪话题 / 数学薄弱点 / 创造力观察 / 亲子建议）

---

## 六、能量系统（自动触发）

孩子在房间完成事件 → `kids-log.js` 自动加能量到 `localStorage["kids.cat.energy"]`：

| 事件 | 加能量 |
|---|---:|
| 上传画作 | +3 |
| 跟蛋蛋编出故事 | +6 |
| 生一张 AI 图 | +8 |
| 生一段视频 | +12 |
| 数学题最优解 | +8 |
| 数学题完成（非最优） | +3 |
| 完成情绪聊天 | +5 |
| 蛋蛋每回一句 | +1 |

奖励规则在 [`ui/public/kids/kids-log.js`](ui/public/kids/kids-log.js) 顶部的 `ENERGY_REWARD`，想调改一处。

喂食 / 玩耍 的消耗 + XP 在 [`ui/public/kids/index.html`](ui/public/kids/index.html) 的 `data-cost` / `data-xp` 属性上。

---

## 七、常见问题

### Q1：生图返回的是文字海报，不是图片？
SKILL.md 让 LLM 自由组合 prompt 时容易被孩子聊天带跑。我们已经改成"模板化拼接"，LLM 只做翻译，最终 prompt 用固定英文模板。如果再出现，看 `/tmp/storyboard.log` 里 `[creation/image] prompt:` 那行。

### Q2：情绪房间报 `CUDA error: device-side assert triggered`？
免费 demo 端点服务器侧问题，跟我们代码无关。等会儿重试，或者本地部署 Comni 自己跑模型。

### Q3：生视频按下没反应？
要先跟蛋蛋聊够内容（≥ 3 句、≥ 30 字）。蛋蛋会主动提问。

### Q4：刷新页面后画板的贴纸 / 生成的图丢了？
首次启用持久化后才会存。如果之前画的没了是正常（旧版没存）。新画的会保留。
localStorage 容量 5 MB，存太多会自动降级（先丢生成的视频，再丢生成的图，再丢涂鸦像素，最坏只保留聊天）。

### Q5：每次改 SKILL.md 没生效？
`services/storyboard/index.mjs` 启动时缓存 SKILL.md，必须重启后端进程。

### Q6：emoji 不好看？
家长模式所有 emoji 已替换成内联 SVG（在 `parent.js` 顶部 `ICONS` 集中定义）。想加新图标在 `ICONS` 里加一条 `<svg>` 字符串即可。

---

## 八、二次开发提示

### 字体
- ZCOOL KuaiLe（Google Fonts）一处 `@import` 在 `ui/public/kids/styles.css`
- 想换字体在 `styles.css` 顶部和各 `.brand` / `.tab-button` / `.canvas-empty` 处改

### 颜色
- 主色金 `#ffd83b`（gold）、绿 `#2f6d45`、米 `#fff8e7`
- 在 `styles.css` `:root` 自定义

### 加房间
1. 在 `ui/public/kids/` 加 `roomname.html` + `.css` + `.js`
2. 在 `index.html` 主图地图上画热区（`.room-hotspot`）
3. 完成事件用 `import { logEvent } from "./kids-log.js"; logEvent("xxx", { ... })` 触发能量奖励

### 换 AI 后端
- 蛋蛋对话：改 `services/storyboard/index.mjs` 的 `callMiniMax`
- 生图：改 `callSeedream`（支持 reference image 也可以加）
- 生视频：改 `callSeedance`
- 情绪实时：改 `ui/public/kids/emotion.js` 第 11 行 `API_ROOT`

---

## 九、技术栈

| 层 | 选型 |
|---|---|
| 前端打包 | Vite |
| 前端框架 | 无（vanilla JS）|
| UI 字体 | ZCOOL KuaiLe |
| 后端 | Node.js (`http` 模块) |
| LLM 对话 | MiniMax M2.7 (走 Anthropic 兼容协议) |
| 图像理解 | 豆包 Vision (`doubao-1-5-vision-pro-32k`) |
| 文生图 | 豆包 Seedream 5.0 |
| 文生视频 | 豆包 Seedance 1.5 Pro |
| 实时语音 | MiniCPM-o 4.5 公开 API |
| 数学解题动画 | Manim (Python，后端缓存到 `services/storyboard/math-cache/`) |
| 持久化 | 浏览器 localStorage |

---

## 十、版权与素材

- 食物贴纸：Ghost Pixxells - Free Pixel foods (itch.io)
- 物品贴纸：自购像素素材包
- 房间背景：自绘 / AI 生成像素图
- 字体：ZCOOL KuaiLe（Open Font License）
- 代码：基于 OpenClaw 二次开发，原项目协议见根目录 `LICENSE`
