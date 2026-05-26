export function openCameraCapture() {
  return new Promise((resolve) => {
    let stream = null;
    let settled = false;

    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      background:#000;display:flex;flex-direction:column;
      font-family:'ZCOOL KuaiLe','PingFang SC',system-ui,sans-serif;
    `;

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "flex:1;width:100%;min-height:0;object-fit:contain;background:#000;";

    const preview = document.createElement("img");
    preview.style.cssText =
      "flex:1;width:100%;min-height:0;object-fit:contain;background:#000;display:none;";

    const footer = document.createElement("div");
    footer.style.cssText = `
      padding:18px 22px 28px;background:rgba(16,16,32,.92);
      display:flex;flex-direction:column;gap:12px;flex-shrink:0;
    `;

    const errorEl = document.createElement("div");
    errorEl.style.cssText = "display:none;color:#ff8a8a;text-align:center;font-size:14px;";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:12px;";

    function button(label, bg, color) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = `
        flex:1;padding:13px;border-radius:999px;border:0;
        font:700 16px inherit;cursor:pointer;background:${bg};color:${color};
      `;
      return btn;
    }

    const cancelBtn = button("取消", "rgba(255,255,255,.14)", "#fff");
    const snapBtn = button("拍照", "rgba(255,216,59,.95)", "#1a1200");
    const retakeBtn = button("重拍", "rgba(255,255,255,.14)", "#fff");
    const useBtn = button("用这张", "rgba(72,199,100,.9)", "#fff");
    retakeBtn.style.display = "none";
    useBtn.style.display = "none";

    row.append(cancelBtn, snapBtn, retakeBtn, useBtn);
    footer.append(errorEl, row);
    overlay.append(video, preview, footer);
    document.body.appendChild(overlay);

    function cleanup() {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      overlay.remove();
      document.removeEventListener("keydown", onKeyDown);
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function showError(message) {
      errorEl.textContent = message;
      errorEl.style.display = "";
    }

    function showCamera() {
      preview.style.display = "none";
      video.style.display = "";
      cancelBtn.style.display = "";
      snapBtn.style.display = "";
      retakeBtn.style.display = "none";
      useBtn.style.display = "none";
    }

    function takePhoto() {
      if (!video.videoWidth || !video.videoHeight) {
        showError("摄像头还没准备好，请稍等一下");
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        showError("拍照失败，请再试一次");
        return;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      preview.src = canvas.toDataURL("image/jpeg", 0.92);
      video.style.display = "none";
      preview.style.display = "";
      cancelBtn.style.display = "none";
      snapBtn.style.display = "none";
      retakeBtn.style.display = "";
      useBtn.style.display = "";
    }

    function onKeyDown(event) {
      if (event.key === "Escape") finish(null);
    }

    cancelBtn.addEventListener("click", () => finish(null));
    snapBtn.addEventListener("click", takePhoto);
    retakeBtn.addEventListener("click", showCamera);
    useBtn.addEventListener("click", () => finish(preview.src));
    document.addEventListener("keydown", onKeyDown);

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("这个浏览器不支持摄像头");
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();
      } catch (err) {
        console.error("[camera-capture]", err);
        showError(
          err.name === "NotAllowedError"
            ? "摄像头权限被拒绝，请在地址栏允许摄像头访问"
            : err.name === "NotFoundError"
              ? "没有找到摄像头设备"
              : err.name === "NotReadableError"
                ? "摄像头被其他应用占用"
                : `无法打开摄像头：${err.message || err.name}`,
        );
        snapBtn.disabled = true;
      }
    }

    start();
  });
}
