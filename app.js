/* RemoteLink — pure-JS, uploadable site (no database, no custom server).
 *
 * Connection model (PeerJS signaling + WebRTC media, peer-to-peer):
 *   - PHONE registers a fixed id:  <code>-phone   (one phone per room)
 *   - PC    registers a random id: <code>-pc-<rand> (no id collisions)
 *
 * Handshake (the part that was broken before):
 *   1. PC opens, then REPEATEDLY tries to connect to the phone until it appears.
 *   2. On data-channel open, PC sends {type:"info", name}.
 *   3. After the screen capture is ready, PC sends {type:"ready"}.
 *   4. Phone, on "ready", CALLS the PC for its media stream (real screen).
 *   5. Control keystrokes/coords ride the same data channel back to the PC.
 *
 * Latency: video goes PC -> phone over a direct RTC peer connection
 * (getDisplayMedia, 30-60fps). No media relay, so it's as fast as your LAN.
 */
const $ = (id) => document.getElementById(id);
const PEER_OPTS = { debug: 0 };
// Signaling: if the user pasted a URL, derive host/port/path; else use PeerJS cloud.
let SIGNAL = {};
function parseSignal(url) {
  if (!url) return {};
  try {
    const u = new URL(url);
    let path = u.pathname || "/";
    if (path === "/" || path === "") path = "/peerjs";   // PeerJS default
    return {
      host: u.hostname,
      port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      path,
      secure: u.protocol === "https:",
    };
  } catch { return {}; }
}
let peer = null;
let mode = "pc";
let code = "";
let pcName = "PC";
let localStream = null;

// phone state
const pcs = new Map();          // peerId -> { conn, videoEl, card, slot, mediaCalled }
let pcCounter = 0;

// pc state
let pcConn = null;              // data channel to the phone
const pendingCalls = [];        // media calls that arrived before capture was ready

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
  SIGNAL = parseSignal($("signal").value.trim());
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
  peer = new Peer(code + "-phone", { ...PEER_OPTS, ...SIGNAL });

  peer.on("open", () => setMsg("phCount", "listening…", "good"));
  peer.on("connection", (conn) => handlePcConnection(conn));
  peer.on("call", (call) => call.answer());   // safety: answer any stray call
  peer.on("error", (e) => {
    if (e.type === "unavailable-id") {
      setMsg("joinMsg", "This code already has a phone. Pick another code.", "bad");
      show("join");
    } else console.warn("phone peer err", e.type);
  });
}

function handlePcConnection(conn) {
  conn.on("open", () => conn.send({ type: "hello" }));
  conn.on("data", (d) => onPcData(conn, d));
  conn.on("close", () => removePc(conn.peer));
  conn.on("error", () => removePc(conn.peer));
}

function onPcData(conn, d) {
  if (d.type === "info") {
    ensureCard(conn.peer, d.name, conn);   // store the REAL conn for control
  } else if (d.type === "ready") {
    requestMedia(conn.peer);               // phone pulls the screen now
  } else if (d.type === "cursor") {
    /* reserved */
  }
}

function requestMedia(pcId) {
  const rec = pcs.get(pcId);
  if (!rec || rec.mediaCalled) return;
  rec.mediaCalled = true;
  const call = peer.call(pcId, null);      // phone sends nothing, receives PC screen
  call.on("stream", (s) => attachStreamToCard(pcId, s));
  call.on("error", () => { rec.mediaCalled = false; setTimeout(() => requestMedia(pcId), 2500); });
  call.on("close", () => { rec.mediaCalled = false; });
}

function ensureCard(peerId, name, conn) {
  if (pcs.has(peerId)) return;
  pcCounter++;
  const slot = pcCounter;
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
  const rec = { conn, videoEl: video, card, slot, mediaCalled: false, ctrlState: false };
  pcs.set(peerId, rec);
  updateCount();

  video.addEventListener("pointerdown", (e) => { if (rec.ctrlState) sendCtrl(peerId, "click", e, video, "left"); });
  video.addEventListener("pointermove", (e) => { if (rec.ctrlState && e.buttons) sendCtrl(peerId, "move", e, video); });
  video.addEventListener("contextmenu", (e) => { if (rec.ctrlState) { e.preventDefault(); sendCtrl(peerId, "click", e, video, "right"); } });
  card.querySelector('[data-a="take"]').onclick = () => { rec.ctrlState = true; setMsg("phCount", "controlling " + (name || "PC"), "good"); };
  card.querySelector('[data-a="stop"]').onclick = () => { rec.ctrlState = false; };
}

function attachStreamToCard(peerId, stream) {
  const rec = pcs.get(peerId);
  if (!rec) return;
  rec.videoEl.srcObject = stream;
}
function removePc(peerId) {
  const rec = pcs.get(peerId);
  if (rec) { rec.card.remove(); pcs.delete(peerId); }
  updateCount();
  if (pcs.size === 0) $("empty").style.display = "block";
}
function updateCount() {
  $("phCount").textContent = pcs.size + (pcs.size === 1 ? " PC" : " PCs");
}
function activePcId() {
  for (const [id, rec] of pcs) if (rec.conn && rec.conn.readyState === "open") return id;
  return null;
}
function sendCtrl(peerId, kind, e, video, button) {
  const rec = pcs.get(peerId);
  if (!rec || !rec.conn || rec.conn.readyState !== "open") return;
  const r = video.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  rec.conn.send({ type: "ctrl", kind, x: +x.toFixed(3), y: +y.toFixed(3), button });
}

// keyboard + pad (phone -> active PC)
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
    const a = b.dataset.act, c = pcs.get(id).conn;
    if (a === "right") c.send({ type: "ctrl", kind: "click", x: .5, y: .5, button: "right" });
    else if (a === "up") c.send({ type: "scroll", dy: 4 });
    else if (a === "down") c.send({ type: "scroll", dy: -4 });
    else if (a === "ctrlc") c.send({ type: "combo", keys: ["Control", "c"] });
    else if (a === "ctrlv") c.send({ type: "combo", keys: ["Control", "v"] });
  };
});

// ============================================================
//  PC  (share screen)
// ============================================================
function startAsPC() {
  show("pc");
  $("pcNameOut").textContent = pcName;
  $("pcCodeOut").textContent = code;
  peer = new Peer(code + "-pc-" + Math.random().toString(36).slice(2, 7), { ...PEER_OPTS, ...SIGNAL });

  peer.on("open", () => {
    $("pcSlot").textContent = "online";
    wirePcPeer();
    setTimeout(connectToPhone, 600);   // let the phone register first (avoids silent offer-drop race)
    startCapture();
  });
  peer.on("error", (e) => {
    if (e.type === "unavailable-id") { peer = new Peer(code + "-pc-" + Math.random().toString(36).slice(2, 7), { ...PEER_OPTS, ...SIGNAL }); }
    else if (e.type === "peer-unavailable") {
      // PC tried to dial <code>-phone but the phone isn't registered yet.
      // This is expected and transient — connectToPhone() retries every ~2s.
      // Show a neutral "waiting" state, NOT a red error.
      $("pcSlot").textContent = "waiting for phone…";
      $("pcSlot").style.background = "var(--pill)";
      setMsg("joinMsg", "Phone not connected yet — retrying… (open the phone with the same code)", "good");
    }
    else {
      console.warn("pc peer err", e.type, e);
      $("pcSlot").textContent = "signal error";
      $("pcSlot").style.background = "var(--bad)";
      setMsg("joinMsg", "Peer error: " + e.type + (SIGNAL.host ? " (check signaling URL)" : " (public cloud busy?)"), "bad");
    }
  });
}

function wirePcPeer() {
  // accept the phone's media call; answer with our screen once ready
  peer.on("call", (call) => {
    if (localStream) call.answer(localStream);
    else pendingCalls.push(call);
  });
}

// Keep trying to connect to the phone until the data channel actually opens.
// (Phone may register a beat after the PC; silent races need an open-poll, not
//  just error/close retries.)
let connectTimer = null;
function connectToPhone() {
  if (!peer) return;
  if (pcConn && pcConn.readyState === "open") return;   // already linked
  const conn = peer.connect(code + "-phone");
  conn.on("open", () => {
    pcConn = conn;
    conn.send({ type: "info", name: pcName });
    if (localStream) conn.send({ type: "ready" });
  });
  conn.on("data", (d) => onPhoneData(conn, d));
  conn.on("close", () => { if (pcConn === conn) pcConn = null; retryConnect(); });
  conn.on("error", () => retryConnect());
  // open-poll: if it didn't open shortly, try again
  setTimeout(() => { if (!pcConn || pcConn.readyState !== "open") retryConnect(); }, 2500);
}
function retryConnect() {
  if (connectTimer) return;
  connectTimer = setTimeout(() => { connectTimer = null; connectToPhone(); }, 2000);
}

async function startCapture() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    $("pcDot").style.background = "var(--good)";
    // notify phone + flush any media calls that arrived early
    if (pcConn && pcConn.readyState === "open") pcConn.send({ type: "ready" });
    while (pendingCalls.length) pendingCalls.pop().answer(localStream);
    localStream.getVideoTracks()[0].addEventListener("ended", stopSharing);
  } catch (e) {
    setMsg("joinMsg", "Screen capture denied: " + e.message, "bad");
    show("join");
  }
}

function onPhoneData(conn, d) {
  if (d.type === "hello") {
    conn.send({ type: "info", name: pcName });
    if (localStream) conn.send({ type: "ready" });
  } else if (d.type === "ctrl")    { dispatchInput(d); }
  else if (d.type === "key")       { dispatchKey(d.key); }
  else if (d.type === "combo")     { dispatchCombo(d.keys); }
  else if (d.type === "scroll")    { dispatchScroll(d.dy); }
}

// ---- input injection on the PC (browser-side; see caveat in README) ----
function norm(d) { return { x: Math.max(0, Math.min(1, d.x)), y: Math.max(0, Math.min(1, d.y)) }; }
function screenXY(d) {
  const n = norm(d);
  return { x: Math.round(n.x * window.screen.width), y: Math.round(n.y * window.screen.height) };
}
function dispatchInput(d) {
  const p = screenXY(d);
  if (d.kind === "move") { if (window.moveScreenPointer) window.moveScreenPointer(p.x, p.y); }
  else if (d.kind === "click") {
    if (window.moveScreenPointer) window.moveScreenPointer(p.x, p.y);
    const el = document.elementFromPoint(p.x, p.y);
    if (el) el.click();
  }
}
function dispatchKey(ch) {
  (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
}
function dispatchCombo(keys) {
  keys.forEach(k => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: k === "Control" })));
}
function dispatchScroll(dy) { window.scrollBy(0, -dy * 40); }

$("pcStop").onclick = stopSharing;
function stopSharing() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (peer) peer.destroy();
  show("join");
}
