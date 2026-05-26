#!/usr/bin/env python3
"""
cat-bg-remove.py

把 cat-live2d/*.mp4 里的白色背景抠掉（只抠和边界相连的白色，
保留猫身上的白色细节），输出每帧 PNG，然后用 ffmpeg 合成
带 alpha 通道的 WebM。
"""

import os
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent.parent
SRC_DIR = ROOT / "ui/public/kids/assets/cat/live2d"
THRESHOLD = 235          # 白色阈值（>= 算白）
EDGE_WIDTH = 2           # 边缘膨胀宽度（清除毛刺）

def floodfill_white(rgb_img):
    """从四条边的所有白色像素出发 floodfill，得到连通到边界的白区 mask"""
    arr = np.array(rgb_img)              # H, W, 3
    h, w = arr.shape[:2]

    # 「白色」掩码：RGB 三通道都 >= threshold
    white_mask = np.all(arr >= THRESHOLD, axis=2)  # H, W bool

    # 用 PIL 做 floodfill。先创建一张工作图：白=1 黑=0
    work = Image.fromarray((white_mask.astype(np.uint8)) * 255, mode="L")

    # 从四条边的每个白色像素 floodfill
    seeds = []
    edge_white = np.zeros_like(white_mask)
    edge_white[0, :]    = white_mask[0, :]
    edge_white[-1, :]   = white_mask[-1, :]
    edge_white[:, 0]    = white_mask[:, 0]
    edge_white[:, -1]   = white_mask[:, -1]
    ys, xs = np.where(edge_white)
    if len(xs) == 0:
        return np.zeros_like(white_mask)

    # 把所有边界白像素都设为 floodfill 起点
    bg_mask = np.zeros((h, w), dtype=bool)
    # 起点用四条边上的所有白色像素
    for y in range(h):
        if white_mask[y, 0]:    bg_mask[y, 0] = True
        if white_mask[y, w-1]:  bg_mask[y, w-1] = True
    for x in range(w):
        if white_mask[0, x]:    bg_mask[0, x] = True
        if white_mask[h-1, x]:  bg_mask[h-1, x] = True

    # BFS 连通扩散（只在 white_mask 内）
    from collections import deque
    q = deque()
    for y, x in zip(*np.where(bg_mask)):
        q.append((y, x))

    while q:
        y, x = q.popleft()
        for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
            ny, nx = y+dy, x+dx
            if 0 <= ny < h and 0 <= nx < w and white_mask[ny, nx] and not bg_mask[ny, nx]:
                bg_mask[ny, nx] = True
                q.append((ny, nx))

    return bg_mask  # True = 背景白，要变透明

def process_video(name):
    src = SRC_DIR / f"{name}.mp4"
    dst = SRC_DIR / f"{name}.webm"
    print(f"\n=== {name} ===")
    if not src.exists():
        print(f"  跳过 {src} 不存在")
        return

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        # 1) 抽帧
        print("  [1/3] 抽帧 mp4 → png")
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-vf", "fps=24", str(tmp_path / "f_%04d.png")],
            check=True, capture_output=True,
        )

        # 2) 每帧处理：floodfill 白色 → 透明
        frames = sorted(tmp_path.glob("f_*.png"))
        print(f"  [2/3] 处理 {len(frames)} 帧")
        for i, fp in enumerate(frames):
            img = Image.open(fp).convert("RGB")
            bg_mask = floodfill_white(img)
            # 转 RGBA，背景部分 alpha 设 0
            arr = np.array(img)
            alpha = np.where(bg_mask, 0, 255).astype(np.uint8)
            rgba = np.dstack([arr, alpha])
            Image.fromarray(rgba, mode="RGBA").save(fp)
            if (i + 1) % 30 == 0:
                print(f"    {i+1}/{len(frames)}")

        # 3) 合成 WebM with alpha
        print("  [3/3] 合成 webm")
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-framerate", "24",
                "-i", str(tmp_path / "f_%04d.png"),
                "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
                "-b:v", "1500k", "-auto-alt-ref", "0",
                str(dst),
            ],
            check=True, capture_output=True,
        )
        print(f"  ✅ {dst.name} ({dst.stat().st_size // 1024} KB)")

if __name__ == "__main__":
    for name in ["idle", "listening", "thinking", "speaking", "happy"]:
        try:
            process_video(name)
        except Exception as e:
            print(f"  ❌ {name}: {e}")
    print("\n=== 完成 ===")
