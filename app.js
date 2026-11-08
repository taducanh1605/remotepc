import {
  coalescedPointerEvent,
  hostEndpoint,
  isTransientNetworkError,
  nextContactGeneration,
  pointerControl,
  pointerPosition,
  requestFullscreenInGesture,
  viewportDimensions,
} from "./protocol.mjs";
import { installImmersive } from "./immersive.mjs";

const $ = (id) => document.getElementById(id);
const screen = $("screen");
let pc, channel, motionChannel, endpoint, token, sessionId, resizeTimer, motionFrame, pendingInstall, statsTimer, latencyTimer;
let generation = 0;
let backend = "standalone";
let queuePosition = 0;
let displayLeader = false;
let capabilities = { touch: false, pen: false };
let composingText = false;
let committedComposition;
let micChannel, micStream, micContext, trustPopup, trustOrigin;
const contactGenerations = new Map();
const activePointers = new Map();
const pendingMotions = new Map();
const pendingPings = new Map();
const latencySamples = [];
let pingSequence = 0;
let lastRttAt = 0;
let motionSequence = 0;
const status = (text) => { $("status").textContent = text; };
const dimensions = () => viewportDimensions(window.visualViewport || { width: innerWidth, height: innerHeight }, devicePixelRatio);
const send = (message) => {
  if (channel?.readyState !== "open") return;
  if (channel.bufferedAmount >= 65536) {
    pc?.close();
    return;
  }
  channel.send(JSON.stringify(message));
};
const sendMotion = (message) => {
  if (motionChannel?.readyState === "open" && motionChannel.bufferedAmount < 16384) {
    motionChannel.send(JSON.stringify({ ...message, sequence: message.type === "latency-ping" ? message.sequence : ++motionSequence }));
  }
};
const release = () => {
  for (const contact of activePointers.values()) send({ ...contact, phase: "cancel" });
  activePointers.clear();
  pendingMotions.clear();
  if (motionFrame) cancelAnimationFrame(motionFrame);
  motionFrame = undefined;
  send({ type: "release" });
};
const immersive = installImmersive({ send, sendMotion, release, screen, available: () => channel?.readyState === "open" });

async function stop(notify = true) {
  ++generation;
  clearTimeout(resizeTimer);
  clearInterval(statsTimer);
  clearInterval(latencyTimer);
  release();
  immersive.disconnected();
  channel?.close();
  motionChannel?.close();
  await stopMicrophone();
  micChannel?.close();
  pc?.close();
  channel = motionChannel = pc = undefined;
  screen.srcObject = null;
  $("remote-text").hidden = $("remote-text-label").hidden = $("remote-text-help").hidden = true;
  navigator.keyboard?.unlock();
  $("connection").hidden = false;
  $("connect").disabled = false;
  $("disconnect").disabled = $("fullscreen").disabled = true;
  $("microphone").disabled = true;
  $("latency").textContent = "Control RTT: measuring…";
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
  const fullscreenRequest = requestFullscreenInGesture(document.documentElement, $("connect-fullscreen").checked);
  $("connect").disabled = true;
  const attempt = ++generation;
  try {
    await fullscreenRequest;
    if (!window.isSecureContext || !window.RTCPeerConnection) throw new Error("A secure browser with WebRTC is required.");
    endpoint = hostEndpoint($("host").value);
    token = $("token").value;
    if (token.length < 32) throw new Error("Access token must contain at least 32 characters.");
    $("token").value = "";
    status("Negotiating authenticated WebRTC…");
    const peer = new RTCPeerConnection();
    pc = peer;
    const video = peer.addTransceiver("video", { direction: "recvonly" });
    const h264 = RTCRtpReceiver.getCapabilities("video")?.codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264");
    if (!h264?.length) throw new Error("This browser does not support H.264 WebRTC decoding.");
    video.setCodecPreferences(h264);
    peer.addTransceiver("audio", { direction: "recvonly" });
    channel = peer.createDataChannel("input", { ordered: true });
    motionChannel = peer.createDataChannel("motion", { ordered: false, maxRetransmits: 0 });
    micChannel = peer.createDataChannel("microphone", { ordered: false, maxRetransmits: 0 });
    channel.addEventListener("open", () => send({ type: "resize", ...dimensions() }));
    channel.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "queue") {
          queuePosition = message.position;
          status(message.active ? "Your browser controls the stream; waiting for video frames…" : `Watching the shared stream; ${message.position} browser session(s) ahead for control.`);
        }
        if (message.type === "leadership") displayLeader = message.leader === true;
        if (message.type === "text-focus" && typeof message.editable === "boolean") {
          $("remote-text").hidden = $("remote-text-label").hidden = $("remote-text-help").hidden = !message.editable;
          if (message.editable && activePointers.size === 0) $("remote-text").focus();
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
        pendingPings.set(sequence, now);
        sendMotion({ type: "latency-ping", sequence });
      }, 2000);
    });
    motionChannel.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type !== "latency-pong" || !pendingPings.has(message.sequence)) return;
        const rtt = Math.round(performance.now() - pendingPings.get(message.sequence));
        pendingPings.delete(message.sequence);
        lastRttAt = performance.now();
        latencySamples.push(rtt);
        if (latencySamples.length > 5) latencySamples.shift();
        const sorted = [...latencySamples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        $("latency").textContent = `Control RTT: ${median} ms median`;
      } catch { /* Ignore messages outside the motion protocol. */ }
    });
    peer.addEventListener("track", ({ track }) => {
      if (pc !== peer) return;
      const stream = screen.srcObject || new MediaStream();
      stream.addTrack(track);
      screen.srcObject = stream;
      screen.play().catch(() => status("Media connected. Tap the video to enable playback and audio."));
    });
    peer.addEventListener("connectionstatechange", () => {
      if (pc !== peer) return;
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
        stop().then(() => status("Connection lost. Check host DNS, network/firewall, trusted TLS certificate, and UDP/ICE or TURN configuration."));
      }
    });
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== "complete") {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { peer.removeEventListener("icegatheringstatechange", check); reject(new Error("ICE gathering timed out.")); }, 12000);
        function check() {
          if (peer.iceGatheringState === "complete") { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", check); resolve(); }
        }
        peer.addEventListener("icegatheringstatechange", check);
        check();
      });
    }
    const response = await fetch(endpoint, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: peer.localDescription.sdp, ...dimensions() }),
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
    if (attempt !== generation) { peer.close(); return; }
    sessionId = answer.id;
    backend = answer.capture;
    capabilities = { touch: answer.capabilities?.touch === true, pen: answer.capabilities?.pen === true };
    $("input-capabilities").textContent = backend === "native-host"
      ? `Host input: ${capabilities.touch ? "multitouch" : "no multitouch"} · ${capabilities.pen ? "stylus pressure/tilt/eraser" : "no stylus input"}. Unsupported inputs are not converted to mouse.`
      : "Standalone gateway supports mouse input only; native multitouch and stylus are unavailable.";
    $("microphone").disabled = !answer.microphone;
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    $("connection").hidden = true;
    immersive.connected();
    $("disconnect").disabled = $("fullscreen").disabled = false;
    status("WebRTC negotiated. Waiting for actual video frames…");
    statsTimer = setInterval(async () => {
      if (pc !== peer) return;
      const stats = await peer.getStats();
      let decoded = 0;
      for (const report of stats.values()) {
        if (report.type === "inbound-rtp" && report.kind === "video") decoded += report.framesDecoded || 0;
      }
      if (decoded > 0 && queuePosition === 0) status(`Streaming · ${screen.videoWidth}×${screen.videoHeight} · ${decoded} decoded frames · ${backend === "native-host" ? (displayLeader ? "display leader" : "shared display follower") : "standalone"}`);
    }, 2000);
    screen.focus();
  } catch (error) {
    if (attempt !== generation) return;
    await stop();
    const detail = isTransientNetworkError(error)
      ? "The gateway could not be reached. Check the hostname DNS result (including NXDOMAIN), network/firewall and port 47990, then verify that the TLS certificate is trusted and matches the host name. Use “Trust host certificate…” to open the browser's manual certificate screen."
      : error.message;
    status(`${detail} GitHub Pages also requires its exact origin to be allowlisted and local-network access permission.`);
  }
});

$("disconnect").addEventListener("click", () => stop());
function flushMotions() {
  motionFrame = undefined;
  const motions = [...pendingMotions.values()];
  pendingMotions.clear();
  motions.forEach(sendMotion);
}
function queueMotion(message) {
  const key = message.type === "move" ? "mouse" : `${message.type}:${message.id}:${message.generation}`;
  pendingMotions.set(key, message);
  if (!motionFrame) motionFrame = requestAnimationFrame(flushMotions);
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
screen.addEventListener("click", () => screen.play().catch(() => {}));
screen.addEventListener("keydown", (event) => {
  if (event.code === "Escape") { release(); return; }
  if (!event.repeat) send({ type: "key", code: event.code, down: true });
  event.preventDefault();
});
screen.addEventListener("keyup", (event) => {
  send({ type: "key", code: event.code, down: false });
  event.preventDefault();
});
screen.addEventListener("blur", release);
window.addEventListener("blur", release);
document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });
screen.addEventListener("contextmenu", (event) => event.preventDefault());
screen.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch" && backend === "native-host") {
    if (!capabilities.touch) return;
    screen.focus();
    screen.setPointerCapture(event.pointerId);
    beginPointer(event, "touch");
    event.preventDefault();
    return;
  }
  if (event.pointerType === "pen" && backend === "native-host") {
    if (!capabilities.pen) return;
    screen.focus();
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
  screen.focus();
  screen.setPointerCapture(event.pointerId);
  send({ type: "move", ...position });
  send({ type: "button", button: event.button, down: true });
  event.preventDefault();
});
screen.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch" && backend === "native-host") {
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
    if (position && activePointers.size === 0) send({ type: "focus", ...position });
    if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.pointerType === "pen" && backend === "native-host") {
    endPointer(event, "pen");
    if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (!event.isPrimary) return;
  send({ type: "button", button: event.button, down: false });
  if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
});
screen.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch") endPointer(event, "touch", "cancel");
  else if (event.pointerType === "pen") endPointer(event, "pen", "cancel");
  else release();
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
  } else if (event.data) send({type:"text",text:event.data});
  event.preventDefault();
});
$("remote-text").addEventListener("compositionstart", () => { composingText = true; });
$("remote-text").addEventListener("compositionend", (event) => {
  composingText = false;
  committedComposition = event.data;
  if (event.data) send({type:"text",text:event.data});
  setTimeout(() => { committedComposition = undefined; $("remote-text").value = ""; }, 0);
});
$("remote-text").addEventListener("input", () => { if (!composingText) $("remote-text").value = ""; });
$("remote-text").addEventListener("blur", release);
const resized = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => send({ type: "resize", ...dimensions() }), 500);
};
window.visualViewport?.addEventListener("resize", resized);
window.addEventListener("resize", resized);
document.addEventListener("fullscreenchange", () => { release(); if (!document.fullscreenElement) navigator.keyboard?.unlock(); resized(); });
window.addEventListener("pagehide", () => stop());
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); pendingInstall = event; $("install").textContent = "Install app"; });
async function installApp() {
  if (!pendingInstall) {
    const appleTouch = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const platform = appleTouch ? "iOS/iPadOS: tap Share, then “Add to Home Screen”."
      : /android/i.test(navigator.userAgent) ? "Android: open the browser menu and choose “Install app” or “Add to Home screen”."
      : "Open your browser's install or “Create shortcut” menu to add Njk Stream.";
    status(`Install instructions — ${platform}`);
    return;
  }
  try { await pendingInstall.prompt(); }
  catch (error) { status(`Install prompt unavailable: ${error.message}`); }
  finally {
    pendingInstall = undefined;
    $("install").textContent = "Install / add to home screen";
  }
}
$("install").addEventListener("click", installApp);
$("install-stream").addEventListener("click", installApp);
function openTrustPage() {
  try {
    const origin = new URL(hostEndpoint($("host").value)).origin;
    trustOrigin = origin;
    trustPopup = window.open(`${origin}/trust`, "njk-host-certificate-trust", "popup,width=620,height=760");
    if (!trustPopup) status("Certificate window was blocked. Allow popups for this site and try again.");
    else status("In the host window, manually accept the browser certificate warning. Njk Stream never bypasses certificate checks.");
  } catch (error) { status(error.message); }
}
$("trust-host").addEventListener("click", openTrustPage);
window.addEventListener("message", (event) => {
  if (event.source !== trustPopup || event.origin !== trustOrigin || event.data?.type !== "njk-certificate-trusted") return;
  trustPopup = trustOrigin = undefined;
  status("Host certificate page loaded after your manual browser acceptance. Retry Connect; trust does not bypass TLS validation.");
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => status(`Offline installation unavailable: ${error.message}`));
