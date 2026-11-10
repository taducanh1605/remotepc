import test from "node:test";
import assert from "node:assert/strict";
import { installKeyboardAccessory } from "./keyboard-accessory.mjs";

function fixture() {
  const sent = [], buttons = {};
  for (const code of ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "AltLeft", "ControlLeft", "ShiftLeft", "MetaLeft", "CapsLock", "Delete"]) {
    const listeners = {};
    buttons[code] = {
      dataset: { key: code }, attributes: {},
      addEventListener(name, callback) { listeners[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      setPointerCapture() {},
      fire(name, pointerId = 1) {
        listeners[name]({ pointerId, button: 0, detail: 1, preventDefault() {} });
      },
      activate() { listeners.click({ detail: 0 }); },
      touchClick() { listeners.click({ detail: 0, sourceCapabilities: { firesTouchEvents: true } }); },
    };
  }
  const accessory = installKeyboardAccessory({ querySelectorAll: () => Object.values(buttons) }, message => sent.push(message));
  return { sent, buttons, accessory };
}

test("all six non-modifiers send balanced down/up without changing editor focus", () => {
  for (const code of ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
    const { sent, buttons } = fixture();
    buttons[code].fire("pointerdown");
    buttons[code].fire("pointerup");
    buttons[code].fire("lostpointercapture");
    assert.deepEqual(sent, [{ type: "key", code, down: true }, { type: "key", code, down: false }]);
  }
});

test("latched Ctrl combines with mobile Unicode-mode ASCII commits", () => {
  const { sent, buttons, accessory } = fixture();
  buttons.ControlLeft.fire("pointerdown");
  buttons.ControlLeft.fire("pointerup");
  buttons.ControlLeft.touchClick();
  accessory.text("a", "unicode");
  buttons.ControlLeft.activate();
  assert.deepEqual(sent.map(message => [message.code, message.down]), [
    ["ControlLeft", true], ["KeyA", true], ["KeyA", false], ["ControlLeft", false],
  ]);
  assert.equal(buttons.ControlLeft.attributes["aria-pressed"], "false");
});

test("Shift stays held across uppercase, multiple modifiers and navigation", () => {
  const { sent, buttons, accessory } = fixture();
  buttons.ShiftLeft.activate();
  buttons.ControlLeft.activate();
  accessory.text("A", "host");
  buttons.ArrowLeft.activate();
  assert.equal(sent.filter(message => message.code === "ShiftLeft").length, 1);
  accessory.release();
  assert.deepEqual(sent.slice(-2).map(message => [message.code, message.down]), [["ShiftLeft", false], ["ControlLeft", false]]);
});

test("latched Shift also applies to ASCII committed in Unicode mode", () => {
  const { sent, buttons, accessory } = fixture();
  buttons.ShiftLeft.activate();
  accessory.text("a", "unicode");
  assert.deepEqual(sent.map(message => message.code), ["ShiftLeft", "KeyA", "KeyA"]);
});

test("cancel, blur/disconnect release and accessibility activation cannot leave stuck keys", () => {
  const { sent, buttons, accessory } = fixture();
  buttons.AltLeft.fire("pointerdown");
  buttons.AltLeft.fire("pointercancel");
  buttons.ArrowUp.fire("pointerdown", 7);
  accessory.release();
  buttons.ArrowUp.fire("pointerup", 7);
  accessory.release();
  assert.deepEqual(sent.map(message => message.down), [true, false, true, false]);
});

test("different pointers can hold a modifier and navigation together", () => {
  const { sent, buttons } = fixture();
  buttons.ControlLeft.fire("pointerdown", 3);
  buttons.ArrowRight.fire("pointerdown", 9);
  buttons.ArrowRight.fire("pointerup", 9);
  buttons.ControlLeft.fire("pointercancel", 3);
  assert.deepEqual(sent.map(message => [message.code, message.down]), [
    ["ControlLeft", true], ["ArrowRight", true], ["ArrowRight", false], ["ControlLeft", false],
  ]);
});

test("long press latches every extra key until its next tap releases it", t => {
  let time = 0;
  t.mock.method(Date, "now", () => time);
  for (const code of ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "AltLeft", "ControlLeft", "ShiftLeft", "MetaLeft", "CapsLock", "Delete"]) {
    const { sent, buttons } = fixture();
    buttons[code].fire("pointerdown");
    time += 2000;
    buttons[code].fire("pointerup");
    buttons[code].fire("lostpointercapture");
    buttons[code].touchClick();
    assert.deepEqual(sent, [{ type: "key", code, down: true }], code);
    assert.equal(buttons[code].attributes["aria-pressed"], "true");
    buttons[code].fire("pointerdown");
    buttons[code].fire("pointerup");
    assert.deepEqual(sent.at(-1), { type: "key", code, down: false });
    assert.equal(sent.length, 2);
    assert.equal(buttons[code].attributes["aria-pressed"], "false");
  }
});

test("accessibility activation can release a long-held non-modifier and WIN participates in shortcuts", t => {
  let time = 0;
  t.mock.method(Date, "now", () => time);
  const { sent, buttons, accessory } = fixture();
  buttons.Delete.fire("pointerdown");
  time += 2000;
  buttons.Delete.fire("pointerup");
  buttons.Delete.activate();
  buttons.MetaLeft.activate();
  accessory.text("r", "unicode");
  accessory.release();
  assert.deepEqual(sent.map(message => [message.code, message.down]), [
    ["Delete", true], ["Delete", false], ["MetaLeft", true], ["KeyR", true], ["KeyR", false], ["MetaLeft", false],
  ]);
});
