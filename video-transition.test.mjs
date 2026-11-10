import test from "node:test";
import assert from "node:assert/strict";
import { installVideoTransition } from "./video-transition.mjs";

function fixture(t) {
  const canvases = [], timers = new Map(), messages = [];
  let livePixel = 80, callback, timer = 0;
  const video = {
    readyState: 2, videoWidth: 720, videoHeight: 1280,
    requestVideoFrameCallback(fn) { callback = fn; return 1; },
    cancelVideoFrameCallback() { callback = undefined; },
  };
  t.mock.method(globalThis, "setTimeout", fn => { timers.set(++timer, fn); return timer; });
  t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement() {
      const classes = new Set(), canvas = { hidden: false, value: 0,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        setAttribute() {},
        getContext: () => ({
          drawImage: source => { canvas.value = source === video ? livePixel : source.value; },
          getImageData: () => ({ data: new Uint8ClampedArray([canvas.value, canvas.value, canvas.value, 255]) }),
        }),
      };
      canvases.push(canvas);
      return canvas;
    },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  const transition = installVideoTransition(video, { insertBefore() {} }, text => messages.push(text));
  return { transition, overlay: canvases[0], messages, timers,
    frame(width, height, pixel = 80) { livePixel = pixel; const fn = callback; callback = undefined; fn?.(0, { width, height }); },
  };
}

test("resize retains last picture until acknowledgment and a nonblack frame of the requested mode", t => {
  const { transition, overlay, frame, timers } = fixture(t);
  transition.begin({ width: 1280, height: 720 });
  assert.equal(overlay.hidden, false);
  frame(1280, 720);
  assert.equal(overlay.classList.contains("fading"), false);
  transition.ready();
  frame(720, 1280);
  frame(1280, 720, 0);
  assert.equal(overlay.classList.contains("fading"), false);
  frame(1280, 720, 100);
  assert.equal(overlay.classList.contains("fading"), true);
  [...timers.values()][0]();
  assert.equal(overlay.hidden, true);
});

test("superseding requests do not copy startup black over a retained frame; cancellation cleans timers", t => {
  const { transition, overlay, frame, timers } = fixture(t);
  transition.begin({ width: 1280, height: 720 });
  frame(1280, 720, 0);
  transition.begin({ width: 1600, height: 900 });
  assert.equal(overlay.value, 80);
  transition.cancel();
  assert.equal(timers.size, 0);
  assert.equal(overlay.hidden, true);
});

test("timeout exposes slow transitions rather than claiming the frozen picture is live", t => {
  const { transition, overlay, messages, timers } = fixture(t);
  transition.begin({ width: 1280, height: 720 });
  [...timers.values()][0]();
  assert.equal(overlay.hidden, true);
  assert.match(messages[0], /taking longer/);
});
