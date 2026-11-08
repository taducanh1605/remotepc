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
} from "./protocol.mjs?v=20261108-playback";
import { installImmersive } from "./immersive.mjs";

const $ = (id) => document.getElementById(id);
const screen = $("screen");
let pc, channel, motionChannel, endpoint, token, sessionId, resizeTimer, motionFrame, statsTimer, latencyTimer;
let generation = 0;
let backend = "standalone";
let queuePosition = 0;
let displayLeader = false;
let capabilities = { touch: false, pen: false };
let composingText = false;
let committedComposition;
let keyboardVisible = false;
let lastDimensions;
let micChannel, micStream, micContext, trustPopup, trustOrigin, trustNonce, trustTimer;
let stopPromise;
let remoteLaunch;
let automaticConnection = false;
let automaticFullscreenPending = false;
let focusRequest = 0, pendingFocus = 0, focusTimer;
const contactGenerations = new Map();
const activePointers = new Map();
const pendingMotions = new Map();
const pendingPings = new Map();
const latencySamples = [];
let pingSequence = 0;
let lastRttAt = 0;
let motionSequence = 0;
const status = (text) => { $("status").textContent = $("stream-status").textContent = text; };
const viewport = () => visibleViewport(window.visualViewport, { width: innerWidth, height: innerHeight }, navigator.virtualKeyboard?.boundingRect);
const dimensions = () => viewportDimensions(viewport(), $("stream-detail").value === "auto" ? window.devicePixelRatio || 1 : Number($("stream-detail").value));
function requestedQuality() {
  const fps = Number($("stream-fps").value), size = dimensions();
  const bitrateKbps = $("stream-bitrate").value === "auto" ? automaticBitrate(size.width, size.height, fps) : Number($("stream-bitrate").value);
  return { fps, bitrateKbps };
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
const launchParameters = new URLSearchParams(location.hash.slice(1));
if (launchParameters.has("ticket")) {
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const host = new URL(hostEndpoint(launchParameters.get("host") || "")).origin;
    const ticket = launchParameters.get("ticket");
    if (!/^[a-f0-9]{32}$/.test(ticket || "")) throw new Error("Invalid ESP Wake connection ticket.");
    $("host").value = host;
    $("connect-fullscreen").checked = true;
    remoteLaunch = { host, ticket };
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
function setKeyboard(visible) {
  keyboardVisible = visible;
  $("remote-text").hidden = $("remote-text-label").hidden = $("remote-text-help").hidden = !visible;
  $("soft-keyboard").setAttribute("aria-pressed", String(visible));
  if (visible) $("remote-text").focus({ preventScroll: true });
  else $("remote-text").blur();
}
const immersive = installImmersive({ send, sendMotion, release, screen, setKeyboard, available: () => channel?.readyState === "open" });

function stop(notify = true) {
  if (stopPromise) return stopPromise;
  stopPromise = stopSession(notify).finally(() => { stopPromise = undefined; });
  return stopPromise;
}
async function stopSession(notify) {
  ++generation;
  clearTimeout(resizeTimer);
  clearInterval(statsTimer);
  clearInterval(latencyTimer);
  clearTimeout(focusTimer);
  pendingFocus = 0;
  release();
  setKeyboard(false);
  await immersive.disconnected();
  channel?.close();
  motionChannel?.close();
  await stopMicrophone();
  micChannel?.close();
  pc?.close();
  channel = motionChannel = pc = undefined;
  screen.srcObject = null;
  screen.muted = false;
  $("playback-status").textContent = "";
  $("desktop-audio").disabled = true;
  $("stream-shell").hidden = true;
  document.body.classList.remove("streaming");
  document.querySelector('meta[name="theme-color"]').content = "#14231d";
  document.documentElement.style.removeProperty("--viewport-height");
  document.documentElement.style.removeProperty("--viewport-top");
  lastDimensions = undefined;
  composingText = false;
  committedComposition = undefined;
  $("remote-text").value = "";
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
  automaticFullscreenPending = false;
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
  const automatic = automaticConnection;
  automaticConnection = false;
  const fullscreenRequest = requestFullscreenInGesture(document.documentElement, $("connect-fullscreen").checked);
  $("connect").disabled = true;
  const attempt = ++generation;
  try {
    try {
      await fullscreenRequest;
      automaticFullscreenPending = false;
    } catch (error) {
      if (!automatic) throw error;
      automaticFullscreenPending = true;
      $("capture-status").textContent = `Fullscreen needs a screen tap: ${error.message}`;
    }
    if (!window.isSecureContext || !window.RTCPeerConnection) throw new Error("A secure browser with WebRTC is required.");
    endpoint = hostEndpoint($("host").value);
    saveHost();
    token = $("token").value;
    if (token.length < 32) throw new Error("Access token must contain at least 32 characters.");
    $("token").value = "";
    status("Negotiating authenticated WebRTC…");
    const peer = new RTCPeerConnection();
    let disconnectTimer;
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
        if (message.type === "quality" && message.fps && message.bitrateKbps) {
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
        if (message.type === "text-focus" && typeof message.editable === "boolean") {
          if (message.request !== pendingFocus || !pendingFocus) return;
          pendingFocus = 0;
          if (message.editable && activePointers.size === 0 && !keyboardVisible) setKeyboard(true);
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
      startPlayback();
    });
    peer.addEventListener("connectionstatechange", () => {
      if (pc !== peer) return;
      clearTimeout(disconnectTimer);
      if (peer.connectionState === "disconnected") {
        status("Network interrupted. Waiting up to 10 seconds for ICE to recover…");
        disconnectTimer = setTimeout(() => {
          if (pc === peer && peer.connectionState === "disconnected") stop().then(() => status("Network did not recover. Reconnect when the host is reachable."));
        }, 10000);
      } else if (["failed", "closed"].includes(peer.connectionState)) {
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
      body: JSON.stringify({ sdp: peer.localDescription.sdp, ...dimensions(), ...requestedQuality() }),
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
    $("apply-quality").disabled = answer.capabilities?.quality !== true;
    $("exit-quit").disabled = answer.capabilities?.quit !== true;
    if (answer.quality) {
      $("stream-fps").value = String(answer.quality.fps);
      $("video-quality").textContent = `${answer.quality.fps} FPS · ${answer.quality.bitrateKbps} kbps`;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    $("connection").hidden = true;
    document.querySelector('meta[name="theme-color"]').content = "#000000";
    $("stream-shell").hidden = false;
    document.body.classList.add("streaming");
    resized();
    immersive.connected();
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
            $("video-quality").textContent = `${fps.toFixed(1)} decoded FPS · ${Math.round(kbps)} kbps · ${report.framesDropped || 0} dropped frames`;
          }
          previousVideo = { timestamp: report.timestamp, framesDecoded: report.framesDecoded || 0, bytesReceived: report.bytesReceived || 0 };
        }
      }
      if (decoded > 0 && queuePosition === 0) status(`Streaming · ${screen.videoWidth}×${screen.videoHeight} · ${decoded} decoded frames · ${backend === "native-host" ? (displayLeader ? "display leader" : "shared display follower") : "standalone"}`);
    }, 2000);
    if (!keyboardVisible) screen.focus({ preventScroll: true });
  } catch (error) {
    if (attempt !== generation) return;
    await stop();
    const detail = isTransientNetworkError(error)
      ? "The gateway could not be reached. Check the hostname DNS result (including NXDOMAIN), network/firewall and port 47990, then verify that the TLS certificate is trusted and matches the host name. Use “Trust host certificate…” to open the browser's manual certificate screen."
      : error.message;
    status(`${detail} GitHub Pages also requires its exact origin to be allowlisted and local-network access permission.`);
  }
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
  } catch (error) { status(`Unable to ${quit ? "quit" : "disconnect"}: ${error.message}`); $("exit-error").textContent = error.message; }
  finally { for (const id of ["exit-disconnect", "exit-quit"]) $(id).disabled = false; }
}
$("exit-disconnect").addEventListener("click", () => leaveSession(false));
$("exit-quit").addEventListener("click", () => leaveSession(true));
$("apply-quality").addEventListener("click", () => {
  resized();
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
screen.addEventListener("click", () => startPlayback(true));
$("desktop-audio").addEventListener("click", () => {
  if (!screen.muted) {
    screen.muted = true;
    $("desktop-audio").textContent = "Enable desktop audio";
  } else startPlayback(true);
});
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
  if (automaticFullscreenPending) {
    automaticFullscreenPending = false;
    $("fullscreen").click();
  }
  if (event.pointerType === "touch" && backend === "native-host") {
    if (!capabilities.touch) return;
    if (!keyboardVisible) screen.focus({ preventScroll: true });
    screen.setPointerCapture(event.pointerId);
    clearTimeout(focusTimer);
    pendingFocus = 0;
    beginPointer(event, "touch");
    event.preventDefault();
    return;
  }
  if (event.pointerType === "pen" && backend === "native-host") {
    if (!capabilities.pen) return;
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
    if (position && activePointers.size === 0) {
      const request = ++focusRequest;
      pendingFocus = request;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => send({ type: "focus", request, ...position }), 150);
    }
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
  document.documentElement.style.setProperty("--viewport-height", `${viewport().height}px`);
  document.documentElement.style.setProperty("--viewport-top", "0px");
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const next = dimensions();
    if (next.width === lastDimensions?.width && next.height === lastDimensions?.height) return;
    if (channel?.readyState !== "open") return;
    lastDimensions = next;
    send({ type: "resize", ...next });
    if ($("stream-bitrate").value === "auto") send({ type: "quality", ...requestedQuality() });
  }, 120);
};
window.visualViewport?.addEventListener("resize", resized);
window.visualViewport?.addEventListener("scroll", resized);
navigator.virtualKeyboard?.addEventListener("geometrychange", resized);
window.addEventListener("resize", resized);
document.addEventListener("fullscreenchange", () => { release(); if (!document.fullscreenElement) navigator.keyboard?.unlock(); resized(); });
window.addEventListener("pagehide", () => stop());
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
    const started = Date.now(), nonce = trustNonce;
    trustTimer = setInterval(async () => {
      if (Date.now() - started > 120000 || nonce !== trustNonce) { clearInterval(trustTimer); return; }
      try {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
        if (response.ok && nonce === trustNonce) {
          trustPopup?.close();
          completeTrust();
        }
      } catch (error) { if (!isTransientNetworkError(error)) console.warn("Certificate check:", error.message); }
    }, 2000);
    if (!trustPopup) status("Certificate window was blocked. Allow popups for this site and try again.");
    else status("In the host window, manually accept the browser certificate warning. Njk Stream never bypasses certificate checks.");
  } catch (error) { status(error.message); }
}
$("trust-host").addEventListener("click", openTrustPage);
function completeTrust() {
  clearInterval(trustTimer);
  trustPopup = trustOrigin = trustNonce = undefined;
  status("Host certificate accepted. You can now Connect.");
  if (remoteLaunch) connectFromESPWake();
}
window.addEventListener("message", (event) => {
  if (event.source !== trustPopup || event.origin !== trustOrigin || event.data?.type !== "njk-certificate-trusted" || event.data.nonce !== trustNonce) return;
  completeTrust();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => status(`Offline installation unavailable: ${error.message}`));
async function connectFromESPWake() {
  if (!remoteLaunch) return;
  try {
    const response = await fetch(`${remoteLaunch.host}/api/connect`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: remoteLaunch.ticket }),
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`ESP Wake connection failed (${response.status}). Open RemotePC again from ESP Wake for a fresh ticket.`);
    const result = await response.json();
    if (typeof result.token !== "string" || result.token.length < 32) throw new Error("Host returned an invalid connection credential.");
    $("token").value = result.token;
    automaticConnection = true;
    remoteLaunch = undefined;
    $("connection").requestSubmit();
  } catch (error) {
    if (isTransientNetworkError(error)) {
      status("ESP Wake connection needs host certificate approval. Open the host security check; connection will resume after approval.");
      openTrustPage();
    } else {
      remoteLaunch = undefined;
      status(error.message);
    }
  }
}
if (remoteLaunch) connectFromESPWake();
