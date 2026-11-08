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

export function requestFullscreenInGesture(element, enabled) {
  if (!enabled) return Promise.resolve(false);
  if (typeof element.requestFullscreen !== "function") {
    return Promise.reject(new Error("Fullscreen is unavailable in this browser."));
  }
  try {
    return Promise.resolve(element.requestFullscreen()).then(() => true);
  } catch (error) {
    return Promise.reject(error);
  }
}

export function nextContactGeneration(previous = 0) {
  return previous + 1;
}

export function pointerControl(event, video, type, phase, generation) {
  const position = pointerPosition(event, video);
  if (!position) return null;
  const control = {
    type,
    phase,
    id: event.pointerId,
    generation,
    ...position,
    pressure: Math.max(0, Math.min(1, Number.isFinite(event.pressure) ? event.pressure : 0)),
  };
  if (type === "pen") {
    const tiltX = Number.isFinite(event.tiltX) ? event.tiltX : 0;
    const tiltY = Number.isFinite(event.tiltY) ? event.tiltY : 0;
    control.tilt = Math.min(90, Math.round(Math.hypot(tiltX, tiltY)));
    control.rotation = Number.isFinite(event.twist) ? Math.max(0, Math.min(359, Math.round(event.twist))) : 0;
    control.tool = event.button === 5 || (event.buttons & 32) ? "eraser" : "pen";
    control.buttons = event.buttons & 2 ? 1 : 0;
  }
  return control;
}

export function coalescedPointerEvent(event) {
  const coalesced = event.getCoalescedEvents?.();
  return coalesced?.length ? coalesced[coalesced.length - 1] : event;
}

export function isTransientNetworkError(error) {
  return error instanceof TypeError || error?.name === "TimeoutError" || error?.name === "AbortError";
}
