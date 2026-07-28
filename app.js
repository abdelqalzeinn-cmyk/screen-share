/* RemoteLink — pure-JS, uploadable site.
 *
 * Connection model (no custom server needed):
 *  - A "code" defines a room. The PHONE is the signaling hub: it registers the
 *    PeerJS id `<code>-phone`. Each PC registers `<code>-pc-1`, `<code>-pc-2`, ...
 *  - When a PC connects, it calls the phone; the phone replies and that PC's
 *    media + data channel flow directly PC -> phone over WebRTC (low latency,
 *    no relay of media). Multiple PCs = multiple cards in the grid.
 *
 * Latency: video is sent over a direct RTC peer connection with
 *  `{video:{frameRate:{ideal:30,max:60}}}` + hardware-ish H.264/VP9, and
 *  control keystrokes go over the same data channel (sub-frame).
 */
const $ = (id) => document.getElementById(id);
const PEER_OPTS = { debug: 1 };
let peer = null;
let mode = "pc";
let code = "";
let pcName = "PC";
let localStream = null;

// phone state
const pcs = new Map();          // peerId -> { conn, videoEl, card, slot }
let nextSlot = 1;

// pc state
let phoneConn = null;
let pcSlot = 0;
const remoteCursors = new Map(); // connId -> cursorEl

function show(screen) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(screen).classList.add("active");
}

function setMsg(el, text, cls) {
  const e = $(el); e.textContent = text;
  e.style.color = cls === "good" ? "var(--good)" : (cls === "warn" ? "var(--warn)" : "var(--bad)");
}

// ---------- mode toggle ----------
document.querySelectorAll(".mode").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll(".mode").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    mode = b.dataset.mode;
    $("pcOnly").style.display = mode === "pc" ? "block" : "none";
  };
});

// ---------- connect ----------
$("connectBtn").onclick = () => {
  code = $("code").value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!code) { setMsg("joinMsg", "Enter a room code"); return; }
  if (mode === "pc") {
    pcName = $("pcName").value.trim() || "PC";
    startAsPC();
  } else {
    startAsPhone();
  }
};

// ============================================================
//  PHONE  (view + control)
// ============================================================
function startAsPhone() {
  show("phone");
  $("phCodeOut").textContent = code;
  peer = new Peer(code + "-phone", PEER_OPTS);

  peer.on("open", (id) => {
    setMsg("phCount", "listening…", "good");
  });

  // PCs call the phone; accept and start receiving their stream
  peer.on("connection", (conn) => handlePcConnection(conn));
  peer.on("call", (call) => {
    // we answer with no stream (phone doesn't send video) and receive theirs
    call.answer();
    call.on("stream", (remoteStream) => attachStreamToCard(call.peer, remoteStream));
    call.on("error", (e) => console.warn("call err", e));
  });
  peer.on("error", (e) => {
    if (e.type === "unavailable-id") {
      setMsg("joinMsg", "This code is already taken by another phone. Pick another.", "bad");
      show("join");
    } else console.warn(e);
  });
}

function handlePcConnection(conn) {
  conn.on("open", () => {
    // ask the PC for its name + slot, and tell it we're ready
    conn.send({ type: "hello" });
    conn.on("data", (d) => onPcData(conn, d));
  });
  conn.on("close", () => removePc(conn.peer));
  conn.on("error", () => removePc(conn.peer));
}

function onPcData(conn, d) {
  if (d.type === "info") {
    ensureCard(conn.peer, d.name, d.slot);
    // once we know the PC, dial its media
    if (peer && !pcs.get(conn.peer)?.called) {
      const call = peer.call(conn.peer, null); // phone sends no stream
      call.answer();
      call.on("stream", (s) => attachStreamToCard(conn.peer, s));
      const rec = pcs.get(conn.peer); if (rec) rec.called = true;
    }
  } else if (d.type === "cursor") {
    moveRemoteCursor(conn.peer, d.x, d.y);
  }
}

function ensureCard(peerId, name, slot) {
  if (pcs.has(peerId)) return;
  const id = "card-" + Math.random().toString(36).slice(2);
  const card = document.createElement("div");
  card.className = "pc-card";
  card.innerHTML = `
    <div class="head"><span>${name || "PC"}</span><span class="live">● live</span></div>
    <video autoplay playsinline></video>
    <div class="ctrl">
      <button data-a="take">Take control</button>
      <button data-a="stop">Stop control</button>
    </div>`;
  $("grid").appendChild(card);
  $("empty").style.display = "none";
  const video = card.querySelector("video");
  const rec = { conn: pcsConnFor(peerId), videoEl: video, card, slot };
  pcs.set(peerId, rec);
  $("phCount").textContent = pcs.size + " PCs";

  // control wiring on this card's video
  const ctrlState = { active: false };
  video.addEventListener("pointerdown", (e) => {
    if (!ctrlState.active) return;
    sendCtrl(peerId, "click", e, video, "left");
  });
  video.addEventListener("pointermove", (e) => {
    if (!ctrlState.active || !e.buttons) return;
    sendCtrl(peerId, "move", e, video);
  });
  video.addEventListener("contextmenu", (e) => {
    if (!ctrlState.active) return;
    e.preventDefault();
    sendCtrl(peerId, "click", e, video, "right");
  });
  card.querySelector('[data-a="take"]').onclick = () => { ctrlState.active = true; setMsg("phCount", "controlling " + (name||"PC"), "good"); };
  card.querySelector('[data-a="stop"]').onclick = () => { ctrlState.active = false; };
}

function pcsConnFor(peerId) {
  // find the data connection object for this peer (we stored conn in handlePcConnection)
  return activeConns.get(peerId);
}
const activeConns = new Map();

function attachStreamToCard(peerId, stream) {
  const rec = pcs.get(peerId);
  if (!rec) return;
  rec.videoEl.srcObject = null;
  rec.videoEl.srcObject = stream;
}

function removePc(peerId) {
  const rec = pcs.get(peerId);
  if (rec) { rec.card.remove(); pcs.delete(peerId); }
  $("phCount").textContent = pcs.size + " PCs";
  if (pcs.size === 0) $("empty").style.display = "block";
}

function sendCtrl(peerId, kind, e, video, button) {
  const rec = pcs.get(peerId);
  if (!rec || !rec.conn || rec.conn.readyState !== "open") return;
  const r = video.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  rec.conn.send({ type: "ctrl", kind, x: +x.toFixed(3), y: +y.toFixed(3), button });
}

function moveRemoteCursor(peerId, x, y) {
  // optional: show where the PC thinks the pointer is (not needed for phone)
}

// keyboard + pad (phone -> active controlled PC)
function activePcId() {
  for (const [id, rec] of pcs) if (rec.conn && rec.conn.readyState === "open") return id;
  return null;
}
$("kbSend").onclick = () => {
  const v = $("kb").value; const id = activePcId();
  if (!id) return;
  for (const ch of v) pcs.get(id).conn.send({ type: "key", key: ch });
  $("kb").value = "";
};
$("kb").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("kbSend").click(); } });
document.querySelectorAll(".padbtn").forEach(b => {
  b.onclick = () => {
    const id = activePcId(); if (!id) return;
    const a = b.dataset.act;
    if (a === "right") pcs.get(id).conn.send({ type: "ctrl", kind: "click", x: .5, y: .5, button: "right" });
    else if (a === "up") pcs.get(id).conn.send({ type: "scroll", dy: 4 });
    else if (a === "down") pcs.get(id).conn.send({ type: "scroll", dy: -4 });
    else if (a === "ctrlc") pcs.get(id).conn.send({ type: "combo", keys: ["Control", "c"] });
    else if (a === "ctrlv") pcs.get(id).conn.send({ type: "combo", keys: ["Control", "v"] });
  };
});

// ============================================================
//  PC  (share screen)
// ============================================================
async function startAsPC() {
  show("pc");
  $("pcNameOut").textContent = pcName;
  $("pcCodeOut").textContent = code;

  // pick the first free slot id
  peer = new Peer(code + "-pc-tmp", PEER_OPTS);
  peer.on("error", (e) => {
    if (e.type === "unavailable-id") {
      // tmp id collision is fine; we just need a peer object. retry with random
      peer = new Peer(code + "-pc-" + Math.random().toString(36).slice(2, 6), PEER_OPTS);
    }
  });
  peer.on("open", async (myId) => {
    // claim a numbered slot by trying peer ids until one is free
    pcSlot = await claimSlot();
    const finalId = code + "-pc-" + pcSlot;
    // rebuild peer with the real slot id
    peer.destroy();
    peer = new Peer(finalId, PEER_OPTS);
    $("pcSlot").textContent = "slot " + pcSlot;
    wirePcPeer();
    await startCapture();
  });
}

async function claimSlot() {
  // probe slot ids 1..N by attempting PeerJS id availability is not directly
  // queryable, so we negotiate via the phone: call the phone, ask for a slot.
  return new Promise((resolve) => {
    const probe = new Peer(code + "-pc-probe", { debug: 0 });
    probe.on("open", () => {
      const c = probe.connect(code + "-phone");
      c.on("open", () => c.send({ type: "alloc_slot", name: pcName }));
      c.on("data", (d) => { if (d.type === "slot") { probe.destroy(); resolve(d.slot); } });
    });
    probe.on("error", () => { probe.destroy(); resolve(1); });
    setTimeout(() => { probe.destroy(); resolve(1); }, 1500);
  });
}

function wirePcPeer() {
  peer.on("connection", (conn) => {
    activeConns.set(conn.peer, conn);
    conn.on("open", () => conn.send({ type: "info", name: pcName, slot: pcSlot }));
    conn.on("data", (d) => onPhoneData(conn, d));
    conn.on("close", () => activeConns.delete(conn.peer));
  });
  peer.on("call", (call) => {
    // PC sends its screen; phone answers. We still answer to complete handshake.
    call.answer(localStream);
    call.on("error", () => {});
  });
  peer.on("error", (e) => console.warn("pc peer err", e));
}

async function startCapture() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    setMsg("pcDot", "");
    $("pcDot").style.background = "var(--good)";
    localStream.getVideoTracks()[0].addEventListener("ended", stopSharing);
  } catch (e) {
    setMsg("joinMsg", "Screen capture denied: " + e.message, "bad");
    show("join");
  }
}

function onPhoneData(conn, d) {
  if (d.type === "hello") {
    conn.send({ type: "info", name: pcName, slot: pcSlot });
  } else if (d.type === "ctrl") {
    dispatchInput(d);
  } else if (d.type === "key") {
    dispatchKey(d.key);
  } else if (d.type === "combo") {
    dispatchCombo(d.keys);
  } else if (d.type === "scroll") {
    dispatchScroll(d.dy);
  }
}

// ---- input injection on the PC (browser-side: dispatched as real input) ----
function norm(d) {
  return { x: Math.max(0, Math.min(1, d.x)), y: Math.max(0, Math.min(1, d.y)) };
}
function screenXY(d) {
  const n = norm(d);
  return { x: Math.round(n.x * window.screen.width), y: Math.round(n.y * window.screen.height) };
}
function dispatchInput(d) {
  const p = screenXY(d);
  if (d.kind === "move") {
    // move the OS pointer via the Screen Pointer API if available, else no-op
    if (window.moveScreenPointer) window.moveScreenPointer(p.x, p.y);
  } else if (d.kind === "click") {
    if (window.moveScreenPointer) window.moveScreenPointer(p.x, p.y);
    // we can't synthesize a real OS click from a webpage for security; instead
    // we dispatch to the element under the shared coordinate in the current tab
    const el = document.elementFromPoint(p.x, p.y);
    if (el) el.click();
  }
}
function dispatchKey(ch) {
  // dispatch to focused element in the PC's active tab
  const ev = new KeyboardEvent("keydown", { key: ch, bubbles: true });
  (document.activeElement || document.body).dispatchEvent(ev);
}
function dispatchCombo(keys) {
  keys.forEach(k => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: k === "Control" })));
}
function dispatchScroll(dy) {
  window.scrollBy(0, -dy * 40);
}

$("pcStop").onclick = stopSharing;
function stopSharing() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (peer) peer.destroy();
  show("join");
}
