export function installVideoTransition(video, shell, report) {
  const overlay = document.createElement("canvas");
  overlay.id = "resize-preview";
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
  shell.insertBefore(overlay, video.nextSibling);
  const context = overlay.getContext("2d");
  const probe = document.createElement("canvas");
  probe.width = probe.height = 16;
  const pixels = probe.getContext("2d", { willReadFrequently: true });
  let pending, frame, timeout, fade;
  function cancel() {
    pending = undefined;
    clearTimeout(timeout);
    clearTimeout(fade);
    if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
    frame = undefined;
    overlay.hidden = true;
    overlay.classList.remove("fading");
  }
  function watch() {
    if (!pending || !video.requestVideoFrameCallback) return;
    frame = video.requestVideoFrameCallback((_now, metadata) => {
      frame = undefined;
      if (!pending) return;
      if (pending.ready && metadata.width === pending.width && metadata.height === pending.height) {
        pixels.drawImage(video, 0, 0, 16, 16);
        const data = pixels.getImageData(0, 0, 16, 16).data;
        const visible = data.some((value, index) => index % 4 !== 3 && value > 20);
        if (visible || !pending.wasVisible) {
          pending = undefined;
          clearTimeout(timeout);
          overlay.classList.add("fading");
          fade = setTimeout(cancel, 150);
          return;
        }
      }
      watch();
    });
  }
  return {
    begin({ width, height }) {
      if (video.readyState < 2 || !video.videoWidth || !context || !pixels || !video.requestVideoFrameCallback) return;
      // Keep the last good picture across repeated requests, not a startup black frame.
      if (!pending) {
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;
        context.drawImage(video, 0, 0);
      }
      pixels.drawImage(overlay, 0, 0, 16, 16);
      const data = pixels.getImageData(0, 0, 16, 16).data;
      const wasVisible = data.some((value, index) => index % 4 !== 3 && value > 20);
      if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
      clearTimeout(timeout);
      clearTimeout(fade);
      pending = { width, height, ready: false, wasVisible };
      overlay.classList.remove("fading");
      overlay.hidden = false;
      timeout = setTimeout(() => {
        cancel();
        report("The display is taking longer to resize. Waiting for live video.");
      }, 8000);
      watch();
    },
    ready() { if (pending) pending.ready = true; },
    cancel,
  };
}
