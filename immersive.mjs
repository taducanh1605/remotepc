export function shortcutMessages(name) {
  const keys = { win: ["MetaLeft"], "alt-tab": ["AltLeft", "Tab"], escape: ["Escape"] }[name];
  if (!keys) throw new Error("Unsupported remote shortcut");
  return [...keys.map(code => ({ type: "key", code, down: true })),
    ...[...keys].reverse().map(code => ({ type: "key", code, down: false }))];
}

export function lockedPointer(position, dx, dy, width, height) {
  return { x: Math.max(0, Math.min(1, position.x + dx / Math.max(1, width))),
    y: Math.max(0, Math.min(1, position.y + dy / Math.max(1, height))) };
}

export function installImmersive({ send, sendMotion = send, release, screen, available, setKeyboard }) {
  const $ = id => document.getElementById(id);
  const shell = $("stream-shell");
  let pointer = { x: .5, y: .5 };
  let fullscreenPending = false;
  let entering = false;
  let orientationLocked = false;
  let rotationGeneration = 0;
  const report = text => { $("capture-status").textContent = text; };
  async function exit() {
    fullscreenPending = false;
    rotationGeneration++;
    if (orientationLocked) {
      window.screen.orientation.unlock();
      orientationLocked = false;
    }
    release();
    navigator.keyboard?.unlock();
    if (document.pointerLockElement) document.exitPointerLock();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    document.body.classList.remove("immersive");
    report("Input capture off; browser/OS shortcuts may remain reserved");
  }
  async function enter() {
    if (entering) return;
    entering = true;
    document.body.classList.add("immersive");
    try {
      if (!document.fullscreenElement) await shell.requestFullscreen();
      fullscreenPending = false;
      if (document.activeElement !== $("remote-text")) screen.focus({ preventScroll: true });
      if (navigator.keyboard?.lock) {
        // Leave Escape unlocked so there is always a browser-provided exit.
        await navigator.keyboard.lock(["AltLeft", "AltRight", "Tab", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight"]);
        report("Fullscreen · keyboard lock granted where supported · Escape exits");
      } else report("Fullscreen · keyboard lock unavailable · Escape exits");
    } catch (error) {
      fullscreenPending = !document.fullscreenElement;
      report(fullscreenPending
        ? `Immersive mode active. Tap the stream to allow fullscreen: ${error.message}`
        : `Keyboard capture limited: ${error.message}. Use toolbar shortcuts.`);
    } finally { entering = false; }
  }
  $("fullscreen").addEventListener("click", () => { if (available()) return enter(); });
  shell.addEventListener("pointerdown", () => {
    if (fullscreenPending && available()) enter();
  }, { capture: true });
  $("exit-immersive").addEventListener("click", exit);
  $("rotate-screen").addEventListener("click", async () => {
    if (!available() || $("rotate-screen").disabled) return;
    const orientation = window.screen?.orientation;
    if (typeof orientation?.lock !== "function" || typeof orientation.unlock !== "function") {
      report("Screen rotation is unavailable in this browser. Rotate your device manually.");
      return;
    }
    const target = orientation.type?.startsWith("landscape") ? "portrait" : "landscape";
    const generation = rotationGeneration;
    $("rotate-screen").disabled = true;
    release();
    try {
      if (!document.fullscreenElement) await enter();
      if (!document.fullscreenElement) throw new Error("Fullscreen permission is required.");
      if (generation !== rotationGeneration) return;
      await orientation.lock(target);
      if (generation !== rotationGeneration) { orientation.unlock(); return; }
      orientationLocked = true;
      report(`Screen rotated to ${target}. Exit immersive to restore automatic rotation.`);
    } catch (error) {
      if (generation === rotationGeneration) report(`Screen rotation unavailable: ${error.message}. Rotate your device manually.`);
    } finally {
      $("rotate-screen").disabled = $("stream-tools").hidden;
    }
  });
  $("pointer-lock").addEventListener("click", async () => {
    if (!available()) return;
    try { await screen.requestPointerLock(); report("Mouse locked · Escape unlocks/exits"); }
    catch (error) { report(`Mouse lock unavailable: ${error.message}`); }
  });
  screen.addEventListener("pointermove", event => {
    if (document.pointerLockElement !== screen) return;
    pointer = lockedPointer(pointer,event.movementX,event.movementY,screen.clientWidth,screen.clientHeight);
    sendMotion({ type: "move", ...pointer });
  });
  $("soft-keyboard").addEventListener("click", () => {
    release();
    const visible = $("soft-keyboard").getAttribute("aria-pressed") !== "true" ||
      $("soft-keyboard").getAttribute("data-keyboard-retry") === "true";
    $("stream-tools").open = false;
    setKeyboard(visible);
    if (!visible) screen.focus({ preventScroll: true });
  });
  $("right-click").addEventListener("click", () => {
    send({ type:"button",button:2,down:true }); send({ type:"button",button:2,down:false });
  });
  for (const [id,delta] of [["scroll-up",-120],["scroll-down",120]]) {
    $(id).addEventListener("click",()=>send({type:"wheel",delta}));
  }
  for (const button of document.querySelectorAll("[data-shortcut]")) {
    button.addEventListener("click",()=>{
      release(); shortcutMessages(button.dataset.shortcut).forEach(send); screen.focus();
    });
  }
  $("zoom").addEventListener("input",event=>{
    const zoom=Math.max(1,Math.min(3,Number(event.target.value)));
    screen.style.transform=`scale(${zoom})`;
    $("zoom-level").value=`${zoom}×`;
  });
  shell.addEventListener("touchmove",event=>{
    if(event.target===screen)event.preventDefault();
  },{passive:false});
  document.addEventListener("keydown",event=>{
    if(event.code==="Escape"&&(document.fullscreenElement||document.pointerLockElement)) {
      event.preventDefault(); event.stopImmediatePropagation(); exit();
    }
  },true);
  document.addEventListener("fullscreenchange",()=>{
    if(!document.fullscreenElement)exit();
  });
  window.addEventListener("blur",release);
  document.addEventListener("visibilitychange",()=>{ if(document.hidden)release(); });
  return { exit, connected:({ autoEnter = false } = {})=>{
    $("stream-tools").hidden=false;
    $("rotate-screen").disabled=false;
    if (autoEnter) return enter();
  },
    disconnected:async()=>{ $("rotate-screen").disabled=true; $("stream-tools").hidden=true; $("stream-tools").open=false; $("zoom").value=1; $("zoom-level").value="1×"; screen.style.transform=""; await exit(); } };
}
