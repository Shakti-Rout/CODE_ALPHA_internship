const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3100;
const COOKIE_NAME = "gather_session";
const SESSION_TTL = 7 * 24 * 60 * 60;
const MAX_FILE_CIPHERTEXT = 8_500_000;
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const users = loadUsers();
const authAttempts = new Map();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 9_000_000 });

function loadUsers() {
  try {
    const content = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("User database has an invalid format.");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return Object.create(null);
    throw error;
  }
}

function saveUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(users), { mode: 0o600 });
  fs.renameSync(temporaryFile, USERS_FILE);
}

function signSession(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims.sub !== "string" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) return null;
    return Object.values(users).find((user) => user.id === claims.sub) || null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return "";
}

function requestUser(req, _res, next) {
  req.user = verifySession(getCookie(req, COOKIE_NAME));
  next();
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function passwordHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("hex"));
    });
  });
}

function setSessionCookie(res, user) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(signSession(user))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function limitedAuth(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const attempt = authAttempts.get(key);
  if (attempt && now - attempt.start < 15 * 60 * 1000 && attempt.count >= 12) {
    return res.status(429).json({ error: "Too many attempts. Please try again in a few minutes." });
  }
  if (!attempt || now - attempt.start >= 15 * 60 * 1000) {
    authAttempts.set(key, { start: now, count: 1 });
  } else {
    attempt.count += 1;
  }
  next();
}

function sameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch {
    return res.status(403).json({ error: "This request is not allowed." });
  }
  return res.status(403).json({ error: "This request is not allowed." });
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use(requestUser);

app.post("/api/auth/register", sameOrigin, limitedAuth, async (req, res, next) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (name.length < 2 || name.length > 48 || /[\u0000-\u001f\u007f]/.test(name)) {
      return res.status(400).json({ error: "Name must be between 2 and 48 characters." });
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: "Use a password between 10 and 128 characters." });
    }
    if (users[email]) return res.status(409).json({ error: "An account with that email already exists." });

    const salt = crypto.randomBytes(16).toString("hex");
    const user = { id: crypto.randomUUID(), name, email, salt, hash: await passwordHash(password, salt) };
    users[email] = user;
    saveUsers();
    setSessionCookie(res, user);
    return res.status(201).json({ user: safeUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/login", sameOrigin, limitedAuth, async (req, res, next) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = users[email];
    const salt = user ? user.salt : "0".repeat(32);
    const calculated = await passwordHash(password.slice(0, 128), salt);
    const expected = Buffer.from(user ? user.hash : "0".repeat(128), "hex");
    const actual = Buffer.from(calculated, "hex");
    if (!user || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    setSessionCookie(res, user);
    return res.json({ user: safeUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  return res.json({ user: safeUser(req.user) });
});

app.post("/api/auth/logout", sameOrigin, (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*path", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((error, _req, res, _next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return;
  return res.status(500).json({ error: "The request could not be completed." });
});

io.use((socket, next) => {
  const cookies = (socket.handshake.headers.cookie || "").split(";");
  const sessionCookie = cookies.find((cookie) => cookie.trim().startsWith(`${COOKIE_NAME}=`));
  let token = "";
  try {
    token = sessionCookie ? decodeURIComponent(sessionCookie.trim().slice(COOKIE_NAME.length + 1)) : "";
  } catch {
    return next(new Error("Authentication required."));
  }
  const user = verifySession(token);
  if (!user) return next(new Error("Authentication required."));
  socket.data.user = safeUser(user);
  next();
});

const roomMembers = new Map();
const roomBoards = new Map();

function publicParticipant(socket) {
  return { id: socket.id, user: socket.data.user };
}

function validRoomId(roomId) {
  return typeof roomId === "string" && /^[a-zA-Z0-9-]{4,64}$/.test(roomId);
}

io.on("connection", (socket) => {
  socket.on("room:join", (roomId, acknowledge) => {
    if (typeof acknowledge !== "function") return;
    if (!validRoomId(roomId)) return acknowledge({ error: "That meeting link is invalid." });
    if (socket.data.room) return acknowledge({ error: "You are already in a meeting." });
    const members = roomMembers.get(roomId) || new Set();
    if (members.size >= 16) return acknowledge({ error: "This meeting has reached its 16-person limit." });
    const existing = Array.from(members, (id) => io.sockets.sockets.get(id)).filter(Boolean);
    members.add(socket.id);
    roomMembers.set(roomId, members);
    socket.data.room = roomId;
    socket.join(roomId);
    acknowledge({
      participants: existing.map(publicParticipant),
      boardHistory: roomBoards.get(roomId) || []
    });
    socket.to(roomId).emit("room:participant-joined", publicParticipant(socket));
  });

  socket.on("rtc:signal", (payload) => {
    if (!socket.data.room || !payload || typeof payload.target !== "string") return;
    const peer = io.sockets.sockets.get(payload.target);
    if (!peer || peer.data.room !== socket.data.room) return;
    if (payload.description) {
      peer.emit("rtc:signal", { sender: socket.id, description: payload.description });
    } else if (payload.candidate) {
      peer.emit("rtc:signal", { sender: socket.id, candidate: payload.candidate });
    }
  });

  for (const event of ["chat:message", "board:draw", "board:clear", "file:share", "media:state"]) {
    socket.on(event, (payload) => {
      if (!socket.data.room || !payload || typeof payload !== "object") return;
      if (event === "media:state") {
        if (typeof payload.videoEnabled !== "boolean" || typeof payload.micEnabled !== "boolean") return;
        return socket.to(socket.data.room).emit(event, {
          sender: socket.data.user.name,
          senderId: socket.id,
          videoEnabled: payload.videoEnabled,
          micEnabled: payload.micEnabled
        });
      }
      if (event === "file:share" &&
          (typeof payload.ciphertext !== "string" || payload.ciphertext.length > MAX_FILE_CIPHERTEXT ||
           typeof payload.iv !== "string" || payload.iv.length > 32)) {
        return socket.emit("app:error", "That file could not be shared. Files must be under 6 MB.");
      }
      if (event !== "file:share" &&
          (typeof payload.ciphertext !== "string" || payload.ciphertext.length > 100_000 ||
           typeof payload.iv !== "string")) return;
      if (event === "board:draw" && payload.ciphertext.length > 20_000) return;
      if (event === "board:draw") {
        const strokes = roomBoards.get(socket.data.room) || [];
        strokes.push(payload);
        if (strokes.length > 100) strokes.shift();
        roomBoards.set(socket.data.room, strokes);
      }
      if (event === "board:clear") roomBoards.delete(socket.data.room);
      io.to(socket.data.room).emit(event, {
        ...payload,
        sender: socket.data.user.name,
        sentAt: Date.now()
      });
    });
  }

  socket.on("disconnect", () => {
    const roomId = socket.data.room;
    if (!roomId) return;
    const members = roomMembers.get(roomId);
    if (!members) return;
    members.delete(socket.id);
    socket.to(roomId).emit("room:participant-left", { id: socket.id });
    if (members.size === 0) {
      roomMembers.delete(roomId);
      roomBoards.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Gather is ready at http://localhost:${PORT}`);
});
