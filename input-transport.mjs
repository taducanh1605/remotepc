export async function separateStreamsSupported(endpoint, token) {
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store", signal: AbortSignal.timeout(12000),
  });
  if (response.status === 405) return false;
  if (!response.ok) throw new Error(`Input transport discovery failed (${response.status}).`);
  if ((await response.json()).separateStreams !== true) throw new Error("Host returned an unsupported stream transport capability.");
  return true;
}

export async function gatherOffer(peer) {
  await peer.setLocalDescription(await peer.createOffer());
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", check);
      peer.removeEventListener("connectionstatechange", closed);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (peer.iceGatheringState === "complete") finish();
    }
    function closed() {
      if (peer.connectionState === "closed") finish(new Error("Connection cancelled during ICE gathering."));
    }
    const timer = setTimeout(() => finish(new Error("ICE gathering timed out.")), 12000);
    peer.addEventListener("icegatheringstatechange", check);
    peer.addEventListener("connectionstatechange", closed);
    check();
    closed();
  });
}
