export function menuPosition(position, width, height, menuWidth = 46, menuHeight = 46) {
  const maxX = Math.max(0, width - menuWidth), maxY = Math.max(0, height - menuHeight);
  return {
    x: Math.max(0, Math.min(maxX, position?.x ?? 8)),
    y: Math.max(0, Math.min(maxY, position?.y ?? 8)),
  };
}

export function installFloatingMenu(menu, shell, report) {
  const handle = menu.querySelector("summary");
  const key = "njk-menu-position";
  let position, drag, suppressClick = false;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) &&
        saved.x >= 0 && saved.x <= 1 && saved.y >= 0 && saved.y <= 1) position = saved;
  } catch (error) { report(`Menu position could not be restored: ${error.message}`); }
  function place(point) {
    const rect = shell.getBoundingClientRect();
    const bounds = menuPosition(point, rect.width, rect.height, menu.offsetWidth, menu.offsetHeight);
    menu.style.left = `${bounds.x}px`;
    menu.style.top = `${bounds.y}px`;
    return bounds;
  }
  function restore() {
    const rect = shell.getBoundingClientRect();
    place(position ? { x: position.x * Math.max(0, rect.width - 46), y: position.y * Math.max(0, rect.height - 46) } : undefined);
  }
  function save(point) {
    const rect = shell.getBoundingClientRect();
    position = { x: point.x / Math.max(1, rect.width - 46), y: point.y / Math.max(1, rect.height - 46) };
    try { localStorage.setItem(key, JSON.stringify(position)); }
    catch (error) { report(`Menu position could not be saved: ${error.message}`); }
  }
  handle.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = menu.getBoundingClientRect(), parent = shell.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left - parent.left, top: rect.top - parent.top, moved: false };
    suppressClick = false;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    suppressClick = true;
    menu.open = false;
    place({ x: drag.left + dx, y: drag.top + dy });
    event.preventDefault();
  });
  function end(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved) save(place({ x: parseFloat(menu.style.left), y: parseFloat(menu.style.top) }));
    drag = undefined;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  }
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("lostpointercapture", () => { drag = undefined; });
  handle.addEventListener("click", event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  });
  handle.addEventListener("keydown", event => {
    const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
    if (!delta && event.key !== "Home") return;
    event.preventDefault();
    menu.open = false;
    const rect = menu.getBoundingClientRect(), parent = shell.getBoundingClientRect();
    save(place(delta ? { x: rect.left - parent.left + delta[0], y: rect.top - parent.top + delta[1] } : { x: 8, y: 8 }));
  });
  menu.addEventListener("toggle", restore);
  const observer = new ResizeObserver(restore);
  observer.observe(shell);
  restore();
}
