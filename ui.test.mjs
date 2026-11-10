import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { viewportDimensions } from "./protocol.mjs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("./manifest.webmanifest", import.meta.url), "utf8"));

test("applying 120 FPS after reducing 4K detail sends viewport before quality", () => {
  const events = [], button = { addEventListener(_type, callback) { this.apply = callback; } };
  const controls = { "apply-quality": button, "quality-request": {} };
  const helper = app.slice(app.indexOf("function sendViewport()"), app.indexOf("const resized = () =>"));
  const handler = app.slice(app.indexOf('$("apply-quality").addEventListener'), app.indexOf("function flushMotions()"));
  const context = {
    $: id => controls[id],
    dimensions: () => ({ width: 1920, height: 1080 }),
    requestedQuality: () => ({ fps: 120, bitrateKbps: 20000 }),
    channel: { readyState: "open" },
    lastDimensions: { width: 3840, height: 2160 },
    resized() {},
    send: message => events.push(message),
  };
  runInNewContext(helper + handler, context);
  button.apply();
  assert.deepEqual(events.map(event => event.type), ["resize", "quality"]);
  assert.equal(events[1].fps, 120);
});

test("negotiated viewport prevents a duplicate startup resize from restoring full bitrate", () => {
  const events = [], offeredDimensions = { width: 720, height: 1280 };
  let actual = offeredDimensions;
  const helper = app.slice(app.indexOf("function sendViewport()"), app.indexOf("const resized = () =>"));
  const assignment = app.match(/lastDimensions = offeredDimensions;/)[0];
  const context = { offeredDimensions, lastDimensions: undefined, dimensions: () => actual,
    channel: { readyState: "open" }, send: message => events.push(message) };
  assert.equal(runInNewContext(`${assignment}\n${helper}\nsendViewport()`, context), false);
  actual = { width: 1280, height: 720 };
  assert.equal(context.sendViewport(), true);
  assert.equal(events.length, 1);
});

test("automatic viewport updates preserve the adaptive budget with compatible legacy payloads", () => {
  const source = app.slice(app.indexOf("const resized = () =>"), app.indexOf("window.visualViewport?.addEventListener"));
  for (const latencyControl of [false, true]) {
    const events = [];
    runInNewContext(`${source}\nresized()`, {
      observeKeyboardGeometry() {}, document: { documentElement: { style: { setProperty() {} } } },
      viewport: () => ({ height: 800 }), resizeTimer: undefined, clearTimeout() {},
      setTimeout: callback => callback(), sendViewport: () => true,
      $: () => ({ value: "auto" }), requestedQuality: () => ({ fps: 60, bitrateKbps: 9216 }),
      capabilities: { latencyControl }, send: message => events.push(message),
    });
    assert.equal(events[0].bitrateKbps, 9216);
    assert.equal(events[0].adaptive, latencyControl ? true : undefined);
  }
});

test("gamepads default on and editor blur releases pointer/keys without disconnecting the controller", () => {
  assert.match(html, /id="gamepad"[^>]*checked/);
  const release = app.slice(app.indexOf("const release = () => {"), app.indexOf("if (navigator.virtualKeyboard)"));
  assert.match(release, /preserveGamepads: true/);
  assert.doesNotMatch(release, /gamepads\.release/);
  assert.match(app, /window\.addEventListener\("blur", .*gamepads\.release\(\)/);
  assert.match(app, /channel\.addEventListener\("open", \(\) => \{\s*send\(\{ type: "resize", \.\.\.dimensions\(\) \}\);\s*if \(\$\("gamepad"\)\.checked\) gamepads\.start\(\)/);
});

test("connection prepares the black stream shell before fullscreen instead of flashing the form twice", () => {
  const submit = app.slice(app.indexOf('$("connection").addEventListener("submit"'), app.indexOf("const attempt = ++generation"));
  assert.ok(submit.indexOf('$("stream-shell").hidden = false') < submit.indexOf("requestFullscreenInGesture("));
  assert.match(submit, /\$\("stream-loading"\)\.hidden = false/);
});

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
  assert.match(html, /<video id="screen"[^>]* muted/);
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

test("PWA extra keys belong to the floating menu independently of the OS keyboard", () => {
  const menu = html.slice(html.indexOf('<details id="stream-tools"'), html.indexOf("</details>", html.indexOf('<details id="stream-tools"')));
  assert.match(menu, /<div id="keyboard-accessory" role="group" aria-label="Remote keyboard extra keys">/);
  for (const code of ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "AltLeft", "ControlLeft", "ShiftLeft"]) {
    assert.match(menu, new RegExp(`data-key="${code}"`));
  }
  assert.doesNotMatch(app, /\$\("keyboard-accessory"\)\.hidden|keyboard-open/);
  assert.doesNotMatch(css, /#keyboard-accessory\s*\{[^}]*position:\s*absolute|#stream-shell\.keyboard-open/);
  assert.match(css, /#keyboard-accessory\s*\{[^}]*grid-template-columns: repeat\(3/);
});

test("PWA resolution uses the entire usable viewport without a reserved accessory strip", () => {
  const source = app.slice(app.indexOf("const dimensions ="), app.indexOf("function requestedQuality()"));
  for (const height of [300, 500, 800]) {
    const result = runInNewContext(`${source}; dimensions()`, {
      viewport: () => ({ width: 400, height }), viewportDimensions,
      $: id => {
        assert.equal(id, "stream-detail", "menu visibility must not affect host dimensions");
        return { value: "1" };
      },
    });
    assert.equal(result.width, 400);
    assert.equal(result.height, height);
  }
});

test("opening the floating menu preserves the active mobile editor", () => {
  const field = {}, handlers = {};
  const context = {
    keyboardVisible: true, document: { activeElement: field },
    $: id => id === "remote-text" ? field : { querySelector: () => ({
      addEventListener(type, handler) { handlers[type] = handler; },
    }) },
  };
  runInNewContext(app.slice(app.indexOf('$("stream-tools").querySelector("summary").addEventListener'),
    app.indexOf("const gamepads =")), context);
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  handlers.pointerdown(event);
  assert.equal(prevented, true);
  context.keyboardVisible = false;
  prevented = false;
  handlers.pointerdown(event);
  assert.equal(prevented, false);
  context.keyboardVisible = true;
  context.document.activeElement = {};
  handlers.pointerdown(event);
  assert.equal(prevented, false);
});

test("keyboard retains focus across host focus messages and viewport resizing", () => {
  assert.doesNotMatch(app, /hidden = !message\.editable/);
  assert.match(app, /message\.request !== pendingFocus/);
  assert.match(app, /repeated && activePointers\.size === 0 && !keyboardVisible/);
  assert.match(app, /if \(!keyboardVisible\) screen\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /\$\("remote-text"\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /next\.width === lastDimensions\?\.width && next\.height === lastDimensions\?\.height/);
});

test("automatic IME requires another tap of the same identified host editor", () => {
  const context = { lastTextFocusIdentity: "" };
  const source = app.slice(app.indexOf("function acceptTextFocus("), app.indexOf("const immersive ="));
  runInNewContext(source, context);
  const reply = (focusId, editable = true) => context.acceptTextFocus({ focusId, editable });
  assert.equal(reply("123"), false, "first focus must not open");
  assert.equal(reply("123"), true, "same editor tapped again opens");
  assert.equal(reply("456"), false, "different editor must not open");
  assert.equal(reply("456"), true);
  assert.equal(reply("", false), false, "outside tap clears the previous editor");
  assert.equal(reply("456"), false);
  assert.equal(reply(undefined), false, "old hosts have no identity, use manual keyboard");
  assert.equal(reply("0"), false);
});

test("focus monitoring hides on blur without arming editors or reopening a dismissed keyboard", () => {
  const timers = new Map(), sent = [], keyboard = [], status = {};
  let nextTimer = 0;
  const context = { lastTextFocusIdentity: "123", keyboardVisible: true, backend: "native-host",
    channel: { readyState: "open" }, activePointers: new Map(), pendingFocus: 0,
    pendingFocusCheck: 0, focusRequest: 0, focusCheckTimer: undefined,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, send: message => sent.push(message),
    setKeyboard(visible) { keyboard.push(visible); context.keyboardVisible = visible; },
    screen: { focus() { throw new Error("Video focus would cancel the pending Android IME hide"); } }, $: () => status };
  const functions = app.slice(app.indexOf("function acceptTextFocus("), app.indexOf("const immersive ="));
  const handler = app.slice(app.indexOf('if (message.type === "text-focus"'), app.indexOf('if (message.type === "gamepad")'));
  runInNewContext(functions + "\nfunction receiveFocus(message) {" + handler + "}", context);
  context.scheduleFocusCheck();
  assert.equal(timers.get(context.focusCheckTimer).delay, 500);
  timers.get(context.focusCheckTimer).callback();
  assert.equal(sent[0].type, "focus-check");
  assert.equal(context.pendingFocusCheck, 1);
  const check = (request, editable, focusId) => context.receiveFocus({
    type: "text-focus", checkOnly: true, request, editable, focusId
  });
  check(99, false, "");
  assert.equal(keyboard.length, 0, "stale replies cannot dismiss IME");
  check(1, true, "456");
  assert.equal(context.lastTextFocusIdentity, "", "passive checks never arm a different editor");
  assert.equal(keyboard.length, 0);
  context.keyboardVisible = false;
  context.pendingFocusCheck = 2;
  check(2, true, "456");
  assert.equal(context.keyboardVisible, false, "positive polling cannot undo OS dismissal");
  context.lastTextFocusIdentity = "456";
  context.keyboardVisible = true;
  context.pendingFocusCheck = 3;
  check(3, false, "");
  assert.deepEqual(keyboard, [false]);
  assert.equal(context.lastTextFocusIdentity, "");
  assert.equal(timers.has(context.focusCheckTimer), false, "stop polling after focus loss");
  context.lastTextFocusIdentity = "789";
  context.scheduleFocusCheck();
  timers.get(context.focusCheckTimer).callback();
  timers.get(context.focusCheckTimer).callback();
  assert.match(status.textContent, /monitoring timed out/);
  assert.equal(context.pendingFocusCheck, 0);
  assert.deepEqual(keyboard, [false], "timeout must not fabricate focus loss");
  context.pendingFocus = 42;
  assert.doesNotThrow(() => context.receiveFocus({
    type: "text-focus", request: 42, editable: false, focusId: ""
  }), "outside-tap reply must let setKeyboard finish hiding before changing focus");
  assert.equal(keyboard.at(-1), false);
});

test("manual virtual keyboard primes text during the gesture and resets after OS dismissal", () => {
  assert.match(html, /<div id="remote-text"[^>]*contenteditable="true"[^>]*role="textbox"/);
  const events = [];
  const field = { hidden: false, inputMode: "none", attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; events.push([name, value]); },
    blur() { events.push(["blur"]); context.document.activeElement = null; },
    focus() { events.push(["focus", this.inputMode, this.attributes.virtualkeyboardpolicy]); context.document.activeElement = field; } };
  const nodes = { "remote-text": field, "remote-text-label": {}, "remote-text-help": {},
    "soft-keyboard": { setAttribute() {} }, "keyboard-status": {} };
  const frames = [];
  const context = { keyboardVisible: false, keyboardObserved: false, keyboardViewportHeight: 0, keyboardViewportWidth: 0,
    requestAnimationFrame: callback => frames.push(callback), accessory: { release() {} },
    pendingFocus: 0, focusTimer: undefined, focusCheckTimer: undefined, lastTextFocusIdentity: "",
    backend: "standalone", clearTimeout() {}, innerHeight: 800, innerWidth: 400,
    window: {visualViewport: {height: 800, width: 400}},
    $: id => nodes[id], document: { activeElement: field },
    navigator: { virtualKeyboard: { boundingRect: {height: 0}, show() { events.push(["show"]); },
      hide() { events.push(["hide", context.document.activeElement === field, field.inputMode]); } } } };
  const source = app.slice(app.indexOf("if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent"), app.indexOf("const immersive ="));
  runInNewContext(source, context);
  assert.equal(context.navigator.virtualKeyboard.overlaysContent, true);
  context.primeKeyboardGesture();
  assert.deepEqual(events.slice(-1), [["focus", "text", "manual"]]);
  assert.equal(events.some(([name]) => name === "show"), false);
  context.observeKeyboardGeometry();
  context.setKeyboard(true, true);
  assert.deepEqual(events.slice(-2), [["focus", "text", "manual"], ["show"]]);
  assert.equal(context.keyboardVisible, true);
  context.navigator.virtualKeyboard.boundingRect.height = 300;
  context.window.visualViewport.height = 500;
  context.observeKeyboardGeometry();
  assert.equal(context.keyboardObserved, true);
  context.pendingFocus = 7;
  context.navigator.virtualKeyboard.boundingRect.height = 0;
  context.window.visualViewport.height = 800;
  context.observeKeyboardGeometry();
  assert.equal(context.keyboardVisible, false);
  assert.equal(context.pendingFocus, 0);
  while (frames.length) frames.shift()();
  const showCount = events.filter(([name]) => name === "show").length;
  context.primeKeyboardGesture();
  assert.equal(events.filter(([name]) => name === "show").length, showCount);
  context.setKeyboard(false);
  assert.equal(field.inputMode, "none");
  assert.equal(field.attributes.virtualkeyboardpolicy, "manual");
  context.setKeyboard(true);
  context.document.activeElement = nodes["soft-keyboard"];
  context.setKeyboard(false);
  while (frames.length) frames.shift()();
  assert.deepEqual(events.filter(([name]) => name === "hide").at(-1), ["hide", true, "text"]);
  context.navigator = {};
  context.setKeyboard(true);
  assert.equal(context.document.activeElement, field);
  assert.equal(field.attributes.virtualkeyboardpolicy, "auto");
  context.navigator = { virtualKeyboard: { show() { throw new Error("gesture required"); } } };
  assert.doesNotThrow(() => context.showKeyboard());
  assert.match(nodes["keyboard-status"].textContent, /gesture required.*Tap Keyboard to retry/);
});

test("touch release never reopens the soft keyboard and noneditable host focus closes it", () => {
  const pointerup = app.slice(app.indexOf('screen.addEventListener("pointerup"'), app.indexOf('screen.addEventListener("pointercancel"'));
  assert.doesNotMatch(pointerup, /showKeyboard|setKeyboard\(true/);
  assert.match(app, /if \(!message\.editable\) \{\s*setKeyboard\(false\)/);
});

test("contenteditable forwards Unicode, composition, deletion and line breaks without duplicates", () => {
  const handlers = {}, sent = [], timers = [];
  const field = { textContent: "", addEventListener(type, handler) { handlers[type] = handler; } };
  const context = { composingText: false, committedComposition: undefined,
    $: id => id === "remote-text" ? field : { value: "unicode" },
    accessory: { text: text => sent.push({ text }) }, send: message => sent.push(message),
    setTimeout: callback => timers.push(callback) };
  const source = app.slice(app.indexOf('$("remote-text").addEventListener("beforeinput"'), app.indexOf('$("remote-text").addEventListener("keydown"'));
  runInNewContext(source, context);
  const input = (inputType, data) => handlers.beforeinput({ inputType, data, cancelable: true, preventDefault() {} });
  input("insertText", "abc");
  handlers.compositionstart();
  field.textContent = "ignored";
  handlers.input();
  field.textContent = "\u1ebf\ud83d\ude00";
  handlers.compositionend({ data: "\u1ebf\ud83d\ude00" });
  handlers.input();
  input("insertFromComposition", "\u1ebf\ud83d\ude00");
  while (timers.length) timers.shift()();
  assert.equal(field.textContent, "");
  input("deleteContentBackward");
  input("insertParagraph");
  field.textContent = "fallback";
  handlers.input();
  assert.equal(field.textContent, "");
  assert.equal(JSON.stringify(sent), JSON.stringify([
    {text:"abc"}, {text:"\u1ebf\ud83d\ude00"},
    {type:"key",code:"Backspace",down:true}, {type:"key",code:"Backspace",down:false},
    {text:"\n"}, {text:"fallback"},
  ]));
});

test("selected pre-connect fullscreen is requested before asynchronous connection work", () => {
  assert.match(html, /id="connect-fullscreen"/);
  const submit = app.match(/addEventListener\("submit", async \(event\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(submit);
  assert.ok(submit.indexOf("requestFullscreenInGesture") < submit.indexOf("await"));
});

test("certificate trust requires a successful TLS fetch instead of trusting popup messages", () => {
  assert.match(app, /\/trust\?origin=\$\{encodeURIComponent\(location\.origin\)\}&nonce=/);
  assert.match(app, /trustPopup\?\.close\(\)/);
  assert.match(app, /nonce !== trustNonce/);
  const trustFlow = app.slice(app.indexOf("function openTrustPage()"), app.indexOf('if ("serviceWorker"'));
  assert.match(trustFlow, /response\.ok && response\.url === url && new URL\(response\.url\)\.origin === origin/);
  assert.doesNotMatch(trustFlow, /addEventListener\("message"|njk-certificate-trusted/);
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
  assert.match(app, /sdp: peer\.localDescription\.sdp, \.\.\.offeredDimensions, \.\.\.requestedQuality\(\)/);
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
  assert.match(app, /remoteLaunch\.host\}\/api\/connect-prepare/);
  assert.match(app, /message\.type === "bitrate-applied"/);
  assert.match(html, /id="quality-request" role="status"/);
});

test("certificate retry and popup close require a verified host response; fetch errors remain ambiguous", async () => {
  const popup = { closed: false, close() { this.closed = true; } };
  let poll, retries = 0, targetUrl;
  const messages = new Map();
  let responseUrl = "https://other.example/trust";
  const context = {
    trustPopup: undefined,
    trustOrigin: undefined,
    trustNonce: undefined,
    trustTimer: undefined,
    verifiedTrustOrigin: undefined,
    URL,
    location: { origin: "https://taducanh1605.github.io" },
    crypto: { randomUUID: () => "nonce-test" },
    window: {
      open(url) { targetUrl = url; return popup; },
      addEventListener(type, listener) { messages.set(type, listener); },
    },
    saveHost: () => "https://host.example:47990",
    setInterval(callback) { poll = callback; return 1; },
    clearInterval() {},
    Date: { now: () => 0 },
    AbortSignal: { timeout: () => ({}) },
    fetch: async () => ({ ok: true, url: responseUrl }),
    status(message) { context.lastStatus = message; },
    remoteLaunch: { host: "https://host.example:47990" },
    connectFromESPWake() { retries++; },
    $: () => ({ addEventListener() {} }),
  };
  const trustFlow = app.slice(app.indexOf("function openTrustPage()"), app.indexOf('if ("serviceWorker"'));
  runInNewContext(trustFlow, context);
  context.openTrustPage();
  assert.match(targetUrl, /^https:\/\/host\.example:47990\/trust\?/);
  assert.match(context.lastStatus, /CORS or network failure/);
  await poll();
  assert.equal(popup.closed, false);
  assert.equal(retries, 0);

  responseUrl = targetUrl;
  await poll();
  assert.equal(popup.closed, true);
  assert.equal(retries, 1);
  assert.match(context.verifiedTrustOrigin, /^https:\/\/host\.example:47990$/);
});

test("ESP Wake selects fullscreen and automatically submits a redeemed host credential", async () => {
  const elements = {
    token: { value: "" },
    connection: { requestSubmit() { context.submitted = true; } },
    "handoff-recovery": { hidden: true },
  };
  const context = {
    handoffConnecting: false,
    remoteLaunch: { host: "https://host.example", ticket: "1".repeat(32) },
    returnToESPWake: true,
    automaticConnection: false,
    handoffOpener: null, handoffBroker: null, handoffNonce: undefined,
    window: { opener: null },
    requests: [],
    fetch: async (url, options) => {
      context.requests.push(url);
      return url.endsWith("/api/connect-prepare")
        ? { ok: true, json: async () => ({ ticket: "c".repeat(32), expiresIn: 600 }) }
        : { ok: true, json: async () => ({ token: "x".repeat(32) }) };
    },
    AbortSignal, JSON,
    $: id => elements[id],
    isTransientNetworkError: () => false,
    status: message => { throw new Error(message); },
  };
  const launch = app.slice(app.indexOf("async function requestFreshHandoffTicket()"), app.lastIndexOf("if (remoteLaunch)"));
  runInNewContext(launch, context);
  await context.connectFromESPWake();
  assert.equal(context.submitted, true);
  assert.equal(context.automaticConnection, true);
  assert.equal(elements.token.value.length, 32);
  assert.equal(context.remoteLaunch, undefined);
  assert.deepEqual(context.requests.map(url => new URL(url).pathname), ["/api/connect-prepare", "/api/connect"]);
  assert.match(app, /\$\("connect-fullscreen"\)\.checked = false/);
  assert.match(app, /immersive\.connected\(\{ autoEnter: \$\("connect-fullscreen"\)\.checked, requestFullscreen: false \}\)/);
});

test("prepared handoff is single-flight and needs no suspended ESPWake broker", async () => {
  let redeemed = 0, submitted = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const elements = { token: { value: "" }, connection: { requestSubmit() { submitted++; } } };
  const context = {
    handoffConnecting: false, remoteLaunch: { host: "https://host.example", ticket: "1".repeat(32), prepared: true },
    handoffOpener: null, handoffBroker: null, handoffNonce: undefined, automaticConnection: false,
    window: { opener: null }, AbortSignal, JSON, $: id => elements[id], isTransientNetworkError: () => false,
    fetch: async () => { redeemed++; await ready; return { ok: true, json: async () => ({ token: "x".repeat(32) }) }; },
    status: message => { throw new Error(message); },
  };
  const launch = app.slice(app.indexOf("async function requestFreshHandoffTicket()"), app.lastIndexOf("if (remoteLaunch)"));
  runInNewContext(launch, context);
  const first = context.connectFromESPWake();
  await context.connectFromESPWake();
  release();
  await first;
  assert.equal(redeemed, 1);
  assert.equal(submitted, 1);
  assert.equal(context.handoffConnecting, false);
});

test("same-window certificate approval after 120 seconds renews through saved ESPWake without an opener", async () => {
  const origin = "https://taducanh1605.github.io", host = "https://host.example";
  const listeners = new Set(), timers = new Map(), requests = [];
  let poll, timer = 0, preparedCalls = 0, submitted = 0, frameRemoved = false, trustClosed = false, now = 0;
  const deliver = (source, data, eventOrigin = origin) => {
    for (const listener of [...listeners]) listener({ source, origin: eventOrigin, data });
  };
  const frame = {
    remove() { frameRemoved = true; },
    contentWindow: { postMessage(message, target) {
      assert.equal(target, origin);
      assert.equal(message.nonce, "test-nonce");
      deliver({}, { type: "njk-fresh-ticket", nonce: "test-nonce", host, ticket: "e".repeat(32) });
      deliver(frame.contentWindow, { type: "njk-fresh-ticket", nonce: "forged", host, ticket: "e".repeat(32) });
      deliver(frame.contentWindow, { type: "njk-fresh-ticket", nonce: "test-nonce", host, ticket: "b".repeat(32) });
    } },
  };
  const nodes = { token: { value: "" }, connection: { requestSubmit() { submitted++; } }, "trust-host": { addEventListener() {} } };
  const context = {
    URL, URLSearchParams, AbortSignal, JSON, Date: { now: () => now },
    remoteLaunch: { host, ticket: "a".repeat(32), profileId: "pc-1" },
    returnInSameWindow: true, returnToESPWake: true, handoffOpener: null, handoffBroker: null,
    handoffNonce: "test-nonce", handoffRefreshDeadline: undefined, handoffConnecting: false,
    trustPopup: undefined, trustOrigin: undefined, trustNonce: undefined, trustTimer: undefined, verifiedTrustOrigin: undefined,
    location: { origin, pathname: "/remotepc/" }, crypto: { randomUUID: () => "trust-nonce" },
    window: { opener: null, open: () => ({ close() { trustClosed = true; } }),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener) },
    document: { createElement: () => frame, body: { appendChild() {
      queueMicrotask(() => deliver(frame.contentWindow, { type: "njk-broker-ready", nonce: "test-nonce" }));
    } } },
    setInterval(callback) { poll = callback; return 1; }, clearInterval() {},
    setTimeout(callback, delay) { if (delay === 2500) callback(); else timers.set(++timer, callback); return timer; },
    clearTimeout: id => timers.delete(id), saveHost: () => host, status() {},
    $: id => nodes[id], isTransientNetworkError: error => error instanceof TypeError,
    fetch: async (url, options) => {
      if (url.includes("/trust?")) return { ok: true, url };
      requests.push([url, JSON.parse(options.body).ticket]);
      if (url.endsWith("/api/connect-prepare")) {
        preparedCalls++;
        if (preparedCalls === 1) throw new TypeError("Failed to fetch");
        if (preparedCalls === 2) return { status: 401, ok: false };
        return { ok: true, json: async () => ({ ticket: "c".repeat(32), expiresIn: 600 }) };
      }
      return { ok: true, json: async () => ({ token: "x".repeat(32) }) };
    },
  };
  runInNewContext(app.slice(app.indexOf("function openTrustPage()"), app.indexOf('if ("serviceWorker"')), context);
  runInNewContext(app.slice(app.indexOf("async function requestFreshHandoffTicket()"), app.lastIndexOf("if (remoteLaunch)")), context);
  await context.connectFromESPWake();
  now = 121000;
  await poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preparedCalls, 3);
  assert.equal(submitted, 1);
  assert.equal(trustClosed, true);
  assert.equal(frameRemoved, true);
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(new URL(frame.src).pathname, "/espwake/");
  assert.equal(new URLSearchParams(new URL(frame.src).hash.slice(1)).get("profileId"), "pc-1");
  assert.deepEqual(requests.map(([url, ticket]) => [new URL(url).pathname, ticket]), [
    ["/api/connect-prepare", "a".repeat(32)],
    ["/api/connect-prepare", "a".repeat(32)],
    ["/api/connect-prepare", "b".repeat(32)],
    ["/api/connect", "c".repeat(32)],
  ]);
});

test("legacy manual offers preserve their payload while ESPWake supplies the replacement identity", () => {
  const expression = app.match(/body: JSON\.stringify\((\{ sdp: peer\.localDescription\.sdp[^\n]+)\),/)[1];
  const context = { peer: { localDescription: { sdp: "test-sdp" } },
    offeredDimensions: { width: 750, height: 1624 }, requestedQuality: () => ({ fps: 60, bitrateKbps: 8000 }) };
  const manual = runInNewContext(`(${expression})`, { ...context, viewerId: undefined });
  assert.equal(Object.hasOwn(manual, "clientId"), false);
  const handoff = runInNewContext(`(${expression})`, { ...context, viewerId: "a".repeat(32) });
  assert.equal(handoff.clientId, "a".repeat(32));
  assert.equal(handoff.width, 750);
  assert.equal(handoff.fps, 60);
});

test("automatic launch closes only after successful Disconnect or Quit and retains fresh-ticket authentication guards", () => {
  const leave = app.slice(app.indexOf("async function leaveSession"), app.indexOf('$("exit-disconnect").addEventListener'));
  assert.ok(leave.indexOf("if (!response.ok)") < leave.indexOf("window.close()"));
  assert.match(leave, /if \(returnToESPWake\)/);
  assert.match(app, /event\.source !== handoffOpener/);
  assert.match(app, /data\?\.nonce !== handoffNonce/);
  assert.match(app, /prepared\.status === 401 && \(handoffOpener \|\| handoffBroker \|\| remoteLaunch\.profileId\)/);
  assert.match(app, /window\.opener = null/);
});

test("expired real-ticket response renews over the nonce broker without an opener", async () => {
  const elements = { token: { value: "" }, connection: { requestSubmit() {} }, "handoff-recovery": { hidden: true } };
  const listeners = new Set(), requests = [];
  let timer = 0;
  const broker = {
    addEventListener(type, listener) { listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
    postMessage(message) {
      if (message.type !== "njk-refresh-ticket") return;
      for (const listener of listeners) listener({ data: { type: "njk-fresh-ticket", nonce: "wrong", host: "https://evil.example", ticket: "3".repeat(32) } });
      for (const listener of listeners) listener({ data: { type: "njk-fresh-ticket", nonce: "test-nonce", host: "https://host.example", ticket: "2".repeat(32) } });
    },
    close() { this.closed = true; },
  };
  const context = {
    handoffConnecting: false, remoteLaunch: { host: "https://host.example", ticket: "1".repeat(32) },
    returnToESPWake: true,
    handoffOpener: null, handoffBroker: broker, handoffNonce: "test-nonce", handoffRefreshDeadline: undefined,
    window: { addEventListener() {}, removeEventListener() {}, opener: null },
    location: { origin: "https://taducanh1605.github.io" }, automaticConnection: false,
    fetch: async (url, options) => {
      requests.push([new URL(url).pathname, JSON.parse(options.body).ticket]);
      if (url.endsWith("/api/connect-prepare")) {
        return requests.length === 1
          ? { status: 401, ok: false }
          : { status: 200, ok: true, json: async () => ({ ticket: "c".repeat(32), expiresIn: 600 }) };
      }
      return { status: 200, ok: true, json: async () => ({ token: "x".repeat(32) }) };
    },
    setTimeout: (callback, delay) => { if (delay === 2500) callback(); return ++timer; }, clearTimeout() {},
    AbortSignal, JSON, Date, $: id => elements[id], isTransientNetworkError: () => false, status() {},
  };
  const launch = app.slice(app.indexOf("async function requestFreshHandoffTicket()"), app.lastIndexOf("if (remoteLaunch)"));
  runInNewContext(launch, context);
  await context.connectFromESPWake();
  assert.deepEqual(requests, [
    ["/api/connect-prepare", "1".repeat(32)],
    ["/api/connect-prepare", "2".repeat(32)],
    ["/api/connect", "c".repeat(32)],
  ]);
  assert.equal(context.automaticConnection, true);
  assert.equal(broker.closed, true);
  assert.equal(listeners.size, 0);
});

test("ticket renewal uses the opener even when BroadcastChannel exists but cannot deliver", async () => {
  const elements = { token: { value: "" }, connection: { requestSubmit() {} }, "handoff-recovery": { hidden: true } };
  const listeners = new Map(), timers = new Map();
  let timer = 0, submitted = 0, broadcastRequests = 0;
  const opener = {
    postMessage(message, origin) {
      assert.equal(origin, "https://taducanh1605.github.io");
      if (message.type === "njk-refresh-ticket") listeners.get("message")({
        source: opener, origin, data: { type: "njk-fresh-ticket", nonce: "test", host: "https://host.example", ticket: "2".repeat(32) },
      });
    },
  };
  const context = {
    handoffConnecting: false, remoteLaunch: { host: "https://host.example", ticket: "1".repeat(32) },
    returnToESPWake: true,
    handoffOpener: opener, handoffNonce: "test", handoffRefreshDeadline: undefined,
    handoffBroker: { addEventListener() {}, removeEventListener() {}, close() {},
      postMessage(message) { if (message.type === "njk-refresh-ticket") ++broadcastRequests; } },
    window: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) },
    location: { origin: "https://taducanh1605.github.io" }, automaticConnection: false,
    fetch: async url => {
      submitted++;
      if (url.endsWith("/api/connect-prepare")) return submitted === 1
        ? { status: 401, ok: false }
        : { status: 200, ok: true, json: async () => ({ ticket: "c".repeat(32), expiresIn: 600 }) };
      return { status: 200, ok: true, json: async () => ({ token: "x".repeat(32) }) };
    },
    setTimeout(callback, delay) { if (delay === 2500) callback(); else timers.set(++timer, callback); return timer; },
    clearTimeout: id => timers.delete(id), AbortSignal, JSON, Date, $: id => elements[id],
    status() {}, isTransientNetworkError: () => false,
  };
  runInNewContext(app.slice(app.indexOf("async function requestFreshHandoffTicket()"), app.lastIndexOf("if (remoteLaunch)")), context);
  await context.connectFromESPWake();
  assert.equal(submitted, 3);
  assert.equal(broadcastRequests, 1);
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
});

test("missing ticket broker ends with actionable recovery instead of an indefinite loading status", async () => {
  const recovery = { hidden: true }, notices = [], timers = new Map();
  let timer = 0;
  const context = {
    handoffConnecting: false, remoteLaunch: { host: "https://host.example", ticket: "1".repeat(32) },
    returnToESPWake: true, handoffOpener: null, handoffNonce: "test", handoffRefreshDeadline: undefined,
    handoffBroker: { addEventListener() {}, removeEventListener() {}, postMessage() {}, close() {} },
    window: { addEventListener() {}, removeEventListener() {} }, location: { origin: "https://taducanh1605.github.io" },
    fetch: async () => ({ status: 401, ok: false }),
    setTimeout(callback, delay) { timers.set(++timer, { callback, delay }); return timer; },
    clearTimeout: id => timers.delete(id), AbortSignal, JSON, Date: { now: () => 1000 }, $: () => recovery,
    status: text => notices.push(text), isTransientNetworkError: () => false,
  };
  runInNewContext(app.slice(app.indexOf("async function requestFreshHandoffTicket()"), app.lastIndexOf("if (remoteLaunch)")), context);
  const attempt = context.connectFromESPWake();
  await new Promise(resolve => setImmediate(resolve));
  const deadline = [...timers.values()].find(t => t.delay === 30000);
  assert.ok(deadline);
  deadline.callback();
  await attempt;
  assert.equal(recovery.hidden, false);
  assert.match(notices.at(-1), /Return to ESPWake/);
  assert.equal([...timers.values()].filter(t => t.delay < 30000).length, 0);
});

test("touch gesture focuses an existing quiet text field before the editable-focus reply", () => {
  assert.match(app, /primeKeyboardGesture\(\);/);
  assert.match(app, /field\.inputMode = navigator\.virtualKeyboard \? "text" : "none"/);
  assert.match(app, /inputMode = visible \|\| \(changed && navigator\.virtualKeyboard\) \? "text" : "none"/);
  assert.match(html, /virtualkeyboardpolicy="manual"/);
  assert.match(app, /accessory\.text\(event\.data, \$\("typing-mode"\)\.value\)/);
  assert.match(html, /Host keyboard \/ UniKey/);
});

test("both media receivers request low buffering and terminal capture failures retain their real cause", () => {
  assert.match(app, /\["jitterBufferTarget", "playoutDelayHint"\]/);
  assert.match(app, /screen\.srcObject \|\| streams\[0\]/);
  assert.match(app, /if \(screen\.srcObject !== stream\) screen\.srcObject = stream/);
  assert.match(app, /captureFailure \|\| "Connection lost/);
  assert.match(app, /\["capture-failed", "started"\]/);
  assert.match(app, /console\.warn\(`Could not set/);
});

test("the auto-connect module revision is shared by HTML and the offline shell", () => {
  const module = html.match(/<script type="module" src="([^"]+)"/)?.[1];
  assert.ok(module?.includes("?v="));
  const worker = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
  assert.ok(worker.includes(`"${module}"`));
});

test("same-host audio protection is visible and resets between sessions", () => {
  assert.match(html, /id="audio-status" role="status"/);
  assert.match(app, /message\.type === "audio-feedback" && typeof message\.blocked === "boolean"/);
  assert.match(app, /Audio silenced for this same-host viewer/);
  assert.match(app, /\$\("audio-status"\)\.textContent = ""/);
});

test("playback fallback, quality resize and temporary ICE interruption retain the session", () => {
  assert.match(app, /startPlayback\(\)/);
  assert.match(app, /screen\.addEventListener\("click", \(\) => startPlayback\(true\)\)/);
  assert.match(html, /id="desktop-audio"/);
  assert.match(html, /value="20000"/);
  assert.match(html, /id="stream-detail"/);
  assert.match(app, /window\.devicePixelRatio \|\| 1/);
  assert.match(app, /if \(sendViewport\(\) && \$\("stream-bitrate"\)\.value === "auto"\) send\(\{ type: "quality"/);
  assert.match(app, /Waiting up to 10 seconds for ICE to recover/);
});

test("fullscreen denial never prevents ESP Wake connection but remains an error for manual selection", async () => {
  const guard = app.slice(app.indexOf("    try {\n      await fullscreenRequest;"), app.indexOf('    if (!window.isSecureContext'));
  for (const automatic of [true, false]) {
    const context = {
      automatic,
      fullscreenRequest: Promise.reject(new Error("user activation required")),
      $: () => ({ textContent: "" }),
    };
    const result = runInNewContext(`(async () => { ${guard}; return true; })()`, context);
    if (automatic) {
      assert.equal(await result, true);
    } else await assert.rejects(result, /user activation required/);
  }
});

test("motion buffering stays near one MTU and RTT feedback preserves its probe identity", () => {
  const source = app.slice(app.indexOf("const sendMotion ="), app.indexOf("const accessory ="));
  const messages = [];
  const context = {
    motionChannel: { readyState: "open", bufferedAmount: 0, send: data => messages.push(JSON.parse(data)) },
    motionSequence: 10,
  };
  runInNewContext(`${source}; globalThis.sendMotion = sendMotion;`, context);
  assert.equal(context.sendMotion({ type: "latency-report", sequence: 42, rttMs: 16 }), true);
  assert.equal(messages[0].sequence, 42);
  assert.equal(context.sendMotion({ type: "move", x: .2, y: .3 }), true);
  assert.equal(messages[1].sequence, 11);
  context.motionChannel.bufferedAmount = 1200;
  assert.equal(context.sendMotion({ type: "latency-ping", sequence: 43 }), false);
  assert.equal(messages.length, 2);
  context.motionChannel.readyState = "closed";
  assert.equal(context.sendMotion({ type: "move", x: .3, y: .4 }), false);
  assert.match(app, /if \(sendMotion\(\{ type: "latency-ping", sequence \}\)\) pendingPings\.set/);
  assert.match(app, /capabilities\.latencyControl \? 250 : 1250/);
});
