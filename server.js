const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const COOKIE = "orbit_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const DATA_DIRECTORY = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIRECTORY, "database.json");
const SECRET_FILE = path.join(DATA_DIRECTORY, "session-secret");

fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
const SECRET = process.env.SESSION_SECRET || (() => {
  try {
    return fs.readFileSync(SECRET_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  }
})();

function readDatabase() {
  try {
    const database = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      users: database.users || [],
      projects: database.projects || [],
      tasks: database.tasks || [],
      notifications: database.notifications || [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { users: [], projects: [], tasks: [], notifications: [] };
  }
}

const db = readDatabase();
const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_ATTEMPT_LIMIT = 20;

function saveDatabase() {
  const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, DATA_FILE);
}

function id() {
  return crypto.randomUUID();
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.exp > Date.now() / 1000 ? db.users.find((user) => user.id === claims.sub) || null : null;
  } catch {
    return null;
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve({ salt, hash: derivedKey.toString("hex") });
    });
  });
}

function samePassword(password, user) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, user.salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      const expected = Buffer.from(user.passwordHash, "hex");
      resolve(expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.socket.io; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: "32kb" }));

function authenticate(req, res, next) {
  req.user = verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (!req.user) return res.status(401).json({ error: "Please sign in to continue." });
  next();
}

function limitAuthAttempts(req, res, next) {
  const key = req.ip;
  const current = authAttempts.get(key);
  const now = Date.now();
  if (current && current.expiresAt > now && current.count >= AUTH_ATTEMPT_LIMIT) {
    res.set("Retry-After", String(Math.ceil((current.expiresAt - now) / 1000)));
    return res.status(429).json({ error: "Too many sign-in attempts. Please try again in a few minutes." });
  }
  const attempt = !current || current.expiresAt <= now ? { count: 0, expiresAt: now + AUTH_WINDOW_MS } : current;
  attempt.count += 1;
  authAttempts.set(key, attempt);
  if (authAttempts.size > 10000) {
    for (const [ip, entry] of authAttempts) {
      if (entry.expiresAt <= now) authAttempts.delete(ip);
    }
  }
  next();
}

function projectForMember(projectId, userId) {
  return db.projects.find((project) => project.id === projectId && project.memberIds.includes(userId));
}

function emitProject(projectId, event, payload, excludeUserId) {
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) return;
  for (const memberId of project.memberIds) {
    if (memberId !== excludeUserId) io.to(`user:${memberId}`).emit(event, payload);
  }
}

function addNotification(userId, projectId, taskId, message) {
  if (!userId) return;
  const notification = { id: id(), userId, projectId, taskId, message, createdAt: new Date().toISOString(), read: false };
  db.notifications.unshift(notification);
  db.notifications = db.notifications.slice(0, 500);
  io.to(`user:${userId}`).emit("notification:new", notification);
}

io.use((socket, next) => {
  const user = verifyToken(parseCookies(socket.handshake.headers.cookie)[COOKIE]);
  if (!user) return next(new Error("Authentication required"));
  socket.user = user;
  next();
});
io.on("connection", (socket) => {
  socket.join(`user:${socket.user.id}`);
});

app.post("/api/auth/register", limitAuthAttempts, async (req, res, next) => {
  try {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (name.length < 2 || name.length > 50) return res.status(400).json({ error: "Your name must be between 2 and 50 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Your password must be between 8 and 128 characters." });
    if (db.users.some((user) => user.email === email)) return res.status(409).json({ error: "An account with that email already exists." });
    const credentials = await hashPassword(password);
    if (db.users.some((user) => user.email === email)) return res.status(409).json({ error: "An account with that email already exists." });
    const user = { id: id(), name, email, ...credentials, createdAt: new Date().toISOString() };
    db.users.push(user);
    saveDatabase();
    authAttempts.delete(req.ip);
    res.cookie(COOKIE, signToken(user.id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: SESSION_SECONDS * 1000, path: "/" });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", limitAuthAttempts, async (req, res, next) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = db.users.find((item) => item.email === email);
    if (!user || !(await samePassword(password, user))) return res.status(401).json({ error: "Email or password is incorrect." });
    authAttempts.delete(req.ip);
    res.cookie(COOKIE, signToken(user.id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: SESSION_SECONDS * 1000, path: "/" });
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.status(204).end();
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: publicUser(req.user) }));
app.get("/api/users", authenticate, (_req, res) => res.json({ users: db.users.map(publicUser) }));

app.get("/api/projects", authenticate, (req, res) => {
  const projects = db.projects.filter((project) => project.memberIds.includes(req.user.id)).map((project) => ({
    ...project,
    members: project.memberIds.map((memberId) => db.users.find((user) => user.id === memberId)).filter(Boolean).map(publicUser),
  }));
  res.json({ projects });
});

app.post("/api/projects", authenticate, (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 80) return res.status(400).json({ error: "Project names must be between 1 and 80 characters." });
  const requested = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  const memberIds = [...new Set([req.user.id, ...requested.filter((userId) => db.users.some((user) => user.id === userId))])];
  const project = { id: id(), name, description: typeof req.body.description === "string" ? req.body.description.trim().slice(0, 500) : "", ownerId: req.user.id, memberIds, createdAt: new Date().toISOString() };
  db.projects.push(project);
  saveDatabase();
  const result = { ...project, members: memberIds.map((memberId) => publicUser(db.users.find((user) => user.id === memberId))) };
  for (const memberId of memberIds) {
    if (memberId !== req.user.id) addNotification(memberId, project.id, null, `${req.user.name} added you to ${project.name}.`);
  }
  res.status(201).json({ project: result });
});

app.post("/api/projects/:projectId/members", authenticate, (req, res) => {
  const project = projectForMember(req.params.projectId, req.user.id);
  if (!project) return res.status(404).json({ error: "Project not found." });
  const userId = typeof req.body.userId === "string" ? req.body.userId : "";
  const user = db.users.find((item) => item.id === userId);
  if (!user) return res.status(404).json({ error: "That teammate could not be found." });
  if (!project.memberIds.includes(userId)) {
    project.memberIds.push(userId);
    saveDatabase();
    addNotification(userId, project.id, null, `${req.user.name} added you to ${project.name}.`);
    io.to(`user:${userId}`).emit("project:updated", { projectId: project.id, member: publicUser(user) });
    emitProject(project.id, "project:updated", { projectId: project.id, member: publicUser(user) }, userId);
  }
  res.json({ project: { ...project, members: project.memberIds.map((memberId) => publicUser(db.users.find((item) => item.id === memberId))) } });
});

app.get("/api/projects/:projectId/tasks", authenticate, (req, res) => {
  if (!projectForMember(req.params.projectId, req.user.id)) return res.status(404).json({ error: "Project not found." });
  const tasks = db.tasks.filter((task) => task.projectId === req.params.projectId).map((task) => ({
    ...task,
    assignee: task.assigneeId ? publicUser(db.users.find((user) => user.id === task.assigneeId)) : null,
    comments: task.comments.map((comment) => ({ ...comment, author: publicUser(db.users.find((user) => user.id === comment.userId)) })),
  }));
  res.json({ tasks });
});

app.post("/api/projects/:projectId/tasks", authenticate, (req, res) => {
  const project = projectForMember(req.params.projectId, req.user.id);
  if (!project) return res.status(404).json({ error: "Project not found." });
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  if (!title || title.length > 160) return res.status(400).json({ error: "Task titles must be between 1 and 160 characters." });
  const assigneeId = typeof req.body.assigneeId === "string" && project.memberIds.includes(req.body.assigneeId) ? req.body.assigneeId : null;
  if (typeof req.body.dueDate === "string" && req.body.dueDate && !validDate(req.body.dueDate)) return res.status(400).json({ error: "Choose a valid due date." });
  const task = { id: id(), projectId: project.id, title, description: typeof req.body.description === "string" ? req.body.description.trim().slice(0, 2000) : "", status: ["todo", "inprogress", "done"].includes(req.body.status) ? req.body.status : "todo", assigneeId, dueDate: validDate(req.body.dueDate) ? req.body.dueDate : "", createdBy: req.user.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), comments: [] };
  db.tasks.push(task);
  saveDatabase();
  const result = { ...task, assignee: assigneeId ? publicUser(db.users.find((user) => user.id === assigneeId)) : null };
  emitProject(project.id, "task:created", result, req.user.id);
  if (assigneeId && assigneeId !== req.user.id) addNotification(assigneeId, project.id, task.id, `${req.user.name} assigned you "${task.title}".`);
  res.status(201).json({ task: result });
});

app.patch("/api/tasks/:taskId", authenticate, (req, res) => {
  const task = db.tasks.find((item) => item.id === req.params.taskId);
  const project = task && projectForMember(task.projectId, req.user.id);
  if (!task || !project) return res.status(404).json({ error: "Task not found." });
  if (typeof req.body.title === "string") {
    const title = req.body.title.trim();
    if (!title || title.length > 160) return res.status(400).json({ error: "Task titles must be between 1 and 160 characters." });
    task.title = title;
  }
  if (typeof req.body.description === "string") task.description = req.body.description.trim().slice(0, 2000);
  if (typeof req.body.status === "string") {
    if (!["todo", "inprogress", "done"].includes(req.body.status)) return res.status(400).json({ error: "Choose a valid task status." });
    task.status = req.body.status;
  }
  if (Object.hasOwn(req.body, "assigneeId")) {
    if (req.body.assigneeId !== null && !project.memberIds.includes(req.body.assigneeId)) return res.status(400).json({ error: "The assignee must be a project member." });
    task.assigneeId = req.body.assigneeId;
  }
  if (typeof req.body.dueDate === "string") {
    if (req.body.dueDate && !validDate(req.body.dueDate)) return res.status(400).json({ error: "Choose a valid due date." });
    task.dueDate = req.body.dueDate;
  }
  task.updatedAt = new Date().toISOString();
  saveDatabase();
  const result = {
    ...task,
    assignee: task.assigneeId ? publicUser(db.users.find((user) => user.id === task.assigneeId)) : null,
    comments: task.comments.map((comment) => ({ ...comment, author: publicUser(db.users.find((user) => user.id === comment.userId)) })),
  };
  emitProject(project.id, "task:updated", result, req.user.id);
  if (task.assigneeId && task.assigneeId !== req.user.id) addNotification(task.assigneeId, project.id, task.id, `${req.user.name} updated "${task.title}".`);
  res.json({ task: result });
});

app.delete("/api/tasks/:taskId", authenticate, (req, res) => {
  const index = db.tasks.findIndex((item) => item.id === req.params.taskId);
  const task = db.tasks[index];
  const project = task && projectForMember(task.projectId, req.user.id);
  if (!task || !project) return res.status(404).json({ error: "Task not found." });
  db.tasks.splice(index, 1);
  saveDatabase();
  emitProject(project.id, "task:deleted", { taskId: task.id, projectId: project.id }, req.user.id);
  res.status(204).end();
});

app.post("/api/tasks/:taskId/comments", authenticate, (req, res) => {
  const task = db.tasks.find((item) => item.id === req.params.taskId);
  const project = task && projectForMember(task.projectId, req.user.id);
  if (!task || !project) return res.status(404).json({ error: "Task not found." });
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > 2000) return res.status(400).json({ error: "Comments must be between 1 and 2,000 characters." });
  const comment = { id: id(), userId: req.user.id, text, createdAt: new Date().toISOString() };
  task.comments.push(comment);
  task.updatedAt = comment.createdAt;
  saveDatabase();
  const result = { ...comment, author: publicUser(req.user), taskId: task.id, projectId: project.id };
  emitProject(project.id, "comment:created", result, req.user.id);
  const recipientIds = new Set(project.memberIds.filter((userId) => userId !== req.user.id));
  if (task.assigneeId && task.assigneeId !== req.user.id) recipientIds.add(task.assigneeId);
  for (const userId of recipientIds) addNotification(userId, project.id, task.id, `${req.user.name} commented on "${task.title}".`);
  res.status(201).json({ comment: result });
});

app.get("/api/notifications", authenticate, (req, res) => {
  res.json({ notifications: db.notifications.filter((notification) => notification.userId === req.user.id) });
});

app.patch("/api/notifications/read", authenticate, (req, res) => {
  for (const notification of db.notifications) {
    if (notification.userId === req.user.id) notification.read = true;
  }
  saveDatabase();
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.use((error, _req, res, _next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

server.listen(PORT, () => {
  console.log(`Orbit Projects is running at http://localhost:${PORT}`);
});
