import test from "node:test";
import assert from "node:assert/strict";
import { shortcutMessages, lockedPointer, installImmersive } from "./immersive.mjs";

test("remote shortcuts release keys in reverse order and exclude secure sequence",()=>{
  assert.deepEqual(shortcutMessages("alt-tab"),[
    {type:"key",code:"AltLeft",down:true},{type:"key",code:"Tab",down:true},
    {type:"key",code:"Tab",down:false},{type:"key",code:"AltLeft",down:false}
  ]);
  assert.equal(shortcutMessages("win")[0].code,"MetaLeft");
  assert.equal(shortcutMessages("escape")[0].code,"Escape");
  assert.throws(()=>shortcutMessages("ctrl-alt-delete"),/Unsupported/);
});
test("locked pointer stays bounded with relative motion and invalid viewport",()=>{
  assert.deepEqual(lockedPointer({x:.5,y:.5},25,-25,100,100),{x:.75,y:.25});
  assert.deepEqual(lockedPointer({x:.5,y:.5},500,-500,0,0),{x:1,y:0});
});

test("Keyboard menu toggles keyboard intent even when touch has already unhidden the quiet input", () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, open: true, handlers: {},
      getAttribute: name => name === "aria-pressed" ? pressed : retry, addEventListener(type, handler) { this.handlers[type] = handler; },
      focus() {}, style: {} });
    return elements.get(id);
  };
  let pressed = "false";
  let retry = "false";
  const calls = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: element, querySelectorAll: () => [], addEventListener() {},
  } });
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {} } });
  try {
    installImmersive({ send() {}, release() {}, screen: element("screen"), available: () => true,
      setKeyboard(visible) { calls.push(visible); pressed = String(visible); retry = "false"; } });
    element("soft-keyboard").handlers.click();
    assert.deepEqual(calls, [true]);
    assert.equal(element("stream-tools").open, false);
    element("soft-keyboard").handlers.click();
    assert.deepEqual(calls, [true, false]);
    pressed = retry = "true";
    element("soft-keyboard").handlers.click();
    assert.deepEqual(calls, [true, false, true]);
    element("soft-keyboard").handlers.click();
    assert.deepEqual(calls, [true, false, true, false]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else delete globalThis.window;
  }
});

async function withImmersive(run) {
  const elements = new Map(), classes = new Set(), listeners = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, style: {}, handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; }, focus() {} });
    return elements.get(id);
  };
  const state = { requests: 0, locks: 0, blocked: false, ready: true };
  const document = {
    getElementById: element, querySelectorAll: () => [],
    addEventListener(type, handler) { listeners.set(type, handler); },
    body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    fullscreenElement: null,
    async exitFullscreen() { this.fullscreenElement = null; },
  };
  element("stream-shell").requestFullscreen = async () => {
    state.requests++;
    if (state.blocked) throw new Error("User activation required");
    document.fullscreenElement = element("stream-shell");
  };
  const descriptors = new Map(["document", "window", "navigator"].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: document },
    window: { configurable: true, value: { addEventListener() {} } },
    navigator: { configurable: true, value: { keyboard: {
      async lock() { state.locks++; }, unlock() {},
    } } },
  });
  try {
    const immersive = installImmersive({ send() {}, release() {}, screen: element("screen"),
      available: () => state.ready, setKeyboard() {} });
    await run({ immersive, state, document, element, classes, listeners });
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
}

test("ESPWake auto immersive acquires keyboard capture when preconnect already entered fullscreen", async () => {
  await withImmersive(async ({ immersive, state, document, classes }) => {
    document.fullscreenElement = {};
    state.ready = false; // WebRTC's input channel may still be opening.
    await immersive.connected({ autoEnter: true });
    assert.equal(state.requests, 0);
    assert.equal(state.locks, 1);
    assert.equal(classes.has("immersive"), true);
  });
});

test("automatic immersive requests fullscreen without another click when permitted", async () => {
  await withImmersive(async ({ immersive, state, classes }) => {
    await immersive.connected({ autoEnter: true });
    assert.equal(state.requests, 1);
    assert.equal(state.locks, 1);
    assert.equal(classes.has("immersive"), true);
  });
});

test("blocked automatic fullscreen keeps immersive active and retries on first stream gesture", async () => {
  await withImmersive(async ({ immersive, state, element, classes }) => {
    state.blocked = true;
    await immersive.connected({ autoEnter: true });
    assert.equal(classes.has("immersive"), true);
    assert.match(element("capture-status").textContent, /Tap the stream/);
    state.blocked = false;
    element("stream-shell").handlers.pointerdown();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.requests, 2);
    assert.equal(state.locks, 1);
    element("stream-shell").handlers.pointerdown();
    assert.equal(state.requests, 2, "normal input must not repeatedly request fullscreen");
  });
});

test("manual default remains nonimmersive and disconnect cancels fullscreen retry", async () => {
  await withImmersive(async ({ immersive, state, element, classes }) => {
    await immersive.connected();
    assert.equal(state.requests, 0);
    assert.equal(classes.has("immersive"), false);
    state.blocked = true;
    await immersive.connected({ autoEnter: true });
    await immersive.disconnected();
    element("stream-shell").handlers.pointerdown();
    assert.equal(state.requests, 1);
    assert.equal(classes.has("immersive"), false);
    assert.equal(element("stream-tools").hidden, true);
  });
});

test("exiting fullscreen cancels automatic immersive until explicitly requested again", async () => {
  await withImmersive(async ({ immersive, state, document, element, classes, listeners }) => {
    await immersive.connected({ autoEnter: true });
    document.fullscreenElement = null;
    listeners.get("fullscreenchange")();
    element("stream-shell").handlers.pointerdown();
    assert.equal(state.requests, 1);
    assert.equal(classes.has("immersive"), false);
  });
});
