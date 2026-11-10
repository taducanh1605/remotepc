import test from "node:test";
import assert from "node:assert/strict";
import { gamepadState, installGamepads } from "./gamepad.mjs";
import { typingMessages } from "./typing.mjs";

const pad = (index = 0) => ({ index, connected: true, mapping: "standard", axes: [1, -1, -1, 1],
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0 || i === 12, value: i === 6 ? 0.5 : 0 })) });

test("standard gamepad maps XInput buttons, triggers, ranges and inverted Y axes", () => {
  assert.deepEqual(gamepadState(pad(), 0), { type: "gamepad", index: 0, connected: true, buttons: 0x1001,
    leftTrigger: 128, rightTrigger: 0, leftX: 32767, leftY: 32767, rightX: -32768, rightY: -32768 });
  const center = pad();
  center.axes = [0.01, -0.02, 0, 0];
  assert.equal(gamepadState(center, 0).leftX, 0);
  center.axes[0] = NaN;
  assert.throws(() => gamepadState(center, 0), /axis/);
  center.axes[0] = 0;
  center.buttons[6].value = Infinity;
  assert.throws(() => gamepadState(center, 0), /trigger/);
});

test("gamepad poll deduplicates state, frees unplugged slots and releases all on blur/disconnect", () => {
  let pads = [pad(7)], active = true, scheduled;
  const sent = [];
  const controller = installGamepads({ send: value => sent.push(value), available: () => active,
    getGamepads: () => pads, report() {}, requestFrame: callback => { scheduled = callback; return 1; }, cancelFrame: () => { scheduled = undefined; } });
  const advance = () => { const callback = scheduled; scheduled = undefined; callback(); };
  controller.start();
  assert.equal(sent.length, 1);
  advance();
  assert.equal(sent.length, 1);
  pads = [];
  advance();
  assert.deepEqual(sent.at(-1), { type: "gamepad", index: 0, connected: false });
  pads = [pad(3)];
  advance();
  active = false;
  advance();
  assert.equal(sent.at(-1).connected, false);
  assert.equal(scheduled, undefined);
  controller.stop();
});

test("legacy Host release resends held state without cancelling polling or forgetting controller slots", () => {
  const sent = [];
  let scheduled;
  const controller = installGamepads({ send: value => sent.push(value), available: () => true,
    getGamepads: () => [pad(7)], report() {}, requestFrame: fn => { scheduled = fn; return 1; }, cancelFrame() {} });
  controller.start();
  controller.refresh();
  scheduled();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.ok(sent.every(value => value.connected && value.index === 0));
  controller.stop();
});

test("gamepad allocator supports four independent browser slots without collisions", () => {
  const sent = [];
  const controller = installGamepads({ send: value => sent.push(value), available: () => true,
    getGamepads: () => [0, 1, 2, 3, 4].map(pad), report() {}, requestFrame: () => 1, cancelFrame() {} });
  controller.start();
  assert.deepEqual(sent.map(value => value.index), [0, 1, 2, 3]);
  controller.stop();
  assert.equal(sent.filter(value => !value.connected).length, 4);
});

test("host typing sends key edges to UniKey instead of ASCII Unicode injection", () => {
  const messages = typingMessages("tieengs");
  assert.equal(messages.length, 14);
  assert.ok(messages.every(message => message.type === "key"));
  assert.deepEqual(messages.slice(0, 2), [{ type: "key", code: "KeyT", down: true }, { type: "key", code: "KeyT", down: false }]);
  assert.deepEqual(typingMessages("A").map(message => message.code), ["ShiftLeft", "KeyA", "KeyA", "ShiftLeft"]);
  assert.deepEqual(typingMessages("!").map(message => message.code), ["ShiftLeft", "Digit1", "Digit1", "ShiftLeft"]);
});

test("Unicode/mobile IME and non-ASCII committed text preserve accents and emoji", () => {
  assert.deepEqual(typingMessages("Tiếng Việt 😊", "unicode"), [{ type: "text", text: "Tiếng Việt 😊" }]);
  assert.deepEqual(typingMessages("ế😊"), [{ type: "text", text: "ế😊" }]);
  assert.deepEqual(typingMessages(""), []);
});
