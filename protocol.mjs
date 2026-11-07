export function hostEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Enter an HTTPS host origin with no path, credentials, query or fragment.");
  }
  return `${url.origin}/v1/session`;
}

export function viewportDimensions(viewport, pixelRatio = 1) {
  const ratio = Math.min(2, Math.max(1, pixelRatio));
  const scale = Math.min(1, 3840 / (viewport.width * ratio), 2160 / (viewport.height * ratio));
  return {
    width: Math.max(320, Math.floor(viewport.width * ratio * scale / 2) * 2),
    height: Math.max(240, Math.floor(viewport.height * ratio * scale / 2) * 2),
  };
}

export function pointerPosition(event, video) {
  const rect = video.getBoundingClientRect();
  const aspect = video.videoWidth / video.videoHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  const width = Math.min(rect.width, rect.height * aspect);
  const height = width / aspect;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}
