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
  videoFrameRate,
  visibleViewport,
} from "./protocol.mjs?v=20261110-latency";
import { controlLatency } from "./latency.mjs?v=20261110-rtt";
import { separateStreamsSupported, gatherOffer } from "./input-transport.mjs?v=20261110-split";
import { installImmersive } from "./immersive.mjs?v=20261110-stability";
import { installGamepads } from "./gamepad.mjs?v=20261110-stability";
import { installKeyboardAccessory } from "./keyboard-accessory.mjs?v=20261109-accessory";
import { installFloatingMenu } from "./floating-menu.mjs?v=20261109-menu1";

const $ = (id) => document.getElementById(id);
const screen = $("screen");
let pc, inputPeer, audioPeer, channel, motionChannel, endpoint, token, sessionId, resizeTimer, motionFrame, statsTimer, latencyTimer;
let generation = 0;
let backend = "standalone";
let queuePosition = 0;
let displayLeader = false;
let capabilities = { touch: false, pen: false };
let composingText = false;
let committedComposition;
let keyboardVisible = false;
let keyboardObserved = false;
let keyboardViewportHeight = 0, keyboardViewportWidth = 0;
let lastDimensions;
let micChannel, micStream, micContext, trustPopup, trustOrigin, trustNonce, trustTimer, verifiedTrustOrigin;
let stopPromise;
let remoteLaunch;
let returnToESPWake = false, handoffOpener, handoffBroker, handoffNonce, handoffRefreshDeadline;
let automaticConnection = false;
let handoffConnecting = false, connectionStarting = false;
let viewerId, returnInSameWindow = false;
let focusRequest = 0, pendingFocus = 0, focusTimer;
let lastTextFocusIdentity = "";
let textTap;
let pendingFocusCheck = 0, focusCheckTimer;
const contactGenerations = new Map();
const activePointers = new Map();
const pendingMotions = new Map();
const pendingPings = new Map();
const latencySamples = [];
let pingSequence = 0;
let lastRttAt = 0;
let motionSequence = 0;
const status = (text) => { $("status").textContent = $("stream-status").textContent = $("stream-loading").textContent = text; };
const viewport = () => visibleViewport(window.visualViewport, { width: innerWidth, height: innerHeight }, navigator.virtualKeyboard?.boundingRect);
const dimensions = () => {
  const size = viewport();
  return viewportDimensions(size,
    $("stream-detail").value === "auto" ? window.devicePixelRatio || 1 : Number($("stream-detail").value));
};
function requestedQuality() {
  const size = dimensions(), fps = videoFrameRate(size.width, size.height, Number($("stream-fps").value));
  const bitrateKbps = $("stream-bitrate").value === "auto" ? automaticBitrate(size.width, size.height, fps) : Number($("stream-bitrate").value);
  return { fps, bitrateKbps };
}
async function waitForViewport() {
  const deadline = Date.now() + 15000;
  while (document.hidden || viewport().width < 100 || viewport().height < 100) {
    status("Open RemotePC in the foreground to connect at your device resolution.");
    if (Date.now() >= deadline) throw new Error("RemotePC has no visible device viewport. Bring the app to the foreground and reconnect.");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
async function startPlayback(enableAudio = false) {
  try {
    const muted = await playDesktop(screen, enableAudio);
    $("desktop-audio").textContent = muted ? "Enable desktop audio" : "Mute desktop audio";
    $("playback-status").textContent = muted ? "Video is playing. Enable desktop audio in the menu or tap the video." : "";
  } catch (error) {
    $("playback-status").textContent = `Playback failed: ${error.message}`;
  }
}
try {
  const saved = localStorage.getItem("njk-host-origin");
  if (saved) $("host").value = new URL(hostEndpoint(saved)).origin;
} catch (error) { console.warn("Host address could not be restored:", error.message); }
function saveHost() {
  const origin = new URL(hostEndpoint($("host").value)).origin;
  try { localStorage.setItem("njk-host-origin", origin); }
  catch (error) { status(`Host address could not be saved: ${error.message}`); }
  return origin;
}
try {
  $("latency-adaptation").checked = localStorage.getItem("njk-latency-adaptation") === "true";
} catch (error) { console.warn("RTT preference could not be restored:", error.message); }
$("latency-adaptation").addEventListener("change", () => {
  const enabled = $("latency-adaptation").checked;
  try { localStorage.setItem("njk-latency-adaptation", String(enabled)); }
  catch (error) { status(`RTT preference could not be saved: ${error.message}`); }
  if (capabilities.latencyAdaptation) send({ type: "latency-policy", enabled });
  $("quality-request").textContent = "";
});
const launchParameters = new URLSearchParams(location.hash.slice(1));
if (launchParameters.has("ticket")) {
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const host = new URL(hostEndpoint(launchParameters.get("host") || "")).origin;
    const ticket = launchParameters.get("ticket");
    if (!/^[a-f0-9]{32}$/.test(ticket || "")) throw new Error("Invalid ESP Wake connection ticket.");
    $("host").value = host;
    $("connect-fullscreen").checked = false;
    remoteLaunch = { host, ticket };
    remoteLaunch.prepared = launchParameters.get("prepared") === "1";
    remoteLaunch.profileId = launchParameters.get("profileId") || undefined;
    viewerId = launchParameters.get("clientId") || undefined;
    if (viewerId && !/^[a-f0-9]{32}$/.test(viewerId)) throw new Error("Invalid remote device identity.");
    returnInSameWindow = launchParameters.get("sameWindow") === "1";
    returnToESPWake = launchParameters.get("return") === "espwake";
    handoffNonce = launchParameters.get("nonce");
    handoffOpener = returnToESPWake && handoffNonce ? window.opener : null;
    if (returnToESPWake && handoffNonce && typeof BroadcastChannel === "function") {
      handoffBroker = new BroadcastChannel(`njk-handoff-${handoffNonce}`);
    }
  } catch (error) { status(error.message); }
}
const send = (message) => {
  if (channel?.readyState !== "open") return;
  if (channel.bufferedAmount >= 65536) {
    pc?.close();
    return;
  }
  channel.send(JSON.stringify(message));
};
const sendMotion = (message) => {
  if (motionChannel?.readyState === "open" && motionChannel.bufferedAmount < 1200) {
    motionChannel.send(JSON.stringify({ ...message, sequence: ["latency-ping", "latency-report"].includes(message.type) ? message.sequence : ++motionSequence }));
    return true;
  }
  return false;
};
const accessory = installKeyboardAccessory($("keyboard-accessory"), send);
const release = () => {
  accessory.release();
  for (const contact of activePointers.values()) send({ ...contact, phase: "cancel" });
  activePointers.clear();
  pendingMotions.clear();
  if (motionFrame) cancelAnimationFrame(motionFrame);
  motionFrame = undefined;
  send({ type: "release", ...(capabilities.gamepadFocusRetention ? { preserveGamepads: true } : {}) });
  if (!capabilities.gamepadFocusRetention) gamepads.refresh();
};
if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true;
function setKeyboard(visible, automatic = false) {
  const changed = keyboardVisible !== visible;
  keyboardVisible = visible;
  if (!visible) {
    accessory.release();
  }
  $("remote-text").hidden = false;
  $("remote-text").inputMode = visible || (changed && navigator.virtualKeyboard) ? "text" : "none";
  $("remote-text").setAttribute("virtualkeyboardpolicy", navigator.virtualKeyboard ? "manual" : "auto");
  $("remote-text-label").hidden = $("remote-text-help").hidden = !visible;
  $("soft-keyboard").setAttribute("aria-pressed", String(visible));
  $("soft-keyboard").setAttribute("data-keyboard-retry", String(visible && automatic));
  if (visible) {
    scheduleFocusCheck();
    if (changed && !navigator.virtualKeyboard && document.activeElement === $("remote-text")) $("remote-text").blur();
    showKeyboard();
  } else {
    keyboardObserved = false;
    clearTimeout(focusTimer);
    pendingFocus = 0;
    const blur = () => {
      if (keyboardVisible) return;
      $("remote-text").inputMode = "none";
      $("remote-text").blur();
    };
    if (changed && navigator.virtualKeyboard) {
      $("remote-text").focus({ preventScroll: true });
      // Android must process the no-keyboard policy while the editor still
      // has focus; blurring in the same frame can discard the hide request.
      requestAnimationFrame(() => {
        if (keyboardVisible) return;
        navigator.virtualKeyboard.hide();
        $("remote-text").inputMode = "none";
        $("remote-text").setAttribute("virtualkeyboardpolicy", "auto");
        requestAnimationFrame(blur);
      });
    } else blur();
  }
}
function primeKeyboardGesture() {
  if (keyboardVisible) return;
  const field = $("remote-text");
  field.hidden = false;
  // Chromium can show a manually controlled keyboard after the host reply,
  // provided the text field was focused with a text input mode in the gesture.
  field.inputMode = navigator.virtualKeyboard ? "text" : "none";
  field.setAttribute("virtualkeyboardpolicy", "manual");
  field.focus({ preventScroll: true });
}
function observeKeyboardGeometry() {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? innerHeight;
  const width = viewport?.width ?? innerWidth;
  const explicitHeight = navigator.virtualKeyboard?.boundingRect?.height;
  if (!keyboardViewportHeight || Math.abs(width - keyboardViewportWidth) > 80) {
    keyboardViewportHeight = height;
    keyboardViewportWidth = width;
  }
  if (!keyboardVisible) {
    keyboardViewportHeight = Math.max(keyboardViewportHeight, height);
    return;
  }
  const visible = explicitHeight > 0 || keyboardViewportHeight - height > Math.max(100, keyboardViewportHeight * .15);
  if (visible) keyboardObserved = true;
  else if (keyboardObserved) setKeyboard(false);
}
function showKeyboard() {
  $("remote-text").focus({ preventScroll: true });
  try { navigator.virtualKeyboard?.show(); }
  catch (error) { $("keyboard-status").textContent = `Browser keyboard request was limited: ${error.message}. Tap Keyboard to retry.`; }
}
function acceptTextFocus(message) {
  const identity = message.editable && /^[1-9][0-9]{0,18}$/.test(message.focusId || "") ? message.focusId : "";
  const repeated = !!identity && identity === lastTextFocusIdentity;
  lastTextFocusIdentity = identity;
  return repeated;
}
function scheduleFocusCheck() {
  clearTimeout(focusCheckTimer);
  if ((!lastTextFocusIdentity && !keyboardVisible) || backend !== "native-host" || channel?.readyState !== "open") return;
  focusCheckTimer = setTimeout(() => {
    if (pendingFocus || activePointers.size) { scheduleFocusCheck(); return; }
    const request = ++focusRequest;
    pendingFocusCheck = request;
    send({ type: "focus-check", request });
    focusCheckTimer = setTimeout(() => {
      if (pendingFocusCheck !== request) return;
      pendingFocusCheck = 0;
      $("keyboard-status").textContent = "Host focus monitoring timed out. Use Keyboard manually or reconnect to an updated Host.";
      focusCheckTimer = setTimeout(scheduleFocusCheck, 2000);
    }, 5000);
  }, 500);
}
const immersive = installImmersive({ send, sendMotion, release, screen, setKeyboard, available: () => channel?.readyState === "open" });
installFloatingMenu($("stream-tools"), $("stream-shell"), text => { $("capture-status").textContent = text; });
$("stream-tools").querySelector("summary").addEventListener("pointerdown", event => {
  if (keyboardVisible && document.activeElement === $("remote-text")) event.preventDefault();
});
const gamepads = installGamepads({ send, available: () => capabilities.gamepad && channel?.readyState === "open" && queuePosition === 0 && !document.hidden && document.hasFocus(),
  report: text => { $("gamepad-status").textContent = text; } });

function stop(notify = true) {
  if (stopPromise) return stopPromise;
  stopPromise = stopSession(notify).finally(() => { stopPromise = undefined; });
  return stopPromise;
}
async function stopSession(notify) {
  lastTextFocusIdentity = "";
  clearTimeout(focusCheckTimer);
  pendingFocusCheck = 0;
  textTap = undefined;
  ++generation;
  clearTimeout(resizeTimer);
  clearInterval(statsTimer);
  clearInterval(latencyTimer);
  clearTimeout(focusTimer);
  pendingFocus = 0;
  release();
  gamepads.stop();
  $("gamepad").disabled = true;
  setKeyboard(false);
  await immersive.disconnected();
  channel?.close();
  motionChannel?.close();
  await stopMicrophone();
  micChannel?.close();
  inputPeer?.close();
  audioPeer?.close();
  pc?.close();
  channel = motionChannel = pc = inputPeer = audioPeer = undefined;
  screen.srcObject = null;
  screen.muted = true;
  $("playback-status").textContent = "";
  $("desktop-audio").disabled = true;
  $("stream-shell").hidden = true;
  $("stream-loading").hidden = true;
  document.body.classList.remove("streaming");
  document.querySelector('meta[name="theme-color"]').content = "#14231d";
  document.documentElement.style.removeProperty("--viewport-height");
  document.documentElement.style.removeProperty("--viewport-top");
  lastDimensions = undefined;
  composingText = false;
  committedComposition = undefined;
  $("remote-text").textContent = "";
  navigator.keyboard?.unlock();
  $("connection").hidden = false;
  $("connect").disabled = false;
  $("disconnect").disabled = $("fullscreen").disabled = true;
  $("microphone").disabled = true;
  $("apply-quality").disabled = true;
  $("exit-quit").disabled = true;
  $("latency").textContent = "Control RTT: measuring…";
  $("quality-request").textContent = "";
  $("audio-status").textContent = "";
  capabilities = { touch: false, pen: false };
  queuePosition = 0;
  displayLeader = false;
  contactGenerations.clear();
  pendingPings.clear();
  latencySamples.length = 0;
  lastRttAt = 0;
  const oldEndpoint = endpoint, oldToken = token, oldId = sessionId;
  endpoint = token = sessionId = undefined;
  if (notify && oldEndpoint && oldToken && oldId) {
    try { await fetch(oldEndpoint, { method: "DELETE", headers: { Authorization: `Bearer ${oldToken}`, "Content-Type": "application/json" }, body: JSON.stringify({id: oldId}), cache: "no-store", keepalive: true }); }
    catch { /* Closing DTLS also releases the host session. */ }
  }
  status("Disconnected.");
}

$("connection").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (connectionStarting || sessionId) return;
  connectionStarting = true;
  const automatic = automaticConnection;
  automaticConnection = false;
  $("connection").hidden = true;
  $("stream-shell").hidden = false;
  $("stream-loading").hidden = false;
  document.body.classList.add("streaming");
  document.querySelector('meta[name="theme-color"]').content = "#000000";
  status("Connecting…");
  const fullscreenRequest = requestFullscreenInGesture(document.documentElement, $("connect-fullscreen").checked);
  $("connect").disabled = true;
  const attempt = ++generation;
  try {
    try {
      await fullscreenRequest;
    } catch (error) {
      if (!automatic) throw error;
      $("capture-status").textContent = `Fullscreen needs a screen tap: ${error.message}`;
    }
    if (!window.isSecureContext || !window.RTCPeerConnection) throw new Error("A secure browser with WebRTC is required.");
    await waitForViewport();
    endpoint = hostEndpoint($("host").value);
    saveHost();
    token = $("token").value;
    if (token.length < 32) throw new Error("Access token must contain at least 32 characters.");
    $("token").value = "";
    const separateStreams = await separateStreamsSupported(endpoint, token);
    if (attempt !== generation) return;
    status("Negotiating authenticated WebRTC…");
    const peer = new RTCPeerConnection();
    let captureFailure = "";
    pc = peer;
    const controls = separateStreams ? new RTCPeerConnection() : peer;
    const sound = separateStreams ? new RTCPeerConnection() : peer;
    inputPeer = separateStreams ? controls : undefined;
    audioPeer = separateStreams ? sound : undefined;
    const video = peer.addTransceiver("video", { direction: "recvonly" });
    const h264 = RTCRtpReceiver.getCapabilities("video")?.codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264");
    if (!h264?.length) throw new Error("This browser does not support H.264 WebRTC decoding.");
    video.setCodecPreferences(h264);
    sound.addTransceiver("audio", { direction: "recvonly" });
    channel = controls.createDataChannel("input", { ordered: true });
    motionChannel = controls.createDataChannel("motion", { ordered: false, maxRetransmits: 0 });
    micChannel = sound.createDataChannel("microphone", { ordered: false, maxRetransmits: 0 });
    channel.addEventListener("open", () => {
      send({ type: "resize", ...dimensions() });
      if ($("gamepad").checked) gamepads.start();
      if (capabilities.latencyAdaptation) send({ type: "latency-policy", enabled: $("latency-adaptation").checked });
    });
    channel.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "queue") {
          queuePosition = message.position;
          status(message.active ? "Your browser controls the stream; waiting for video frames…" : `Watching the shared stream; ${message.position} browser session(s) ahead for control.`);
          if (message.active) gamepads.resume();
          else gamepads.release();
        }
        if (message.type === "leadership") displayLeader = message.leader === true;
        if (message.type === "quality" && message.fps && message.bitrateKbps) {
          if (message.success !== false) $("stream-fps").value = String(message.fps);
          $("quality-request").textContent = message.success === false
            ? "Host rejected the quality change."
            : `Host accepted ${message.fps} FPS · ${message.bitrateKbps} kbps; waiting for encoder confirmation.`;
        }
        if (message.type === "bitrate-applied") {
          $("quality-request").textContent = message.success === true
            ? `Encoder applied ${message.bitrateKbps} kbps.`
            : "Encoder could not apply the bitrate change. Previous quality remains active.";
        }
        if (message.type === "audio-feedback" && typeof message.blocked === "boolean") {
          $("audio-status").textContent = message.blocked
            ? "Audio silenced for this same-host viewer to prevent speaker feedback. Remote devices retain desktop audio."
            : "Desktop audio enabled for this viewer.";
        }
        if (message.type === "latency-budget") {
          $("quality-request").textContent = message.atMinimum
            ? "Video: 300 kbps · Waiting for network recovery."
            : `Video: ${message.bitrateKbps} kbps · RTT budget ${message.targetMs} ms.`;
        }
        if (message.type === "text-focus" && typeof message.editable === "boolean") {
          if (message.checkOnly === true) {
            if (!pendingFocusCheck || message.request !== pendingFocusCheck) return;
            pendingFocusCheck = 0;
            const identity = message.editable ? message.focusId : "";
            if (identity !== lastTextFocusIdentity) lastTextFocusIdentity = "";
            if (!message.editable) {
              setKeyboard(false);
              $("keyboard-status").textContent = "";
            }
            scheduleFocusCheck();
            return;
          }
          if (message.request !== pendingFocus || !pendingFocus) return;
          pendingFocus = 0;
          const repeated = acceptTextFocus(message);
          $("keyboard-status").textContent = message.editable ? "Host text field focused. Tap it again to open the keyboard." : "";
          if (repeated && activePointers.size === 0 && !keyboardVisible) setKeyboard(true, true);
          if (!message.editable) {
            setKeyboard(false);
          }
          scheduleFocusCheck();
        }
        if (message.type === "gamepad") $("gamepad-status").textContent = message.success === false
          ? "Host could not allocate the virtual gamepad. Check the installed controller driver."
          : "Native gamepad connected.";
        if (message.success === false && ["capture-failed", "started"].includes(message.type)) {
          captureFailure = message.reason === "bridge-disconnected"
            ? "Native Host bridge disconnected. Reconnect after the service is ready."
            : "Native capture failed. Check the Host virtual display and encoder before reconnecting.";
          status(captureFailure);
          return;
        }
        if (message.success === false) status(`Host ${message.type} failed.`);
      } catch { /* Ignore messages outside the negotiated JSON control protocol. */ }
    });
    motionChannel.addEventListener("open", () => {
      clearInterval(latencyTimer);
      latencyTimer = setInterval(() => {
        const now = performance.now();
        for (const [sequence, started] of pendingPings) {
          if (now - started > 5000) pendingPings.delete(sequence);
        }
        if (queuePosition !== 0) {
          $("latency").textContent = "Control RTT: waiting for control turn";
          return;
        }
        if (lastRttAt && now - lastRttAt > 5000) $("latency").textContent = "Control RTT: no recent reply";
        if (motionChannel?.readyState !== "open" || pendingPings.size >= 2) return;
        const sequence = ++pingSequence;
        if (sendMotion({ type: "latency-ping", sequence })) pendingPings.set(sequence, now);
      }, capabilities.latencyControl ? 250 : 1250);
    });
    motionChannel.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type !== "latency-pong" || !pendingPings.has(message.sequence)) return;
        const rtt = performance.now() - pendingPings.get(message.sequence);
        pendingPings.delete(message.sequence);
        lastRttAt = performance.now();
        if (capabilities.latencyAdaptation && !document.hidden) sendMotion({ type: "latency-report", sequence: message.sequence, rttMs: rtt });
        latencySamples.push(rtt);
        if (latencySamples.length > 40) latencySamples.shift();
        const { median, p95, max } = controlLatency(latencySamples);
        $("latency").textContent = `Control RTT: ${Math.round(median)} ms median · p95 ${Math.ceil(p95)} ms · max ${Math.ceil(max)} ms`;
      } catch { /* Ignore messages outside the motion protocol. */ }
    });
    const receiveTrack = ({ track, receiver, streams }) => {
      if (pc !== peer) return;
      for (const property of ["jitterBufferTarget", "playoutDelayHint"]) {
        if (!(property in receiver)) continue;
        try { receiver[property] = 0; }
        catch (error) {
          console.warn(`Could not set ${track.kind} ${property}:`, error);
          $("capture-status").textContent = `Browser limited low-buffer ${track.kind} playback: ${error.message}`;
        }
      }
      const stream = screen.srcObject || streams[0] || new MediaStream();
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      if (screen.srcObject !== stream) screen.srcObject = stream;
      startPlayback();
    };
    peer.addEventListener("track", receiveTrack);
    if (separateStreams) sound.addEventListener("track", receiveTrack);
    function watchConnection(transport, name) {
      let recoveryTimer;
      transport.addEventListener("connectionstatechange", () => {
        if (pc !== peer) return;
        clearTimeout(recoveryTimer);
        if (transport.connectionState === "disconnected") {
          status(captureFailure || `${name} network interrupted. Waiting up to 10 seconds for ICE to recover…`);
          recoveryTimer = setTimeout(() => {
            if (pc === peer && transport.connectionState === "disconnected") stop().then(() => status(captureFailure || `${name} network did not recover. Reconnect when the host is reachable.`));
          }, 10000);
        } else if (["failed", "closed"].includes(transport.connectionState)) {
          stop().then(() => status(captureFailure || `${name} connection lost. Check host DNS, network/firewall, trusted TLS certificate, and UDP/ICE or TURN configuration.`));
        }
      });
    }
    watchConnection(peer, "Video");
    if (separateStreams) {
      watchConnection(controls, "Input");
      watchConnection(sound, "Audio");
    }
    await Promise.all([gatherOffer(peer), ...(separateStreams ? [gatherOffer(controls), gatherOffer(sound)] : [])]);
    if (attempt !== generation) return;
    const offerEndpoint = endpoint, offerToken = token, offeredDimensions = dimensions();
    const response = await fetch(offerEndpoint, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: peer.localDescription.sdp, ...offeredDimensions, ...requestedQuality(), latencyAdaptation: $("latency-adaptation").checked, ...(viewerId ? { clientId: viewerId } : {}), ...(separateStreams ? { inputSdp: controls.localDescription.sdp, audioSdp: sound.localDescription.sdp } : {}) }),
      cache: "no-store", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const body = await response.text();
      const details = response.status === 401 ? "The access token was rejected."
        : response.status === 403 ? "The GitHub Pages origin is not allowlisted by the gateway."
        : response.status === 503 ? "The native host bridge is unavailable. Check that the host and gateway are running."
        : response.status === 429 ? "The browser session queue is full."
        : body || "The gateway refused the connection.";
      throw new Error(`Gateway error ${response.status}: ${details}`);
    }
    const answer = await response.json();
    if (attempt !== generation) {
      peer.close();
      await fetch(offerEndpoint, { method: "DELETE", headers: { Authorization: `Bearer ${offerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: answer.id }), cache: "no-store", keepalive: true });
      return;
    }
    sessionId = answer.id;
    if (separateStreams && (!answer.inputSdp || !answer.audioSdp)) throw new Error("Host did not negotiate the requested separate audio/input connections.");
    backend = answer.capture;
    capabilities = { touch: answer.capabilities?.touch === true, pen: answer.capabilities?.pen === true, gamepad: answer.capabilities?.gamepad === true, gamepadFocusRetention: answer.capabilities?.gamepadFocusRetention === true, latencyControl: answer.capabilities?.latencyControl === true, latencyAdaptation: answer.capabilities?.latencyAdaptation === true };
    $("latency-adaptation").disabled = !capabilities.latencyAdaptation;
    $("gamepad").disabled = !capabilities.gamepad;
    if (capabilities.gamepad && $("gamepad").checked) gamepads.start();
    $("gamepad-status").textContent = capabilities.gamepad
      ? ($("gamepad").checked ? "Gamepad input enabled. Press a controller button." : "Enable gamepad input, then press a controller button.")
      : "Native gamepad input is unavailable.";
    $("input-capabilities").textContent = backend === "native-host"
      ? `Host input: ${capabilities.touch ? "multitouch" : "no multitouch"} · ${capabilities.pen ? "stylus pressure/tilt/eraser" : "no stylus input"}. Unsupported inputs are not converted to mouse.`
      : "Standalone gateway supports mouse input only; native multitouch and stylus are unavailable.";
    $("input-capabilities").textContent += separateStreams
      ? " Video, audio and input use three independent encrypted WebRTC connections."
      : " Legacy Host: input shares the media WebRTC connection.";
    $("microphone").disabled = !answer.microphone;
    $("apply-quality").disabled = answer.capabilities?.quality !== true;
    $("exit-quit").disabled = answer.capabilities?.quit !== true;
    if (answer.quality) {
      $("stream-fps").value = String(answer.quality.fps);
      $("video-quality").textContent = `${answer.quality.fps} FPS · ${answer.quality.bitrateKbps} kbps`;
    }
    lastDimensions = offeredDimensions;
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    if (separateStreams) await Promise.all([
      controls.setRemoteDescription({ type: "answer", sdp: answer.inputSdp }),
      sound.setRemoteDescription({ type: "answer", sdp: answer.audioSdp }),
    ]);
    $("connection").hidden = true;
    $("stream-shell").hidden = false;
    document.body.classList.add("streaming");
    resized();
    immersive.connected({ autoEnter: $("connect-fullscreen").checked, requestFullscreen: false });
    $("disconnect").disabled = $("fullscreen").disabled = false;
    $("desktop-audio").disabled = false;
    status("WebRTC negotiated. Waiting for actual video frames…");
    let previousVideo;
    statsTimer = setInterval(async () => {
      if (pc !== peer) return;
      const stats = await peer.getStats();
      if (pc !== peer) return;
      let decoded = 0;
      for (const report of stats.values()) {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          decoded += report.framesDecoded || 0;
          if (previousVideo && report.timestamp > previousVideo.timestamp) {
            const seconds = (report.timestamp - previousVideo.timestamp) / 1000;
            const fps = Math.max(0, (report.framesDecoded - previousVideo.framesDecoded) / seconds);
            const kbps = Math.max(0, (report.bytesReceived - previousVideo.bytesReceived) * 8 / seconds / 1000);
            const emitted = (report.jitterBufferEmittedCount || 0) - previousVideo.emitted;
            const bufferMs = emitted > 0 ? Math.max(0, ((report.jitterBufferDelay || 0) - previousVideo.delay) * 1000 / emitted) : 0;
            $("video-quality").textContent = `${fps.toFixed(1)} decoded FPS · ${Math.round(kbps)} kbps · ${report.framesDropped || 0} dropped frames · ${Math.round(bufferMs)} ms video buffer`;
          }
          previousVideo = { timestamp: report.timestamp, framesDecoded: report.framesDecoded || 0, bytesReceived: report.bytesReceived || 0,
            emitted: report.jitterBufferEmittedCount || 0, delay: report.jitterBufferDelay || 0 };
        }
      }
      if (decoded > 0 && queuePosition === 0) status(`Streaming · ${screen.videoWidth}×${screen.videoHeight} · ${decoded} decoded frames · ${backend === "native-host" ? (displayLeader ? "display leader" : "shared display follower") : "standalone"}`);
    }, 2000);
    if (!keyboardVisible) screen.focus({ preventScroll: true });
  } catch (error) {
    if (attempt !== generation) return;
    await stop();
    const detail = isTransientNetworkError(error)
      ? "The gateway could not be reached. Check the hostname DNS result (including NXDOMAIN), network/firewall and the configured HTTPS port (Host base + 22 for grouped ports), then verify that the TLS certificate is trusted and matches the host name. Use “Trust host certificate…” to open the browser's manual certificate screen."
      : error.message;
    status(`${detail} GitHub Pages also requires its exact origin to be allowlisted and local-network access permission.`);
  } finally { connectionStarting = false; }
});

const exitDialog = $("exit-dialog");
$("disconnect").addEventListener("click", () => { release(); $("exit-error").textContent = ""; exitDialog.showModal(); });
$("exit-cancel").addEventListener("click", () => exitDialog.close());
async function leaveSession(quit) {
  if (!endpoint || !sessionId) { exitDialog.close(); await stop(false); return; }
  for (const id of ["exit-disconnect", "exit-quit"]) $(id).disabled = true;
  try {
    const response = await fetch(endpoint, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, quit }), cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(await response.text() || `Gateway error ${response.status}`);
    exitDialog.close();
    await stop(false);
    if (returnToESPWake) {
      if (returnInSameWindow) location.replace("https://taducanh1605.github.io/espwake/");
      else {
        window.close();
        setTimeout(() => { if (!window.closed) location.replace("https://taducanh1605.github.io/espwake/"); }, 250);
      }
    }
  } catch (error) { status(`Unable to ${quit ? "quit" : "disconnect"}: ${error.message}`); $("exit-error").textContent = error.message; }
  finally { for (const id of ["exit-disconnect", "exit-quit"]) $(id).disabled = false; }
}
$("exit-disconnect").addEventListener("click", () => leaveSession(false));
$("exit-quit").addEventListener("click", () => leaveSession(true));
$("apply-quality").addEventListener("click", () => {
  resized();
  sendViewport();
  const { fps, bitrateKbps } = requestedQuality();
  send({ type: "quality", fps, bitrateKbps });
  $("quality-request").textContent = `Requested ${fps} FPS · ${bitrateKbps} kbps; waiting for host.`;
});
function flushMotions() {
  motionFrame = undefined;
  const motions = [...pendingMotions.values()];
  pendingMotions.clear();
  motions.forEach(sendMotion);
  if (motions.length) motionFrame = requestAnimationFrame(flushMotions);
}
function queueMotion(message) {
  if (!motionFrame) {
    sendMotion(message);
    motionFrame = requestAnimationFrame(flushMotions);
    return;
  }
  const key = message.type === "move" ? "mouse" : `${message.type}:${message.id}:${message.generation}`;
  pendingMotions.set(key, message);
}
function nextGeneration(pointerId) {
  const value = nextContactGeneration(contactGenerations.get(pointerId));
  contactGenerations.set(pointerId, value);
  return value;
}
function nativePointerType(type) {
  return type === "touch" ? capabilities.touch : capabilities.pen;
}
function beginPointer(event, type) {
  const generation = nextGeneration(event.pointerId);
  const contact = pointerControl(event, screen, type, "down", generation);
  if (!contact) return false;
  activePointers.set(event.pointerId, contact);
  send(contact);
  queueMotion({ ...contact, phase: "move" });
  return true;
}
function movePointer(event, type) {
  const generation = contactGenerations.get(event.pointerId);
  if (!generation) return;
  const latest = coalescedPointerEvent(event);
  if (!activePointers.has(event.pointerId)) return;
  const message = pointerControl(latest, screen, type, "move", generation);
  if (message) queueMotion(message);
}
function endPointer(event, type, phase = "up") {
  const contact = activePointers.get(event.pointerId);
  if (!contact || contact.type !== type) return;
  const position = pointerPosition(event, screen);
  send({ ...contact, phase, ...(position || {}) });
  activePointers.delete(event.pointerId);
  pendingMotions.delete(`${type}:${event.pointerId}:${contact.generation}`);
}
async function stopMicrophone() {
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = undefined;
  const context = micContext;
  micContext = undefined;
  if (context) await context.close().catch(() => {});
  $("microphone").textContent = "Enable microphone";
  $("microphone").setAttribute("aria-pressed", "false");
}
$("microphone").addEventListener("click", async () => {
  if (micStream) { await stopMicrophone(); return; }
  $("microphone").disabled = true;
  try {
    if (micChannel?.readyState !== "open") throw new Error("Host microphone channel is unavailable.");
    const peer = pc;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
    micStream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => stopMicrophone()));
    if (pc !== peer) { await stopMicrophone(); return; }
    micContext = new AudioContext({ sampleRate: 48000 });
    if (micContext.sampleRate !== 48000) throw new Error("Browser cannot provide 48 kHz microphone audio.");
    await micContext.audioWorklet.addModule("./microphone-worklet.js");
    const source = micContext.createMediaStreamSource(micStream);
    const worklet = new AudioWorkletNode(micContext, "njk-microphone-pcm");
    const silent = micContext.createGain();
    silent.gain.value = 0;
    source.connect(worklet).connect(silent).connect(micContext.destination);
    worklet.port.onmessage = ({data}) => {
      if (micChannel?.readyState === "open" && micChannel.bufferedAmount < 7680) micChannel.send(data);
    };
    await micContext.resume();
    $("microphone").textContent = "Disable microphone";
    $("microphone").setAttribute("aria-pressed", "true");
  } catch (error) { await stopMicrophone(); status(`Microphone unavailable: ${error.message}`); }
  finally { if (pc && backend === "native-host") $("microphone").disabled = false; }
});
screen.addEventListener("playing", () => { $("stream-loading").hidden = true; });
screen.addEventListener("click", () => startPlayback(true));
$("desktop-audio").addEventListener("click", () => {
  if (!screen.muted) {
    screen.muted = true;
    $("desktop-audio").textContent = "Enable desktop audio";
  } else startPlayback(true);
});
screen.addEventListener("keydown", (event) => {
  if (event.code === "Escape") { release(); return; }
  send({ type: "key", code: event.code, down: true, ...(event.repeat ? { repeat: true } : {}) });
  event.preventDefault();
});
screen.addEventListener("keyup", (event) => {
  send({ type: "key", code: event.code, down: false });
  event.preventDefault();
});
screen.addEventListener("blur", release);
const resetTextFocus = () => {
  clearTimeout(focusCheckTimer);
  pendingFocusCheck = 0;
  clearTimeout(focusTimer);
  pendingFocus = 0;
  lastTextFocusIdentity = "";
  textTap = undefined;
};
window.addEventListener("blur", () => { resetTextFocus(); release(); gamepads.release(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { resetTextFocus(); release(); gamepads.release(); } });
window.addEventListener("focus", () => { gamepads.resume(); scheduleFocusCheck(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { gamepads.resume(); scheduleFocusCheck(); } });
$("gamepad").addEventListener("change", () => { if ($("gamepad").checked) gamepads.start(); else gamepads.stop(); });
screen.addEventListener("contextmenu", (event) => event.preventDefault());
screen.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch" && backend === "native-host") {
    if (!capabilities.touch) return;
    primeKeyboardGesture();
    screen.setPointerCapture(event.pointerId);
    clearTimeout(focusTimer);
    pendingFocus = 0;
    clearTimeout(focusCheckTimer);
    pendingFocusCheck = 0;
    if (activePointers.size === 0) textTap = { id: event.pointerId, x: event.clientX, y: event.clientY };
    else { textTap = undefined; lastTextFocusIdentity = ""; }
    beginPointer(event, "touch");
    event.preventDefault();
    return;
  }
  if (event.pointerType === "pen" && backend === "native-host") {
    if (!capabilities.pen) return;
    clearTimeout(focusTimer);
    pendingFocus = 0;
    textTap = undefined;
    lastTextFocusIdentity = "";
    clearTimeout(focusCheckTimer);
    pendingFocusCheck = 0;
    if (!keyboardVisible) screen.focus({ preventScroll: true });
    screen.setPointerCapture(event.pointerId);
    beginPointer(event, "pen");
    event.preventDefault();
    return;
  }
  if (!event.isPrimary) return;
  if (document.pointerLockElement === screen) {
    send({ type: "button", button: event.button, down: true });
    event.preventDefault();
    return;
  }
  const position = pointerPosition(event, screen);
  if (!position) return;
  if (!keyboardVisible) screen.focus({ preventScroll: true });
  screen.setPointerCapture(event.pointerId);
  send({ type: "move", ...position });
  send({ type: "button", button: event.button, down: true });
  event.preventDefault();
});
screen.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch" && backend === "native-host") {
    if (textTap && Math.hypot(event.clientX - textTap.x, event.clientY - textTap.y) > 10) {
      textTap = undefined;
      lastTextFocusIdentity = "";
    }
    if (activePointers.has(event.pointerId)) movePointer(event, "touch");
    return;
  }
  if (event.pointerType === "pen" && backend === "native-host") {
    if (capabilities.pen) movePointer(event, "pen");
    return;
  }
  if (document.pointerLockElement === screen) return;
  if (!event.isPrimary) return;
  const position = pointerPosition(event, screen);
  if (position) queueMotion({ type: "move", ...position });
});
screen.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch" && backend === "native-host") {
    endPointer(event, "touch");
    const position = pointerPosition(event, screen);
    if (position && textTap?.id === event.pointerId && activePointers.size === 0) {
      const request = ++focusRequest;
      pendingFocus = request;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        send({ type: "focus", request, ...position });
        focusTimer = setTimeout(() => {
          if (pendingFocus !== request) return;
          pendingFocus = 0;
          lastTextFocusIdentity = "";
          $("keyboard-status").textContent = "Host text focus request timed out. Tap the field again or use Keyboard manually.";
          scheduleFocusCheck();
        }, 5000);
      }, 150);
    }
    textTap = undefined;
    scheduleFocusCheck();
    if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.pointerType === "pen" && backend === "native-host") {
    endPointer(event, "pen");
    scheduleFocusCheck();
    if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (!event.isPrimary) return;
  send({ type: "button", button: event.button, down: false });
  if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
});
screen.addEventListener("pointercancel", (event) => {
  textTap = undefined;
  lastTextFocusIdentity = "";
  if (event.pointerType === "touch") endPointer(event, "touch", "cancel");
  else if (event.pointerType === "pen") endPointer(event, "pen", "cancel");
  else release();
  scheduleFocusCheck();
});
screen.addEventListener("lostpointercapture", (event) => {
  const contact = activePointers.get(event.pointerId);
  if (contact) endPointer(event, contact.type, "cancel");
  else if (event.pointerType !== "touch" && event.pointerType !== "pen") release();
});
screen.addEventListener("wheel", (event) => { send({ type: "wheel", delta: Math.max(-1200,Math.min(1200,event.deltaY)) }); event.preventDefault(); }, { passive: false });
$("remote-text").addEventListener("beforeinput", (event) => {
  if (composingText || event.isComposing) return;
  if (event.inputType === "insertFromComposition" || (committedComposition && event.data === committedComposition)) {
    committedComposition = undefined;
    event.preventDefault();
    return;
  }
  if (event.inputType === "deleteContentBackward") {
    send({type:"key",code:"Backspace",down:true});
    send({type:"key",code:"Backspace",down:false});
  } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
    accessory.text("\n", $("typing-mode").value);
  } else if (event.data && event.cancelable) accessory.text(event.data, $("typing-mode").value);
  if (event.cancelable) event.preventDefault();
});
$("remote-text").addEventListener("compositionstart", () => { composingText = true; });
$("remote-text").addEventListener("compositionend", (event) => {
  composingText = false;
  committedComposition = event.data;
  if (event.data) accessory.text(event.data, $("typing-mode").value);
  setTimeout(() => { committedComposition = undefined; $("remote-text").textContent = ""; }, 0);
});
$("remote-text").addEventListener("input", () => {
  if (composingText) return;
  const text = $("remote-text").textContent;
  if (text && text !== committedComposition) accessory.text(text, $("typing-mode").value);
  $("remote-text").textContent = "";
});
$("remote-text").addEventListener("keydown", event => {
  if (event.isComposing || event.key === "Unidentified" || !event.code || event.key === "Process") return;
  send({ type: "key", code: event.code, down: true, ...(event.repeat ? { repeat: true } : {}) });
  event.preventDefault();
});
$("remote-text").addEventListener("keyup", event => {
  if (event.isComposing || event.key === "Unidentified" || !event.code || event.key === "Process") return;
  send({ type: "key", code: event.code, down: false });
  event.preventDefault();
});
$("remote-text").addEventListener("blur", release);
function sendViewport() {
  const next = dimensions();
  if (next.width === lastDimensions?.width && next.height === lastDimensions?.height) return false;
  if (channel?.readyState !== "open") return false;
  lastDimensions = next;
  send({ type: "resize", ...next });
  return true;
}
const resized = () => {
  observeKeyboardGeometry();
  document.documentElement.style.setProperty("--viewport-height", `${viewport().height}px`);
  document.documentElement.style.setProperty("--viewport-top", "0px");
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (sendViewport() && $("stream-bitrate").value === "auto") send({ type: "quality", ...requestedQuality(), ...(capabilities.latencyControl ? { adaptive: true } : {}) });
  }, 120);
};
window.visualViewport?.addEventListener("resize", resized);
window.visualViewport?.addEventListener("scroll", resized);
navigator.virtualKeyboard?.addEventListener("geometrychange", resized);
window.addEventListener("resize", resized);
document.addEventListener("fullscreenchange", () => { release(); if (!document.fullscreenElement) navigator.keyboard?.unlock(); resized(); });
window.addEventListener("pagehide", () => {
  if (endpoint && token && sessionId) {
    fetch(endpoint, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId }), cache: "no-store", keepalive: true })
      .catch(error => console.warn("Session departure could not be sent:", error.message));
  }
  stop(false);
});
window.addEventListener("beforeunload", event => {
  if (!sessionId) return;
  event.preventDefault();
  event.returnValue = "";
});
function openTrustPage() {
  try {
    const origin = saveHost();
    trustOrigin = origin;
    trustNonce = crypto.randomUUID();
    const url = `${origin}/trust?origin=${encodeURIComponent(location.origin)}&nonce=${trustNonce}`;
    trustPopup = window.open(url, "njk-host-certificate-trust", "popup,width=620,height=760");
    clearInterval(trustTimer);
    const nonce = trustNonce;
    trustTimer = setInterval(async () => {
      if (nonce !== trustNonce) return;
      try {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
        if (response.ok && response.url === url && new URL(response.url).origin === origin && nonce === trustNonce) {
          trustPopup?.close();
          completeTrust(origin, nonce);
        }
      } catch {}
    }, 2000);
    if (!trustPopup) status("Certificate window was blocked. Click “Trust host certificate…” to open it. The original failure may be TLS, CORS, or network; accept only a valid browser certificate warning, and check DNS, firewall, the configured HTTPS port, and the gateway origin allowlist if no warning appears.");
    else status("The browser cannot distinguish an untrusted certificate from CORS or network failure. If a certificate warning appears, verify the host name and accept it manually; a verified response will retry RemotePC automatically. If no warning appears, check DNS, network/firewall, the configured HTTPS port, and the gateway's PWA-origin allowlist.");
  } catch (error) { status(error.message); }
}
$("trust-host").addEventListener("click", openTrustPage);
function completeTrust(origin, nonce) {
  if (origin !== trustOrigin || nonce !== trustNonce) return;
  verifiedTrustOrigin = origin;
  clearInterval(trustTimer);
  trustPopup = trustOrigin = trustNonce = undefined;
  status(remoteLaunch ? "Host certificate acceptance verified. Retrying RemotePC connection…" : "Host certificate acceptance verified. You can now Connect.");
  if (remoteLaunch) connectFromESPWake();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => status(`Offline installation unavailable: ${error.message}`));
async function requestFreshHandoffTicket() {
  handoffRefreshDeadline ||= Date.now() + 90000;
  if (Date.now() >= handoffRefreshDeadline) throw new Error("Remote access could not refresh within 90 seconds. Check the Windows helper and gateway.");
  status("Access expired. Getting a fresh ticket from ESPWake…");
  if (remoteLaunch.profileId && returnInSameWindow && !handoffOpener) {
    return requestSavedESPWakeTicket();
  }
  const data = await new Promise((resolve, reject) => {
    let settled = false, retry, progress;
    const started = Date.now();
    const cleanup = () => {
      settled = true;
      clearTimeout(retry);
      clearTimeout(progress);
      window.removeEventListener("message", receive);
      handoffBroker?.removeEventListener("message", receiveBroadcast);
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error("ESPWake did not provide fresh access. Return to ESPWake, keep it visible, and open RemotePC again. Check the Windows helper if this repeats.")); }, Math.min(30000, handoffRefreshDeadline - Date.now()));
    function accept(data) {
      if (data?.nonce !== handoffNonce || data.type !== "njk-fresh-ticket") return;
      clearTimeout(timeout);
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    }
    function receive(event) {
      if (event.source !== handoffOpener || event.origin !== location.origin) return;
      accept(event.data);
    }
    function receiveBroadcast(event) { accept(event.data); }
    window.addEventListener("message", receive);
    const request = { type: "njk-refresh-ticket", nonce: handoffNonce };
    handoffBroker?.addEventListener("message", receiveBroadcast);
    function requestTicket() {
      if (settled) return;
      handoffBroker?.postMessage(request);
      if (!settled) handoffOpener?.postMessage(request, location.origin);
      if (!settled) retry = setTimeout(requestTicket, 3000);
    }
    function showProgress() {
      if (settled) return;
      status(`Getting fresh access from ESPWake (${Math.floor((Date.now() - started) / 1000)} s). Keep ESPWake visible; return there if it no longer has this connection open.`);
      progress = setTimeout(showProgress, 1000);
    }
    requestTicket();
    if (!settled) progress = setTimeout(showProgress, 1000);
  });
  if (data.host !== remoteLaunch.host || !/^[a-f0-9]{32}$/.test(data.ticket || "")) throw new Error("ESPWake returned an invalid replacement ticket.");
  return data;
}

async function requestSavedESPWakeTicket() {
  const origin = "https://taducanh1605.github.io";
  if (location.origin !== origin || !["/remotepc/", "/remotepc/index.html"].includes(location.pathname) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(remoteLaunch.profileId || "") || !handoffNonce || handoffNonce.length > 128) {
    throw new Error("Automatic ESPWake recovery is unavailable in this context. Return to ESPWake and unlock the selected computer.");
  }
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.title = "ESPWake access recovery";
  frame.src = `${origin}/espwake/#${new URLSearchParams({
    broker: "1", nonce: handoffNonce, profileId: remoteLaunch.profileId, host: remoteLaunch.host,
  })}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); window.removeEventListener("message", receive); frame.remove(); };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Saved ESPWake access could not be restored. Unlock the selected computer in ESPWake and check its connection."));
    }, 30000);
    function receive(event) {
      if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.nonce !== handoffNonce) return;
      if (event.data.type === "njk-broker-ready") {
        frame.contentWindow.postMessage({ type: "njk-refresh-ticket", nonce: handoffNonce }, origin);
      } else if (event.data.type === "njk-fresh-ticket") {
        cleanup();
        if (event.data.error) reject(new Error(event.data.error));
        else if (event.data.host !== remoteLaunch.host || !/^[a-f0-9]{32}$/.test(event.data.ticket || "")) {
          reject(new Error("Saved ESPWake access returned an invalid or mismatched ticket."));
        } else resolve({ host: event.data.host, ticket: event.data.ticket });
      }
    }
    window.addEventListener("message", receive);
    document.body.appendChild(frame);
  });
}
async function connectFromESPWake() {
  if (!remoteLaunch || handoffConnecting) return;
  handoffConnecting = true;
  try {
    if (!remoteLaunch.prepared) {
      const prepared = await fetch(`${remoteLaunch.host}/api/connect-prepare`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: remoteLaunch.ticket }),
        cache: "no-store", signal: AbortSignal.timeout(10000),
      });
      if (prepared.status === 401 && (handoffOpener || handoffBroker || remoteLaunch.profileId)) {
        const data = await requestFreshHandoffTicket();
        remoteLaunch.ticket = data.ticket;
        await new Promise(resolve => setTimeout(resolve, 2500));
        handoffConnecting = false;
        return connectFromESPWake();
      }
      if (!prepared.ok) {
        if (prepared.status === 401) throw new Error("ESP Wake access expired before the host could prepare it. Return to ESPWake and open RemotePC again.");
        throw new Error(`Host access preparation failed (${prepared.status}). Check the gateway version and its exact PWA-origin allowlist.`);
      }
      const result = await prepared.json();
      if (!/^[a-f0-9]{32}$/.test(result.ticket || "") || result.expiresIn < 120) throw new Error("Host returned invalid prepared access.");
      remoteLaunch.ticket = result.ticket;
      remoteLaunch.prepared = true;
    }
    const response = await fetch(`${remoteLaunch.host}/api/connect`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: remoteLaunch.ticket }),
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Host authorization failed (${response.status}). ${await response.text()}`);
    const result = await response.json();
    if (typeof result.token !== "string" || result.token.length < 32) throw new Error("Host returned an invalid connection credential.");
    $("token").value = result.token;
    automaticConnection = true;
    remoteLaunch = undefined;
    handoffOpener?.postMessage({ type: "njk-handoff-complete", nonce: handoffNonce }, location.origin);
    handoffBroker?.postMessage({ type: "njk-handoff-complete", nonce: handoffNonce });
    handoffBroker?.close();
    handoffBroker = undefined;
    handoffOpener = undefined;
    window.opener = null;
    $("connection").requestSubmit();
  } catch (error) {
    if (isTransientNetworkError(error)) {
      if (verifiedTrustOrigin === remoteLaunch?.host) {
        status("Host TLS is verified, but the browser still cannot access the gateway. Check network/firewall, the configured HTTPS port, and the gateway's exact PWA-origin CORS allowlist; retry after fixing access.");
      } else {
        status("The browser could not complete host access. This may be an untrusted certificate, CORS/origin policy, or network failure. The security window will not bypass browser warnings; verified certificate acceptance retries RemotePC automatically.");
        openTrustPage();
      }
    } else {
      remoteLaunch = undefined;
      handoffBroker?.postMessage({ type: "njk-handoff-complete", nonce: handoffNonce });
      handoffBroker?.close();
      handoffBroker = undefined;
      $("handoff-recovery").hidden = !returnToESPWake;
      status(error.message);
    }
  } finally { handoffConnecting = false; }
}
if (remoteLaunch) connectFromESPWake();
