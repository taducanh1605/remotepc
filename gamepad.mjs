const buttonBits = [0x1000, 0x2000, 0x4000, 0x8000, 0x100, 0x200, 0, 0, 0x20, 0x10, 0x40, 0x80, 1, 2, 4, 8, 0x400];

export function gamepadState(pad, index) {
  if (pad.mapping !== "standard") throw new Error("Only standard-mapped gamepads are supported.");
  const axis = (position, invert = false) => {
    const value = pad.axes[position] ?? 0;
    if (!Number.isFinite(value)) throw new Error("Invalid gamepad axis.");
    const bounded = Math.abs(value) < 0.08 ? 0 : Math.max(-1, Math.min(1, value)) * (invert ? -1 : 1);
    return Math.round(bounded * (bounded < 0 ? 32768 : 32767));
  };
  let buttons = 0;
  for (let i = 0; i < buttonBits.length; ++i) if (pad.buttons[i]?.pressed) buttons |= buttonBits[i];
  const trigger = i => {
    const value = pad.buttons[i]?.value ?? 0;
    if (!Number.isFinite(value)) throw new Error("Invalid gamepad trigger.");
    return Math.round(Math.max(0, Math.min(1, value)) * 255);
  };
  return { type: "gamepad", index, connected: true, buttons,
    leftTrigger: trigger(6), rightTrigger: trigger(7), leftX: axis(0), leftY: axis(1, true), rightX: axis(2), rightY: axis(3, true) };
}

export function installGamepads({ send, available, report, getGamepads = () => navigator.getGamepads?.() || [],
  requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) }) {
  const slots = new Map(), previous = new Map();
  let frame, enabled = false, lastCount;
  function release() {
    for (const index of slots.values()) send({ type: "gamepad", index, connected: false });
    slots.clear();
    previous.clear();
    lastCount = undefined;
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
  }
  function poll() {
    frame = undefined;
    if (!enabled || !available()) { release(); return; }
    const pads = [...getGamepads()].filter(pad => pad?.connected && pad.mapping === "standard");
    for (const [device, slot] of slots) {
      if (!pads.some(pad => pad.index === device)) {
        send({ type: "gamepad", index: slot, connected: false });
        slots.delete(device);
        previous.delete(slot);
      }
    }
    for (const pad of pads) {
      if (!slots.has(pad.index)) {
        const slot = [0, 1, 2, 3].find(index => ![...slots.values()].includes(index));
        if (slot === undefined) continue;
        slots.set(pad.index, slot);
      }
      const slot = slots.get(pad.index);
      try {
        const state = gamepadState(pad, slot), serialized = JSON.stringify(state);
        if (previous.get(slot) !== serialized) { send(state); previous.set(slot, serialized); }
      } catch (error) { report(`Gamepad input failed: ${error.message}`); release(); enabled = false; return; }
    }
    if (lastCount !== slots.size) {
      report(pads.length ? `${slots.size} gamepad(s) connected` : "Press a gamepad button to let the browser detect it.");
      lastCount = slots.size;
    }
    frame = requestFrame(poll);
  }
  return {
    start() { enabled = true; if (frame === undefined) poll(); },
    stop() { enabled = false; release(); },
    release,
    refresh() { previous.clear(); },
    resume() { if (enabled && frame === undefined) poll(); },
  };
}
