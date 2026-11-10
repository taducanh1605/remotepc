import test from "node:test";
import assert from "node:assert/strict";
import { controlLatency } from "./latency.mjs";

test("control latency reports tails instead of hiding audio-time spikes in a median", () => {
  const values = Array(30).fill(2).concat([60, 80]);
  assert.deepEqual(controlLatency(values), { median: 2, p95: 60, max: 80 });
  assert.equal(controlLatency([]), undefined);
  assert.deepEqual(controlLatency([NaN, Infinity, .7, 1.2]), { median: 1.2, p95: 1.2, max: 1.2 });
  assert.equal(values[0], 2);
});
