import { typingMessages } from "./typing.mjs?v=20261109-accessory";

const modifiers = new Set(["AltLeft", "ControlLeft", "ShiftLeft"]);

export function installKeyboardAccessory(row, send) {
  const held = new Set();
  const pointers = new Map();
  const buttons = [...row.querySelectorAll("button[data-key]")];
  const key = (code, down) => send({ type: "key", code, down });
  function update() {
    for (const button of buttons) {
      if (modifiers.has(button.dataset.key)) button.setAttribute("aria-pressed", String(held.has(button.dataset.key)));
    }
  }
  function release() {
    for (const code of held) key(code, false);
    held.clear();
    pointers.clear();
    update();
  }
  function finish(event, cancelled = false) {
    const press = pointers.get(event.pointerId);
    if (!press) return;
    pointers.delete(event.pointerId);
    if (cancelled || !modifiers.has(press.code) || press.wasHeld || Date.now() - press.start >= 300) {
      if (held.delete(press.code)) key(press.code, false);
    }
    update();
  }
  for (const button of buttons) {
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || [...pointers.values()].some(press => press.code === button.dataset.key)) return;
      event.preventDefault(); // Keep the mobile editor and IME focused.
      const code = button.dataset.key;
      pointers.set(event.pointerId, { code, wasHeld: held.has(code), start: Date.now() });
      if (!held.has(code)) { held.add(code); key(code, true); }
      button.setPointerCapture(event.pointerId);
      update();
    });
    button.addEventListener("pointerup", event => finish(event));
    button.addEventListener("pointercancel", event => finish(event, true));
    button.addEventListener("lostpointercapture", event => finish(event, true));
    button.addEventListener("click", event => {
      // Android Chrome can emit a touch click with detail=0 after pointerup.
      // Only keyboard/assistive activation should use this fallback.
      if (event.detail !== 0 || event.pointerType || event.sourceCapabilities?.firesTouchEvents) return;
      const code = button.dataset.key;
      if (modifiers.has(code)) {
        if (held.delete(code)) key(code, false);
        else { held.add(code); key(code, true); }
        update();
      } else { key(code, true); key(code, false); }
    });
  }
  return {
    release,
    text(text, mode) {
      typingMessages(text, [...held].some(code => modifiers.has(code)) ? "host" : mode, held).forEach(send);
    },
  };
}
