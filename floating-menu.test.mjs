import test from "node:test";
import assert from "node:assert/strict";
import { menuPosition } from "./floating-menu.mjs";

test("floating menu starts on the left and clamps inside portrait, landscape and IME space", () => {
  assert.deepEqual(menuPosition(undefined, 320, 640), { x: 8, y: 8 });
  assert.deepEqual(menuPosition({ x: 900, y: 900 }, 320, 640), { x: 274, y: 594 });
  assert.deepEqual(menuPosition({ x: -40, y: -10 }, 320, 640), { x: 0, y: 0 });
  assert.deepEqual(menuPosition({ x: 500, y: 300 }, 640, 100), { x: 500, y: 54 });
  assert.deepEqual(menuPosition({ x: 500, y: 300 }, 320, 640, 318, 400), { x: 2, y: 240 });
  assert.deepEqual(menuPosition({ x: 8, y: 8 }, 20, 20), { x: 0, y: 0 });
});
