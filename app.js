(() => {
  const $ = (selector) => document.querySelector(selector);
  const screens = {
    auth: $("#auth-screen"),
    home: $("#app-screen"),
    meeting: $("#meeting-screen")
  };
  const state = {
    user: null,
    authMode: "login",
    roomId: null,
    roomKey: null,
    roomKeyText: null,
    socket: null,
    stream: null,
    screenStream: null,
    activeVideoTrack: null,
    peers: new Map(),
    participants: new Map(),
    startedAt: 0,
    timer: null,
    messageCount: 0,
    toastTimer: null,
    badKeyShown: false,
    objectUrls: new Set(),
    whiteboardStrokes: [],
    drawing: false,
    currentStroke: null
  };

  const authModeButtons = document.querySelectorAll("[data-auth-mode]");
  const authForm = $("#auth-form");
  const authError = $("#auth-error");
  const nameField = $("#name-field");
  const nameInput = $("#auth-name");
  const emailInput = $("#auth-email");
  const passwordInput = $("#auth-password");
  const authSubmit = $("#auth-submit");
  const canvas = $("#whiteboard");
  const canvasContext = canvas.getContext("2d");

  function showScreen(screen) {
    Object.values(screens).forEach((element) => element.classList.add("hidden"));
    screens[screen].classList.remove("hidden");
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    authModeButtons.forEach((button) => {
      const selected = button.dataset.authMode === mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    });
    const registering = mode === "register";
    nameField.classList.toggle("hidden", !registering);
    nameInput.required = registering;
    passwordInput.autocomplete = registering ? "new-password" : "current-password";
    $("#auth-title").textContent = registering ? "Let's make this yours." : "Come on in.";
    $("#auth-subtitle").textContent = registering
      ? "A little account, a lot of room to make things."
      : "Sign in to pick up where you left off.";
    authSubmit.innerHTML = registering ? "Create my account <span>→</span>" : "Sign in <span>→</span>";
    authError.textContent = "";
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 204) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
    return result;
  }

  function initials(name) {
    return (name || "?").trim().slice(0, 1).toUpperCase();
  }

  function renderHome() {
    $("#workspace-name").textContent = `${state.user.name}'s space`;
    $("#profile-name").textContent = state.user.name;
    $("#profile-avatar").textContent = initials(state.user.name);
    $("#welcome-name").textContent = state.user.name.trim().split(/\s+/)[0];
    const hour = new Date().getHours();
    $("#today-label").textContent = hour < 12 ? "A GOOD MORNING TO YOU" : hour < 18 ? "A GOOD AFTERNOON TO YOU" : "A GOOD EVENING TO YOU";
    showScreen("home");
  }

  function parseInvite(value) {
    const raw = (value || "").trim();
    if (!raw) return null;
    try {
      const invite = new URL(raw, window.location.origin);
      const roomId = invite.searchParams.get("room");
      const secret = invite.hash.slice(1);
      if (roomId && secret) return { roomId, secret };
    } catch {
      return null;
    }
    return null;
  }

  function inviteFromLocation() {
    return parseInvite(window.location.href);
  }

  function encodeBytes(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function decodeBytes(value) {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function importRoomKey(secret) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("That invite link is missing its encryption key.");
    const rawKey = decodeBytes(secret);
    if (rawKey.length !== 32) throw new Error("That invite link has an invalid encryption key.");
    return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function encryptBytes(bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.roomKey, bytes);
    return { ciphertext: encodeBytes(new Uint8Array(ciphertext)), iv: encodeBytes(iv) };
  }

  async function decryptBytes(payload) {
    const iv = decodeBytes(payload.iv);
    const ciphertext = decodeBytes(payload.ciphertext);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, state.roomKey, ciphertext));
  }

  async function encryptObject(value) {
    return encryptBytes(new TextEncoder().encode(JSON.stringify(value)));
  }

  async function decryptObject(payload) {
    return JSON.parse(new TextDecoder().decode(await decryptBytes(payload)));
  }

  function makeInviteUrl() {
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set("room", state.roomId);
    url.hash = state.roomKeyText;
    return url.href;
  }

  function updateInviteUrl() {
    history.replaceState(null, "", makeInviteUrl());
  }

  function makeRoomId() {
    return `gather-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  }

  async function startRoom(roomId, secret) {
    if (!roomId || !/^[a-zA-Z0-9-]{4,64}$/.test(roomId)) {
      $("#home-error").textContent = "That room code doesn't look quite right.";
      return;
    }
    if (!secret) {
      $("#home-error").textContent = "Paste the full invite link so we can unlock this room's encryption key.";
      return;
    }
    $("#home-error").textContent = "";
    try {
      state.roomKey = await importRoomKey(secret);
    } catch (error) {
      $("#home-error").textContent = error.message;
      return;
    }
    state.roomId = roomId;
    state.roomKeyText = secret;
    state.badKeyShown = false;
    state.messageCount = 0;
    state.whiteboardStrokes = [];
    $("#meeting-name").textContent = "A little room";
    $("#room-label-name").textContent = "A little room";
    $("#room-code-text").textContent = roomId;
    $("#chat-messages").replaceChildren();
    $("#chat-tab-count").classList.add("hidden");
    $("#chat-dot").classList.add("hidden");
    $("#panel-welcome").classList.remove("hidden");
    updateInviteUrl();
    showScreen("meeting");
    setChatPanel(false);
    state.participants.clear();
    state.participants.set("local", { id: "local", name: state.user.name, isLocal: true, videoEnabled: true, micEnabled: true });
    drawPeople();
    $("#local-initial").textContent = initials(state.user.name);
    $("#local-tile .participant-name").childNodes[1].textContent = ` ${state.user.name} (you) `;
    $("#local-placeholder").classList.remove("hidden");
    $("#local-video").classList.add("hidden");
    $("#empty-call").classList.remove("hidden");
    $("#participant-count").textContent = "1";
    state.startedAt = Date.now();
    state.timer = window.setInterval(updateTimer, 1000);
    await startLocalMedia();
    connectToRoom();
  }

  function setChatPanel(open) {
    const panel = $(".collab-panel");
    if (window.matchMedia("(max-width: 760px)").matches) {
      panel.classList.toggle("mobile-closed", !open);
    }
  }

  function setLocalMediaState() {
    const videoEnabled = Boolean(state.activeVideoTrack && state.activeVideoTrack.enabled);
    const micEnabled = Boolean(state.stream && state.stream.getAudioTracks().some((track) => track.enabled));
    $("#local-placeholder").classList.toggle("hidden", videoEnabled);
    $("#local-video").classList.toggle("hidden", !videoEnabled);
    $("#mic-status").textContent = micEnabled ? "♪" : "♪̸";
    $("#mic-button").classList.toggle("active", micEnabled);
    $("#mic-button").setAttribute("aria-label", micEnabled ? "Mute microphone" : "Unmute microphone");
    $("#mic-button small").textContent = micEnabled ? "Mute" : "Unmute";
    $("#camera-button").classList.toggle("active", videoEnabled);
    $("#camera-button").setAttribute("aria-label", videoEnabled ? "Turn camera off" : "Turn camera on");
    $("#camera-button small").textContent = videoEnabled ? "Stop video" : "Start video";
    if (state.socket && state.socket.connected) state.socket.emit("media:state", { videoEnabled, micEnabled });
    const local = state.participants.get("local");
    if (local) {
      local.videoEnabled = videoEnabled;
      local.micEnabled = micEnabled;
      drawPeople();
    }
  }

  async function startLocalMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("Camera and microphone need a secure connection (HTTPS or localhost).");
      setLocalMediaState();
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (error) {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        showToast("Camera unavailable. You can still join with audio.");
      } catch (audioError) {
        state.stream = new MediaStream();
        showToast("Camera and microphone are unavailable. Check your browser permissions.");
      }
    }
    state.activeVideoTrack = state.stream.getVideoTracks()[0] || null;
    if (state.activeVideoTrack) {
      $("#local-video").srcObject = new MediaStream([state.activeVideoTrack]);
    }
    setLocalMediaState();
  }

  function connectToRoom() {
    if (state.socket) state.socket.disconnect();
    const socket = window.io({ autoConnect: false, reconnection: true });
    state.socket = socket;
    socket.on("connect", () => {
      state.peers.forEach((peer) => peer.connection.close());
      state.peers.clear();
      state.participants.clear();
      state.participants.set("local", {
        id: "local", name: state.user.name, isLocal: true, videoEnabled: true, micEnabled: true
      });
      $("#video-grid").querySelectorAll(".remote-tile").forEach((tile) => tile.remove());
      drawPeople();
      socket.emit("room:join", state.roomId, (result) => {
        if (!result || result.error) {
          showToast(result && result.error ? result.error : "We couldn't join this room.");
          cleanupRoom();
          renderHome();
          history.replaceState(null, "", window.location.pathname);
          return;
        }
        result.participants.forEach((participant) => {
          addParticipant(participant);
          createPeerConnection(participant.id, true);
        });
        setLocalMediaState();
        result.boardHistory.forEach((stroke) => handleBoardDraw(stroke));
      });
    });
    socket.on("connect_error", (error) => {
      if (error.message === "Authentication required.") {
        cleanupRoom();
        showScreen("auth");
        setAuthMode("login");
        authError.textContent = "Your session ended. Please sign in again.";
      } else {
        showToast("Connection hiccup. Trying to reconnect…");
      }
    });
    socket.on("room:participant-joined", addParticipant);
    socket.on("room:participant-left", ({ id }) => removeParticipant(id));
    socket.on("rtc:signal", handleSignal);
    socket.on("chat:message", handleChatMessage);
    socket.on("file:share", handleIncomingFile);
    socket.on("board:draw", handleBoardDraw);
    socket.on("board:clear", handleBoardClear);
    socket.on("media:state", handleMediaState);
    socket.on("app:error", showToast);
    socket.connect();
  }

  function addParticipant(participant) {
    if (!participant || !participant.id || state.participants.has(participant.id)) return;
    state.participants.set(participant.id, {
      id: participant.id,
      name: participant.user && participant.user.name ? participant.user.name : "Someone",
      isLocal: false,
      videoEnabled: true,
      micEnabled: true
    });
    ensureRemoteTile(participant.id);
    drawPeople();
    $("#empty-call").classList.add("hidden");
    showToast(`${state.participants.get(participant.id).name} just joined ✳`);
  }

  function removeParticipant(id) {
    const participant = state.participants.get(id);
    state.participants.delete(id);
    const peer = state.peers.get(id);
    if (peer) peer.connection.close();
    state.peers.delete(id);
    const tile = document.getElementById(`tile-${id}`);
    if (tile) tile.remove();
    if (state.participants.size <= 1) $("#empty-call").classList.remove("hidden");
    drawPeople();
    if (participant) showToast(`${participant.name} left the room.`);
  }

  function drawPeople() {
    const list = $("#people-list");
    if (!list) return;
    list.replaceChildren();
    state.participants.forEach((person) => {
      const row = document.createElement("div");
      row.className = "person-row";
      const avatar = document.createElement("span");
      avatar.className = "message-avatar";
      avatar.textContent = initials(person.name);
      const detail = document.createElement("span");
      detail.className = "person-row-name";
      const name = document.createElement("b");
      name.textContent = person.isLocal ? `${person.name} (you)` : person.name;
      const status = document.createElement("small");
      status.textContent = person.micEnabled ? "Here together" : "Microphone muted";
      const dot = document.createElement("span");
      dot.className = "person-row-status";
      detail.append(name, status);
      row.append(avatar, detail, dot);
      list.append(row);
    });
    const count = state.participants.size;
    $("#participant-count").textContent = String(count);
    $("#people-count").textContent = String(count);
    $("#people-panel-count").textContent = `${count} ${count === 1 ? "person" : "people"}`;
  }

  function createPeerConnection(id, shouldOffer) {
    const current = state.peers.get(id);
    if (current) return current.connection;
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    const peer = { connection, pendingCandidates: [] };
    state.peers.set(id, peer);
    peer.videoSender = connection.addTransceiver("video", { direction: "sendrecv" }).sender;
    if (state.stream) {
      state.stream.getAudioTracks().forEach((track) => connection.addTrack(track, state.stream));
      const videoTrack = state.activeVideoTrack || state.stream.getVideoTracks()[0];
      if (videoTrack) peer.videoSender.replaceTrack(videoTrack);
    }
    connection.onicecandidate = (event) => {
      if (event.candidate && state.socket) state.socket.emit("rtc:signal", { target: id, candidate: event.candidate });
    };
    connection.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      renderRemoteVideo(id, stream);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") showToast("A connection couldn't be made. Ask your network admin about TURN.");
    };
    if (shouldOffer) {
      connection.createOffer()
        .then((offer) => connection.setLocalDescription(offer))
        .then(() => state.socket.emit("rtc:signal", { target: id, description: connection.localDescription }))
        .catch((error) => {
          console.error("Could not start the peer connection:", error);
          showToast("We couldn't connect to a participant.");
        });
    }
    return connection;
  }

  async function handleSignal(payload) {
    if (!payload || !payload.sender) return;
    const connection = createPeerConnection(payload.sender, false);
    const peer = state.peers.get(payload.sender);
    try {
      if (payload.description) {
        await connection.setRemoteDescription(payload.description);
        const candidates = peer.pendingCandidates.splice(0);
        for (const candidate of candidates) await connection.addIceCandidate(candidate);
        if (payload.description.type === "offer") {
          await connection.setLocalDescription(await connection.createAnswer());
          state.socket.emit("rtc:signal", { target: payload.sender, description: connection.localDescription });
        }
      } else if (payload.candidate) {
        if (connection.remoteDescription) await connection.addIceCandidate(payload.candidate);
        else peer.pendingCandidates.push(payload.candidate);
      }
    } catch (error) {
      console.error("Peer signaling failed:", error);
      showToast("A participant's connection needs to be retried.");
    }
  }

  function renderRemoteVideo(id, stream) {
    const tile = ensureRemoteTile(id);
    const video = tile.querySelector("video");
    if (video.srcObject !== stream) video.srcObject = stream;
    const person = state.participants.get(id);
    video.classList.toggle("hidden", Boolean(person && !person.videoEnabled));
    tile.querySelector(".video-placeholder").classList.toggle("hidden", Boolean(person && person.videoEnabled));
    video.play().catch(() => {});
  }

  function ensureRemoteTile(id) {
    let tile = document.getElementById(`tile-${id}`);
    if (!tile) {
      tile = document.createElement("article");
      tile.id = `tile-${id}`;
      tile.className = "video-tile remote-tile";
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.classList.add("hidden");
      const placeholder = document.createElement("div");
      placeholder.className = "video-placeholder";
      const initial = document.createElement("span");
      initial.className = "person-initial";
      const name = state.participants.get(id)?.name || "?";
      initial.textContent = initials(name);
      placeholder.append(initial);
      const caption = document.createElement("span");
      caption.className = "participant-name";
      caption.textContent = name;
      tile.append(video, placeholder, caption);
      $("#video-grid").append(tile);
    }
    return tile;
  }

  function handleMediaState(payload) {
    const person = state.participants.get(payload.senderId);
    if (!person || person.isLocal) return;
    person.videoEnabled = payload.videoEnabled;
    person.micEnabled = payload.micEnabled;
    const tile = document.getElementById(`tile-${person.id}`);
    if (tile) {
      tile.querySelector("video").classList.toggle("hidden", !payload.videoEnabled);
      tile.querySelector(".video-placeholder").classList.toggle("hidden", payload.videoEnabled);
      const caption = tile.querySelector(".participant-name");
      caption.textContent = `${person.name}${payload.micEnabled ? "" : " · muted"}`;
    }
    drawPeople();
  }

  async function sendEncrypted(event, value) {
    const encrypted = await encryptObject(value);
    state.socket.emit(event, encrypted);
  }

  function appendMessage(sender, text, time = Date.now()) {
    const messages = $("#chat-messages");
    $("#panel-welcome").classList.add("hidden");
    const item = document.createElement("article");
    item.className = "chat-message";
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.textContent = initials(sender);
    const content = document.createElement("div");
    content.className = "message-content";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("b");
    name.textContent = sender;
    const timestamp = document.createElement("time");
    timestamp.textContent = new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    meta.append(name, timestamp);
    const body = document.createElement("p");
    body.textContent = text;
    content.append(meta, body);
    item.append(avatar, content);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    state.messageCount += 1;
    $("#chat-tab-count").textContent = String(state.messageCount);
    $("#chat-tab-count").classList.remove("hidden");
    if ($(".collab-panel").classList.contains("mobile-closed")) $("#chat-dot").classList.remove("hidden");
  }

  async function handleChatMessage(payload) {
    try {
      const message = await decryptObject(payload);
      if (typeof message.text !== "string" || message.text.length > 2000) return;
      appendMessage(payload.sender || "Someone", message.text, payload.sentAt);
    } catch (error) {
      handleDecryptError(error);
    }
  }

  function handleDecryptError(error) {
    if (error.name !== "OperationError" && !(error instanceof SyntaxError)) {
      console.error("Could not decrypt room content:", error);
    }
    if (!state.badKeyShown) {
      state.badKeyShown = true;
      showToast("This room invite uses a different encryption key.");
    }
  }

  async function handleIncomingFile(payload) {
    try {
      const packet = await decryptBytes(payload);
      if (packet.length < 4) throw new Error("Invalid file packet.");
      const metadataLength = new DataView(packet.buffer, packet.byteOffset, 4).getUint32(0);
      if (metadataLength > 1000 || packet.length < metadataLength + 4) throw new Error("Invalid file metadata.");
      const metadata = JSON.parse(new TextDecoder().decode(packet.subarray(4, metadataLength + 4)));
      if (typeof metadata.name !== "string" || typeof metadata.type !== "string") throw new Error("Invalid file metadata.");
      const blob = new Blob([packet.subarray(metadataLength + 4)], { type: metadata.type || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      state.objectUrls.add(url);
      appendFile(payload.sender || "Someone", metadata.name, blob.size, url, payload.sentAt);
    } catch (error) {
      handleDecryptError(error);
    }
  }

  function appendFile(sender, filename, size, url, time = Date.now()) {
    const messages = $("#chat-messages");
    $("#panel-welcome").classList.add("hidden");
    const item = document.createElement("article");
    item.className = "chat-message";
    const avatar = document.createElement("span");
    avatar.className = "message-avatar";
    avatar.textContent = initials(sender);
    const content = document.createElement("div");
    content.className = "message-content";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("b");
    name.textContent = sender;
    const timestamp = document.createElement("time");
    timestamp.textContent = new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    meta.append(name, timestamp);
    const download = document.createElement("a");
    download.className = "file-download";
    download.href = url;
    download.download = filename;
    download.innerHTML = `<span aria-hidden="true">↧</span><span></span><small></small>`;
    download.querySelectorAll("span")[1].textContent = filename;
    download.querySelector("small").textContent = `${Math.max(1, Math.round(size / 1024))} KB`;
    content.append(meta, download);
    item.append(avatar, content);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    state.messageCount += 1;
    $("#chat-tab-count").textContent = String(state.messageCount);
    $("#chat-tab-count").classList.remove("hidden");
  }

  function positionOnCanvas(point) {
    return { x: point.x * canvas.width, y: point.y * canvas.height };
  }

  function renderStroke(stroke) {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(stroke.color) || stroke.points.length > 3000) return;
    const points = stroke.points.filter((point) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    );
    if (!points.length) return;
    canvasContext.beginPath();
    canvasContext.strokeStyle = stroke.color;
    canvasContext.lineWidth = Math.max(1, Math.min(12, Number(stroke.width) || 3)) * (window.devicePixelRatio || 1);
    canvasContext.lineCap = "round";
    canvasContext.lineJoin = "round";
    const first = positionOnCanvas(points[0]);
    canvasContext.moveTo(first.x, first.y);
    points.slice(1).forEach((point) => {
      const position = positionOnCanvas(point);
      canvasContext.lineTo(position.x, position.y);
    });
    if (points.length === 1) {
      canvasContext.lineTo(first.x + 0.1, first.y + 0.1);
    }
    canvasContext.stroke();
  }

  function redrawBoard() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    } else {
      canvasContext.clearRect(0, 0, width, height);
    }
    state.whiteboardStrokes.forEach(renderStroke);
  }

  async function handleBoardDraw(payload) {
    try {
      const stroke = await decryptObject(payload);
      if (!Array.isArray(stroke.points) || stroke.points.length > 3000) return;
      state.whiteboardStrokes.push(stroke);
      renderStroke(stroke);
    } catch (error) {
      handleDecryptError(error);
    }
  }

  async function handleBoardClear(payload) {
    try {
      await decryptObject(payload);
      state.whiteboardStrokes = [];
      canvasContext.clearRect(0, 0, canvas.width, canvas.height);
    } catch (error) {
      handleDecryptError(error);
    }
  }

  function updateTimer() {
    const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
    $("#call-timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
  }

  function leaveRoom() {
    cleanupRoom();
    renderHome();
    history.replaceState(null, "", window.location.pathname);
  }

  function cleanupRoom() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    state.peers.forEach((peer) => peer.connection.close());
    state.peers.clear();
    if (state.screenStream) state.screenStream.getTracks().forEach((track) => track.stop());
    state.screenStream = null;
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    state.activeVideoTrack = null;
    state.participants.clear();
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.objectUrls.clear();
    $("#local-video").srcObject = null;
    $("#chat-messages").replaceChildren();
    $("#video-grid").querySelectorAll(".remote-tile").forEach((tile) => tile.remove());
    $("#screen-button").classList.remove("active");
    $("#board-modal").classList.add("hidden");
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(makeInviteUrl());
      showToast("Invite link copied — the encryption key stays in the link ✳");
    } catch (error) {
      console.error("Clipboard access failed:", error);
      showToast("Couldn't copy the link. Check your browser's clipboard permissions.");
    }
  }

  authModeButtons.forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authError.textContent = "";
    authSubmit.disabled = true;
    try {
      const payload = {
        email: emailInput.value,
        password: passwordInput.value
      };
      const result = await api(state.authMode === "register" ? "/api/auth/register" : "/api/auth/login",
        state.authMode === "register" ? { ...payload, name: nameInput.value } : payload);
      state.user = result.user;
      renderHome();
      const pendingInvite = inviteFromLocation();
      if (pendingInvite) await startRoom(pendingInvite.roomId, pendingInvite.secret);
    } catch (error) {
      authError.textContent = error.message;
    } finally {
      authSubmit.disabled = false;
    }
  });

  $("#create-room").addEventListener("click", () => {
    const secret = encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
    startRoom(makeRoomId(), secret);
  });
  $("#create-room-card").addEventListener("click", () => $("#create-room").click());
  $("#join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $("#room-input").value.trim();
    const invite = parseInvite(value);
    if (invite) startRoom(invite.roomId, invite.secret);
    else startRoom(value, "");
  });
  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", {});
      state.user = null;
      setAuthMode("login");
      showScreen("auth");
    } catch (error) {
      showToast(error.message);
    }
  });
  $("#invite-button").addEventListener("click", copyInvite);
  $("#empty-invite").addEventListener("click", copyInvite);
  $("#people-invite").addEventListener("click", copyInvite);
  $("#copy-room-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.roomId);
      showToast("Room code copied. Share the full invite link to include its encryption key.");
    } catch (error) {
      console.error("Clipboard access failed:", error);
      showToast("Couldn't copy the room code. Check your browser's clipboard permissions.");
    }
  });
  $("#leave-button").addEventListener("click", leaveRoom);
  $("#leave-call").addEventListener("click", leaveRoom);

  $("#mic-button").addEventListener("click", () => {
    if (!state.stream || !state.stream.getAudioTracks().length) {
      showToast("No microphone is available. Check your browser permissions.");
      return;
    }
    state.stream.getAudioTracks().forEach((track) => { track.enabled = !track.enabled; });
    setLocalMediaState();
  });
  $("#camera-button").addEventListener("click", async () => {
    if (state.screenStream) {
      showToast("Stop screen sharing before switching your camera.");
      return;
    }
    if (state.activeVideoTrack) {
      state.activeVideoTrack.enabled = !state.activeVideoTrack.enabled;
      setLocalMediaState();
      return;
    }
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = camera.getVideoTracks()[0];
      state.stream.addTrack(track);
      state.activeVideoTrack = track;
      $("#local-video").srcObject = new MediaStream([track]);
      for (const peer of state.peers.values()) {
        await peer.videoSender.replaceTrack(track);
      }
      setLocalMediaState();
    } catch (error) {
      console.error("Could not start the camera:", error);
      showToast("Camera access was denied or no camera was found.");
    }
  });

  $("#screen-button").addEventListener("click", async () => {
    if (state.screenStream) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast("Screen sharing isn't available in this browser.");
      return;
    }
    try {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = state.screenStream.getVideoTracks()[0];
      const previousTrack = state.activeVideoTrack;
      if (previousTrack) previousTrack.enabled = false;
      state.activeVideoTrack = track;
      $("#local-video").srcObject = state.screenStream;
      for (const peer of state.peers.values()) {
        await peer.videoSender.replaceTrack(track);
      }
      $("#screen-button").classList.add("active");
      track.onended = stopScreenShare;
      setLocalMediaState();
    } catch (error) {
      if (error.name !== "NotAllowedError") {
        console.error("Could not share the screen:", error);
        showToast("Screen sharing couldn't start.");
      }
    }
  });

  async function stopScreenShare() {
    if (!state.screenStream) return;
    const sharedStream = state.screenStream;
    state.screenStream = null;
    sharedStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    const cameraTrack = state.stream && state.stream.getVideoTracks().find((track) => track.readyState === "live");
    state.activeVideoTrack = cameraTrack || null;
    if (cameraTrack) cameraTrack.enabled = true;
    $("#local-video").srcObject = cameraTrack ? new MediaStream([cameraTrack]) : null;
    for (const peer of state.peers.values()) {
      if (peer.videoSender) await peer.videoSender.replaceTrack(cameraTrack);
    }
    $("#screen-button").classList.remove("active");
    setLocalMediaState();
  }

  $("#board-button").addEventListener("click", () => {
    $("#board-modal").classList.remove("hidden");
    requestAnimationFrame(redrawBoard);
  });
  $("#close-board").addEventListener("click", () => $("#board-modal").classList.add("hidden"));
  $("#board-modal").addEventListener("click", (event) => {
    if (event.target === $("#board-modal")) $("#board-modal").classList.add("hidden");
  });
  $("#clear-board").addEventListener("click", async () => {
    state.whiteboardStrokes = [];
    canvasContext.clearRect(0, 0, canvas.width, canvas.height);
    try {
      await sendEncrypted("board:clear", { cleared: true });
    } catch (error) {
      console.error("Could not clear the shared board:", error);
      showToast("The board couldn't be cleared for everyone.");
    }
  });
  $("#pen-color").addEventListener("input", (event) => { canvasContext.strokeStyle = event.target.value; });

  function boardPointerDown(event) {
    const rect = canvas.getBoundingClientRect();
    state.drawing = true;
    state.currentStroke = {
      color: $("#pen-color").value,
      width: 3,
      points: [{ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }]
    };
    canvas.setPointerCapture(event.pointerId);
  }
  function boardPointerMove(event) {
    if (!state.drawing || !state.currentStroke) return;
    const rect = canvas.getBoundingClientRect();
    const point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    state.currentStroke.points.push(point);
    renderStroke({ ...state.currentStroke, points: state.currentStroke.points.slice(-2) });
  }
  async function boardPointerUp() {
    if (!state.drawing || !state.currentStroke) return;
    state.drawing = false;
    const stroke = state.currentStroke;
    state.currentStroke = null;
    if (stroke.points.length > 3000) {
      const stride = Math.ceil(stroke.points.length / 3000);
      stroke.points = stroke.points.filter((_point, index) => index % stride === 0);
    }
    state.whiteboardStrokes.push(stroke);
    try {
      await sendEncrypted("board:draw", stroke);
    } catch (error) {
      console.error("Could not share a whiteboard stroke:", error);
      showToast("That drawing couldn't be shared.");
    }
  }
  canvas.addEventListener("pointerdown", boardPointerDown);
  canvas.addEventListener("pointermove", boardPointerMove);
  canvas.addEventListener("pointerup", boardPointerUp);
  canvas.addEventListener("pointercancel", boardPointerUp);
  window.addEventListener("resize", () => {
    if (!$("#board-modal").classList.contains("hidden")) redrawBoard();
  });

  document.querySelectorAll(".panel-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.panel;
      document.querySelectorAll(".panel-tab").forEach((item) => item.classList.toggle("active", item === button));
      $("#chat-panel").classList.toggle("hidden", tab !== "chat");
      $("#people-panel").classList.toggle("hidden", tab !== "people");
      if (tab === "chat") $("#chat-dot").classList.add("hidden");
      setChatPanel(true);
    });
  });
  $("#chat-button").addEventListener("click", () => {
    const panel = $(".collab-panel");
    if (window.matchMedia("(max-width: 760px)").matches && !panel.classList.contains("mobile-closed")) {
      panel.classList.add("mobile-closed");
      return;
    }
    document.querySelector('[data-panel="chat"]').click();
  });
  $("#chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text || !state.socket || !state.socket.connected) return;
    try {
      await sendEncrypted("chat:message", { text });
      input.value = "";
      input.style.height = "auto";
    } catch (error) {
      console.error("Could not send an encrypted message:", error);
      showToast("Your message couldn't be sent.");
    }
  });
  $("#chat-input").addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 76)}px`;
  });
  $("#attach-file").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      showToast("Files need to be smaller than 6 MB.");
      return;
    }
    if (!state.socket || !state.socket.connected) {
      showToast("Reconnect to the room before sharing a file.");
      return;
    }
    try {
      const content = new Uint8Array(await file.arrayBuffer());
      const metadata = new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type || "application/octet-stream" }));
      const packet = new Uint8Array(4 + metadata.length + content.length);
      new DataView(packet.buffer).setUint32(0, metadata.length);
      packet.set(metadata, 4);
      packet.set(content, 4 + metadata.length);
      const encrypted = await encryptBytes(packet);
      state.socket.emit("file:share", encrypted);
      showToast("Your file is tucked into an encrypted message ✳");
    } catch (error) {
      console.error("Could not encrypt or share this file:", error);
      showToast("That file couldn't be shared.");
    }
  });

  async function bootstrap() {
    try {
      const result = await api("/api/auth/me");
      state.user = result.user;
      renderHome();
      const invite = inviteFromLocation();
      if (invite) await startRoom(invite.roomId, invite.secret);
    } catch {
      showScreen("auth");
      setAuthMode("login");
    }
  }
  bootstrap();
})();
