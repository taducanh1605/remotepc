import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("production ontrack preserves independently grouped audio and video", async () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const handler = source.match(/peer\.addEventListener\("track", (\(\{ track, receiver, streams \}\) => \{[\s\S]*?)\n    \}\);/);
  assert.ok(handler, "production track callback not found");
  let attached = null, assignments = 0, playCount = 0;
  const peer = {}, screen = {
    get srcObject() { return attached; },
    set srcObject(stream) { attached = stream; ++assignments; },
  };
  class MediaStream {
    tracks = [];
    addTrack(track) { this.tracks.push(track); }
    getTracks() { return this.tracks; }
  }
  const receive = runInNewContext(`(${handler[1]}\n})`, {
    pc: peer, peer, screen, MediaStream, startPlayback() { ++playCount; },
  });
  const video = { kind: "video" }, audio = { kind: "audio" };
  receive({ track: video, receiver: {}, streams: [new MediaStream()] });
  receive({ track: audio, receiver: {}, streams: [new MediaStream()] });
  await Promise.resolve();
  assert.deepEqual(screen.srcObject.tracks, [video, audio]);
  assert.equal(playCount, 2);
  assert.equal(assignments, 1, "a second track must not reset the video element");
});
