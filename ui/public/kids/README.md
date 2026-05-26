# 小十二的家 · 项目结构

## 页面（孩子端）

```
index.html         主页：像素房间 + 角色行走 + 进入 3 个房间
├─ emotion.html    情绪房间：MiniCPM-o 实时语音/视频对话猫猫
├─ learning.html   学习房间：4 岛屿地图（数学岛已解锁）
│  └─ math.html    数学岛 · 合理安排时间（甘特图拖拽题）
└─ creation.html   创造房间：画作上传 → AI 编故事 → 生成视频
```

## 文件对应表

| 页面 | HTML | CSS | JS |
|---|---|---|---|
| 主页 | `index.html` | `styles.css` | `home.js` |
| 情绪房间 | `emotion.html` | `styles.css` + `emotion.css` | `emotion.js` |
| 学习房间 | `learning.html` | `styles.css` + `learning.css` | `learning.js` |
| 数学岛 | `math.html` | `styles.css` + `math.css` | `math.js` |
| 创造房间 | `creation.html` | `styles.css` + `creation.css` | `creation.js` |

## 资源 `assets/`

```
assets/
├── cat/
│   ├── stages/        猫猫进化阶段（5 张静态图，对应 5 个等级）
│   │   ├── 1-egg.png        Lv 1   猫猫蛋
│   │   ├── 2-hatchling.png  Lv 5   破壳幼崽
│   │   ├── 3-kitten.png     Lv 10  小奶猫
│   │   ├── 4-adult.png      Lv 25  成年猫
│   │   └── 5-star.png       Lv 50  星辰猫（满级）
│   └── live2d/        情绪房间猫猫动画（5 个 WebM 透明视频）
│       ├── idle.webm
│       ├── listening.webm
│       ├── thinking.webm
│       ├── speaking.webm
│       └── happy.webm
├── rooms/             房间背景图
│   ├── home.png             主页像素房间
│   ├── learning-map.png     学习岛屿地图
│   ├── emotion-room.png     情绪房间背景
│   └── creation-room.png    创造房间背景
└── ui/                通用 UI 资源
    ├── ai-teacher.png        故事教练头像
    ├── btn-generate-video.png
    ├── easel-empty.png       创造房间画架
    ├── icon-camera_upload.png
    └── player.png            主页角色行走 sprite
```

## 经验值 / 进化系统

`localStorage["kids.cat.xp"]` 跨页面存经验。各页面调用 `window.addCatXp(n)` 加经验，UI 自动同步。

| 等级 | 经验范围 | 形态 |
|---|---|---|
| Lv 1  | 0–9    | 猫猫蛋 |
| Lv 5  | 10–29  | 破壳幼崽 |
| Lv 10 | 30–79  | 小奶猫 |
| Lv 25 | 80–199 | 成年猫 |
| Lv 50 | 200+   | 星辰猫（满级） |

## 后端 `services/storyboard/`

```
index.mjs           主服务（端口 3939）
                    创造房间用：图像 → 故事 → 分镜图 → 视频
tools/              一次性工具脚本
├── gen-cat-videos.mjs    用 Seedance API 生成猫猫 5 个状态视频
├── cat-bg-remove.py      用 floodfill 抠掉视频白底 → WebM with alpha
└── test-minicpm.mjs      MiniCPM-o WebSocket 联调测试
video-cache/        生成视频本地缓存（已加 .gitignore）
```

外部 API：
- **MiniCPM-o**：`wss://minicpmo45.modelbest.cn/v1/realtime`（情绪房间，免费）
- **ARK / Seedance**：`https://ark.cn-beijing.volces.com/api/v3`（创造房间分镜图 + 视频，付费）
- **Codex CLI / GPT-5.5**：`node_modules/@openai/codex/bin/codex.js exec`（数学岛拍照解题，复用 ChatGPT 订阅，零 API 费用）
- **Manim**：`.venv/bin/manim`（数学岛动画渲染，本地 Python 子进程）

环境变量见 `.env.example`。

## 换设备部署

新机器 clone 仓库后，一键 setup：

```bash
bash scripts/setup-kids.sh
```

会做的事：
1. brew 装 ffmpeg / cairo / pango / pkg-config（macOS）
2. 创建 `.venv/` 装 manim（按 `services/storyboard/requirements.txt`）
3. `pnpm install` 装 node_modules（含 codex CLI）
4. 检查 `~/.codex/auth.json`，没登录就提示 `codex login`

**用户级凭证**不在仓库里，每台设备独立：
- `~/.codex/auth.json` — ChatGPT 浏览器登录态（用 `codex login` 重新生成）
- `.env` — `ARK_API_KEY` 等密钥（参考 `.env.example` 填）

启动两个进程（两个终端）：

```bash
# 终端 A：storyboard 后端
node services/storyboard/index.mjs

# 终端 B：Vite dev server
pnpm dev
```

浏览器打开 http://localhost:5173/kids/。
