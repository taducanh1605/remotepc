import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("./manifest.webmanifest", import.meta.url), "utf8"));

test("browser handles installation without custom buttons or suppressed prompts", () => {
  assert.doesNotMatch(html, /id="install(?:-stream)?"/);
  assert.doesNotMatch(app, /beforeinstallprompt|pendingInstall/);
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192" && icon.type === "image/png"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.type === "image/png"));
  for (const [file, size] of [["icon-192.png", 192], ["icon-512.png", 512]]) {
    const png = readFileSync(new URL(`./${file}`, import.meta.url));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test("remote controls float over video and expose microphone and connection actions", () => {
  assert.match(html, /<video id="screen"[^>]*><\/video>\s*<details id="stream-tools" hidden>/);
  for (const id of ["fullscreen", "disconnect", "microphone", "pointer-lock", "soft-keyboard", "right-click", "zoom"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<summary aria-label="Remote controls"[^>]*><span class="menu-icon"/);
  assert.match(html, /id="latency" aria-live="polite"/);
  assert.match(html, /id="input-capabilities" role="status"/);
  assert.match(html, /control RTT measures the motion data channel round trip/i);
  assert.match(css, /#stream-tools\s*\{[^}]*position:\s*absolute/);
});

test("stream has no permanent text bands and disconnect restores the connection view", () => {
  assert.match(html, /id="stream-shell"[^>]*hidden/);
  assert.match(css, /body\.streaming > header,body\.streaming #connection,body\.streaming #status,body\.streaming main > details \{ display: none; \}/);
  assert.match(app, /await immersive\.disconnected\(\)/);
  assert.match(app, /classList\.remove\("streaming"\)/);
  assert.match(app, /\$\("stream-shell"\)\.hidden = true/);
  assert.match(css, /object-position: center top/);
});

test("keyboard retains focus across host focus messages and viewport resizing", () => {
  assert.doesNotMatch(app, /hidden = !message\.editable/);
  assert.match(app, /message\.request !== pendingFocus/);
  assert.match(app, /message\.editable && activePointers\.size === 0 && !keyboardVisible/);
  assert.match(app, /if \(!keyboardVisible\) screen\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /\$\("remote-text"\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /next\.width === lastDimensions\?\.width && next\.height === lastDimensions\?\.height/);
});

test("selected pre-connect fullscreen is requested before asynchronous connection work", () => {
  assert.match(html, /id="connect-fullscreen"/);
  const submit = app.match(/addEventListener\("submit", async \(event\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(submit);
  assert.ok(submit.indexOf("requestFullscreenInGesture") < submit.indexOf("await"));
});

test("certificate trust uses a popup and origin/source-checked messages without credentials in its URL", () => {
  assert.match(app, /\/trust\?origin=\$\{encodeURIComponent\(location\.origin\)\}&nonce=/);
  assert.match(app, /trustPopup\?\.close\(\)/);
  assert.match(app, /event\.data\.nonce !== trustNonce/);
  assert.match(app, /event\.source !== trustPopup \|\| event\.origin !== trustOrigin/);
  assert.doesNotMatch(app, /\/trust\?[^`]*token/i);
});

test("host address only is persisted and exit requires an explicit choice", () => {
  assert.match(app, /localStorage\.setItem\("njk-host-origin", origin\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*(?:token|password)/i);
  assert.match(html, /<dialog id="exit-dialog"/);
  for (const id of ["exit-cancel", "exit-disconnect", "exit-quit"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /exitDialog\.showModal\(\)/);
  assert.match(app, /JSON\.stringify\(\{ id: sessionId, quit \}\)/);
});

test("input motion is lossy/coalesced while edge controls remain reliable", () => {
  assert.match(app, /createDataChannel\("input", \{ ordered: true \}\)/);
  assert.match(app, /createDataChannel\("motion", \{ ordered: false, maxRetransmits: 0 \}\)/);
  assert.match(app, /coalescedPointerEvent/);
});

test("sixty FPS is selected by default and initial negotiation includes selected quality", () => {
  assert.match(html, /id="stream-fps"><option value="60">/);
  assert.match(app, /sdp: peer\.localDescription\.sdp, \.\.\.dimensions\(\), \.\.\.requestedQuality\(\)/);
  assert.match(app, /const \{ fps, bitrateKbps \} = requestedQuality\(\)/);
});

test("first motion is immediate while a burst sends only its latest sample each frame", () => {
  const frames = new Map(), sent = [];
  let frameId = 0;
  const context = {
    pendingMotions: new Map(), motionFrame: undefined,
    sendMotion: message => sent.push(message.x),
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
  };
  const functions = app.slice(app.indexOf("function flushMotions()"), app.indexOf("function nextGeneration("));
  runInNewContext(`${functions}; globalThis.queue = queueMotion;`, context);
  context.queue({ type: "move", x: 1 });
  assert.deepEqual(sent, [1]);
  for (let x = 2; x <= 100; x++) context.queue({ type: "move", x });
  assert.deepEqual(sent, [1]);
  const advance = () => {
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback();
  };
  advance();
  assert.deepEqual(sent, [1, 100]);
  advance();
  assert.equal(frames.size, 0);
  context.queue({ type: "move", x: 101 });
  assert.deepEqual(sent, [1, 100, 101]);
});

test("ESP Wake launch removes its ticket from history and never persists the host credential", () => {
  assert.match(app, /history\.replaceState\(null, "", location\.pathname \+ location\.search\)/);
  assert.match(app, /\/api\/connect/);
  assert.match(app, /JSON\.stringify\(\{ ticket: remoteLaunch\.ticket \}\)/);
  assert.match(app, /\$\("connection"\)\.requestSubmit\(\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*(?:ticket|token)/i);
  assert.match(app, /message\.type === "bitrate-applied"/);
  assert.match(html, /id="quality-request" role="status"/);
});
