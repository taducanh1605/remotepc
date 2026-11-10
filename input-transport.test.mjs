import test from "node:test";
import assert from "node:assert/strict";
import { separateStreamsSupported, gatherOffer } from "./input-transport.mjs";

test("separate input discovery is authenticated and only a legacy 405 selects the old transport", async () => {
  const original = globalThis.fetch;
  try {
    let request;
    globalThis.fetch = async (...args) => { request = args; return new Response('{"separateStreams":true}'); };
    assert.equal(await separateStreamsSupported("https://host/v1/session", "test-token"), true);
    assert.equal(request[1].headers.Authorization, "Bearer test-token");
    assert.equal(request[1].cache, "no-store");
    globalThis.fetch = async () => new Response("", { status: 405 });
    assert.equal(await separateStreamsSupported("https://host/v1/session", "test-token"), false);
    globalThis.fetch = async () => new Response("", { status: 401 });
    await assert.rejects(separateStreamsSupported("https://host/v1/session", "test-token"), /401/);
    globalThis.fetch = async () => new Response('{}');
    await assert.rejects(separateStreamsSupported("https://host/v1/session", "test-token"), /unsupported/);
    globalThis.fetch = async () => { throw new Error("network unavailable"); };
    await assert.rejects(separateStreamsSupported("https://host/v1/session", "test-token"), /network unavailable/);
  } finally { globalThis.fetch = original; }
});

test("each input/media peer gathers its own offer and cleans up ICE listeners", async () => {
  class Peer extends EventTarget {
    iceGatheringState = "new";
    connectionState = "new";
    async createOffer() { return { type: "offer", sdp: "test" }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
  }
  const media = new Peer(), input = new Peer();
  const gathered = Promise.all([gatherOffer(media), gatherOffer(input)]);
  await new Promise(resolve => setImmediate(resolve));
  media.iceGatheringState = input.iceGatheringState = "complete";
  media.dispatchEvent(new Event("icegatheringstatechange"));
  input.dispatchEvent(new Event("icegatheringstatechange"));
  await gathered;
  const cancelled = new Peer();
  const pending = gatherOffer(cancelled);
  await new Promise(resolve => setImmediate(resolve));
  cancelled.connectionState = "closed";
  cancelled.dispatchEvent(new Event("connectionstatechange"));
  await assert.rejects(pending, /cancelled/);
});
