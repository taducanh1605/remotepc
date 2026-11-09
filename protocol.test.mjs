import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticBitrate,
  coalescedPointerEvent,
  hostEndpoint,
  isTransientNetworkError,
  nextContactGeneration,
  pointerControl,
  pointerPosition,
  playDesktop,
  requestFullscreenInGesture,
  viewportDimensions,
  visibleViewport,
} from "./protocol.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("blocked audio autoplay still starts video without a touch", async () => {
  const video = { muted: false, calls: 0, async play() {
    this.calls++;
    if (!this.muted) throw new DOMException("Gesture required", "NotAllowedError");
  } };
  assert.equal(await playDesktop(video), true);
  assert.equal(video.calls, 2);
  video.play = async () => {};
  assert.equal(await playDesktop(video, true), false);
});

test("decoder and interrupted-play errors are not hidden as autoplay success", async () => {
  for (const name of ["NotSupportedError", "AbortError"]) {
    const video = { muted: false, async play() { throw new DOMException("Unable to play", name); } };
    await assert.rejects(playDesktop(video), { name });
    assert.equal(video.muted, false);
  }
});

test("automatic quality budgets scale with pixels and FPS up to 20 Mbps", () => {
  assert.equal(automaticBitrate(374, 900, 60), 3366);
  assert.equal(automaticBitrate(1920, 1080, 60), 20000);
  assert.equal(automaticBitrate(320, 240, 60), 2000);
  assert.equal(automaticBitrate(748, 1800, 60), 13464);
  assert.ok(automaticBitrate(374, 900, 30) < automaticBitrate(374, 900, 60));
});

test("signaling accepts only HTTPS origins", () => {
  assert.equal(hostEndpoint("https://host.example:47990"), "https://host.example:47990/v1/session");
  for (const value of ["http://host", "https://user:secret@host", "https://host/path", "https://host/?token=secret", "https://host/#token"]) {
    assert.throws(() => hostEndpoint(value));
  }
});
test("visual viewport and overlaid keyboard are subtracted once without an offset strip", () => {
  assert.deepEqual(visibleViewport({width:390,height:440,offsetTop:24},{width:390,height:844},{y:464,height:380}), {width:390,height:440});
  assert.deepEqual(visibleViewport({width:390,height:844,offsetTop:0},{width:390,height:844},{y:464,height:380}), {width:390,height:464});
  assert.deepEqual(visibleViewport({width:390,height:440},{width:390,height:440}), {width:390,height:440});
  assert.deepEqual(visibleViewport(undefined,{width:844,height:390}), {width:844,height:390});
});
test("Android overlay with a system-inset origin preserves the real remaining viewport", () => {
  assert.deepEqual(visibleViewport({width:320,height:536},{width:320,height:536},{y:24,height:235}), {width:320,height:301});
  assert.deepEqual(visibleViewport({width:640,height:216},{width:640,height:216},{y:0,height:146}), {width:640,height:70});
  assert.deepEqual(visibleViewport({width:390,height:440,offsetTop:24},{width:390,height:844},{y:24,height:380}), {width:390,height:440});
});
test("viewport sizes are even, bounded and rotated", () => {
  for (const viewport of [{width: 390, height: 844}, {width: 844, height: 390}, {width: 7680, height: 4320}, {width: 100, height: 100}]) {
    const { width, height } = viewportDimensions(viewport, 3);
    assert.ok(width >= 320 && width <= 3840 && height >= 240 && height <= 2160);
    assert.equal(width % 2, 0);
    assert.equal(height % 2, 0);
  }
});
test("pointer coordinates match top-aligned video and exclude lower letterboxing", () => {
  const video = {videoWidth: 1920, videoHeight: 1080, getBoundingClientRect: () => ({left: 0, top: 0, width: 1000, height: 1000})};
  assert.deepEqual(pointerPosition({clientX: 500, clientY: 281.25}, video), {x: .5, y: .5});
  assert.deepEqual(pointerPosition({clientX: 500, clientY: 0}, video), {x: .5, y: 0});
  assert.equal(pointerPosition({clientX: 500, clientY: 600}, video), null);
});
test("fullscreen is invoked synchronously when the user selected it", async () => {
  const calls = [];
  const element = { requestFullscreen: () => { calls.push("request"); return Promise.resolve(); } };
  const request = requestFullscreenInGesture(element, true);
  assert.deepEqual(calls, ["request"]);
  assert.equal(await request, true);
  assert.equal(await requestFullscreenInGesture(element, false), false);
});
test("native contact generations and touch movement retain independent pointer IDs", () => {
  const video = {videoWidth: 100, videoHeight: 100, getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 100})};
  const touch = (pointerId, phase, generation) => pointerControl({
    pointerId, clientX: 25, clientY: 75, pressure: .6,
  }, video, "touch", phase, generation);
  assert.equal(nextContactGeneration(0), 1);
  assert.equal(nextContactGeneration(1), 2);
  assert.deepEqual(touch(4, "down", 1), {
    type: "touch", phase: "down", id: 4, generation: 1, x: .25, y: .75, pressure: .6,
  });
  assert.equal(touch(5, "move", 1).id, 5);
});
test("stylus controls preserve pressure, tilt, barrel and eraser metadata", () => {
  const video = {videoWidth: 100, videoHeight: 100, getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 100})};
  const pen = pointerControl({
    pointerId: 8, clientX: 50, clientY: 50, pressure: .75, tiltX: 30, tiltY: -40, twist: 190, buttons: 2,
  }, video, "pen", "move", 3);
  assert.deepEqual(pen, {
    type: "pen", phase: "move", id: 8, generation: 3, x: .5, y: .5, pressure: .75,
    tilt: 46, rotation: 215, tool: "pen", buttons: 1,
  });
  const rotation = pen.rotation * Math.PI / 180, tilt = pen.tilt * Math.PI / 180;
  const nativeTiltX = Math.atan2(Math.sin(-rotation) * Math.sin(tilt), Math.cos(tilt)) * 180 / Math.PI;
  const nativeTiltY = Math.atan2(Math.cos(-rotation) * Math.sin(tilt), Math.cos(tilt)) * 180 / Math.PI;
  assert.ok(Math.abs(nativeTiltX - 30) < 1);
  assert.ok(Math.abs(nativeTiltY + 40) < 1);
  assert.equal(pointerControl({
    pointerId: 8, clientX: 50, clientY: 50, pressure: 0, tiltX: 0, tiltY: 0, twist: 0, button: 5, buttons: 32,
  }, video, "pen", "down", 4).tool, "eraser");
});
test("coalesced pointer motion keeps the newest sample and network failures are contextualized", () => {
  const samples = [{clientX: 1}, {clientX: 2}];
  assert.equal(coalescedPointerEvent({getCoalescedEvents: () => samples}), samples[1]);
  assert.equal(coalescedPointerEvent({clientX: 3}).clientX, 3);
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);
  assert.equal(isTransientNetworkError(new Error("bad response")), false);
});
test("microphone worklet emits exact mono PCM16LE 20ms frames", () => {
  let Processor;
  const packets = [];
  const code = readFileSync(new URL("./microphone-worklet.js", import.meta.url), "utf8");
  vm.runInNewContext(code, {
    AudioWorkletProcessor: class { constructor() { this.port = {postMessage: (buffer) => packets.push(buffer)}; } },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
    Int16Array, ArrayBuffer, DataView, Math,
  });
  const processor = new Processor();
  for (let i = 0; i < 8; i++) processor.process([[new Float32Array(128).fill(1), new Float32Array(128).fill(-.5)]]);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].byteLength, 1920);
  const pcm = new DataView(packets[0]);
  assert.equal(pcm.getInt16(0, true), 8192);
  assert.equal(pcm.getInt16(1918, true), 8192);
});
