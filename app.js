import { hostEndpoint, viewportDimensions, pointerPosition } from "./protocol.mjs";

const $ = (id) => document.getElementById(id);
const screen = $("screen");
let pc, channel, endpoint, token, sessionId, resizeTimer, pendingInstall, statsTimer;
let generation = 0;
let backend = "standalone";
let queuePosition = 0;
let displayLeader = false;
let composingText = false;
let committedComposition;
let micChannel, micStream, micContext;
const status = (text) => { $("status").textContent = text; };
const dimensions = () => viewportDimensions(window.visualViewport || { width: innerWidth, height: innerHeight }, devicePixelRatio);
const send = (message) => {
  if (channel?.readyState === "open" && channel.bufferedAmount < 65536) channel.send(JSON.stringify(message));
};
const release = () => send({ type: "release" });

async function stop(notify = true) {
  ++generation;
  clearTimeout(resizeTimer);
  clearInterval(statsTimer);
  release();
  channel?.close();
  await stopMicrophone();
  micChannel?.close();
  pc?.close();
  channel = pc = undefined;
  screen.srcObject = null;
  $("remote-text").hidden = $("remote-text-label").hidden = $("remote-text-help").hidden = true;
  navigator.keyboard?.unlock();
  $("connection").hidden = false;
  $("connect").disabled = false;
  $("disconnect").disabled = $("fullscreen").disabled = true;
  $("microphone").disabled = true;
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
  $("connect").disabled = true;
  const attempt = ++generation;
  try {
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
    micChannel = peer.createDataChannel("microphone", { ordered: false, maxRetransmits: 0 });
    channel.addEventListener("open", () => send({ type: "resize", ...dimensions() }));
    channel.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "queue") {
          queuePosition = message.position;
          status(message.active ? "Your browser session is active; waiting for video frames…" : `Queued: ${message.position} browser session(s) ahead.`);
        }
        if (message.type === "leadership") displayLeader = message.leader === true;
        if (message.type === "text-focus" && typeof message.editable === "boolean") {
          $("remote-text").hidden = $("remote-text-label").hidden = $("remote-text-help").hidden = !message.editable;
          if (message.editable) $("remote-text").focus();
        }
        if (message.success === false) status(`Host ${message.type} failed.`);
      } catch { /* Ignore messages outside the negotiated JSON control protocol. */ }
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
        stop().then(() => status("Connection lost. Check host capture, certificate, UDP/firewall or TURN configuration."));
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
    if (!response.ok) throw new Error(`Host refused connection (${response.status}): ${await response.text()}`);
    const answer = await response.json();
    if (attempt !== generation) { peer.close(); return; }
    sessionId = answer.id;
    backend = answer.capture;
    $("microphone").disabled = !answer.microphone;
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    $("connection").hidden = true;
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
    status(`${error.message} If hosted on GitHub Pages, accept local-network permission and use a trusted host TLS certificate.`);
  }
});

$("disconnect").addEventListener("click", () => stop());
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
$("fullscreen").addEventListener("click", async () => {
  try {
    await screen.requestFullscreen();
    await navigator.keyboard?.lock();
    screen.focus();
  } catch (error) { status(`Fullscreen/keyboard lock unavailable: ${error.message}. Browser shortcuts remain reserved.`); }
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
  if (!event.isPrimary) return;
  const position = pointerPosition(event, screen);
  if (!position) return;
  screen.focus();
  screen.setPointerCapture(event.pointerId);
  send({ type: "move", ...position });
  send({ type: "button", button: event.button, down: true });
  event.preventDefault();
});
screen.addEventListener("pointermove", (event) => {
  if (!event.isPrimary) return;
  const position = pointerPosition(event, screen);
  if (position) send({ type: "move", ...position });
});
screen.addEventListener("pointerup", (event) => {
  if (!event.isPrimary) return;
  send({ type: "button", button: event.button, down: false });
  if (event.pointerType === "touch" && backend === "native-host") {
    const position = pointerPosition(event, screen);
    if (position) send({type: "focus", ...position});
  }
  if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
});
screen.addEventListener("pointercancel", release);
screen.addEventListener("lostpointercapture", release);
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
const resized = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => send({ type: "resize", ...dimensions() }), 500);
};
window.visualViewport?.addEventListener("resize", resized);
window.addEventListener("resize", resized);
document.addEventListener("fullscreenchange", () => { release(); if (!document.fullscreenElement) navigator.keyboard?.unlock(); resized(); });
window.addEventListener("pagehide", () => stop());
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); pendingInstall = event; $("install").hidden = false; });
$("install").addEventListener("click", async () => { await pendingInstall?.prompt(); pendingInstall = undefined; $("install").hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => status(`Offline installation unavailable: ${error.message}`));
