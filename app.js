const $ = (selector) => document.querySelector(selector);
const state = {
  user: null,
  users: [],
  projects: [],
  projectId: null,
  tasks: [],
  notifications: [],
  activeTaskId: null,
  authMode: "login",
  search: "",
  filter: "all",
  socket: null,
};

const columns = [
  { id: "todo", title: "To do", className: "column-todo" },
  { id: "inprogress", title: "In progress", className: "column-inprogress" },
  { id: "done", title: "Done", className: "column-done" },
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Something went wrong. Please try again.");
  return payload;
}

function initials(name = "") {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "?";
}

function relativeTime(date) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toast(message, type = "") {
  const notice = element("div", `toast ${type}`, message);
  $("#toast-region").append(notice);
  window.setTimeout(() => notice.remove(), 3400);
}

function activeProject() {
  return state.projects.find((project) => project.id === state.projectId) || null;
}

function activeTask() {
  return state.tasks.find((task) => task.id === state.activeTaskId) || null;
}

function showApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#profile-name").textContent = state.user.name;
  $("#profile-avatar").textContent = initials(state.user.name);
  $("#mobile-profile-button").textContent = initials(state.user.name);
  $("#comment-avatar").textContent = initials(state.user.name);
  $("#auth-error").textContent = "";
}

function showAuth() {
  $("#app-view").classList.add("hidden");
  $("#auth-view").classList.remove("hidden");
}

function populateUsers(select, members, includeUnassigned = false) {
  select.replaceChildren();
  if (includeUnassigned) {
    const option = element("option", "", "Unassigned");
    option.value = "";
    select.append(option);
  }
  for (const member of members) {
    const option = element("option", "", `${member.name} · ${member.email}`);
    option.value = member.id;
    select.append(option);
  }
}

function renderProjectList() {
  const nav = $("#project-list");
  nav.replaceChildren();
  const available = state.projects.filter((project) => project.memberIds.includes(state.user.id));
  if (!available.length) {
    nav.append(element("p", "empty-project-list", "Your first great project is just around the corner."));
    return;
  }
  for (const project of available) {
    const button = element("button", `project-nav-link${project.id === state.projectId ? " active" : ""}`);
    button.type = "button";
    button.setAttribute("aria-current", project.id === state.projectId ? "page" : "false");
    const symbol = element("span", "project-nav-symbol", "✳");
    const name = element("span", "project-nav-name", project.name);
    const count = element("span", "project-nav-count", String(state.tasks.filter((task) => task.projectId === project.id).length));
    button.append(symbol, name, count);
    button.addEventListener("click", () => selectProject(project.id));
    nav.append(button);
  }
}

function renderMembers() {
  const project = activeProject();
  const members = project ? project.members : [];
  const stack = $("#member-stack");
  stack.replaceChildren();
  for (const [index, member] of members.slice(0, 5).entries()) {
    const avatar = element("span", "avatar member-avatar", initials(member.name));
    avatar.title = member.name;
    avatar.setAttribute("aria-label", member.name);
    avatar.style.zIndex = String(members.length - index);
    stack.append(avatar);
  }
  if (members.length > 5) {
    const extra = element("span", "avatar member-avatar", `+${members.length - 5}`);
    extra.title = `${members.length - 5} more teammates`;
    stack.append(extra);
  }
  const footer = $("#footer-avatars");
  footer.replaceChildren();
  for (const [index, member] of members.slice(0, 4).entries()) {
    const avatar = element("span", "avatar member-avatar", initials(member.name));
    avatar.title = member.name;
    avatar.style.zIndex = String(members.length - index);
    footer.append(avatar);
  }
  if (!members.length) $("#board-footer-text").textContent = "Good things happen when we share the work.";
  else $("#board-footer-text").textContent = `${members.length} ${members.length === 1 ? "person" : "people"} making good things happen together.`;
}

function readableDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderCard(task) {
  const card = element("article", "task-card");
  card.draggable = true;
  card.tabIndex = 0;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `${task.title}, ${columns.find((column) => column.id === task.status)?.title || "To do"}`);
  card.addEventListener("click", () => openTask(task.id));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTask(task.id);
    }
  });
  card.addEventListener("dragstart", (event) => {
    card.classList.add("dragging");
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  const header = element("div", "task-card-top");
  const tag = element("span", `task-tag ${task.status}`, task.status === "inprogress" ? "IN PROGRESS" : task.status === "done" ? "COMPLETE" : "TASK");
  const more = element("button", "task-more", "···");
  more.type = "button";
  more.setAttribute("aria-label", "Edit task");
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openTask(task.id);
  });
  header.append(tag, more);

  const title = element("h3", "task-title", task.title);
  card.append(header, title);
  if (task.description) card.append(element("p", "task-description-preview", task.description));

  const footer = element("div", "task-card-footer");
  const meta = element("div", "task-card-meta");
  if (task.dueDate) {
    const dueDate = new Date(`${task.dueDate}T00:00:00`);
    const overdue = task.status !== "done" && dueDate < new Date(new Date().toDateString());
    const due = element("span", `task-meta${overdue ? " due-soon" : ""}`);
    due.append(element("span", "task-meta-icon", "◷"), document.createTextNode(readableDate(task.dueDate)));
    meta.append(due);
  }
  if (task.comments.length) {
    const comments = element("span", "task-meta");
    comments.append(element("span", "task-meta-icon", "☷"), document.createTextNode(String(task.comments.length)));
    meta.append(comments);
  }
  footer.append(meta);
  const assignee = task.assignee
    ? element("span", "avatar task-assignee", initials(task.assignee.name))
    : element("span", "unassigned-mark", "+");
  assignee.title = task.assignee ? `Assigned to ${task.assignee.name}` : "Unassigned";
  footer.append(assignee);
  card.append(footer);
  return card;
}

function filteredTasks() {
  return state.tasks.filter((task) => {
    if (task.projectId !== state.projectId) return false;
    if (state.filter === "mine" && task.assigneeId !== state.user.id) return false;
    if (state.filter === "unassigned" && task.assigneeId) return false;
    if (state.search) {
      const query = state.search.toLocaleLowerCase();
      return `${task.title} ${task.description} ${task.assignee?.name || ""}`.toLocaleLowerCase().includes(query);
    }
    return true;
  });
}

function renderBoard() {
  const project = activeProject();
  const board = $("#board");
  board.replaceChildren();
  if (!project) {
    const empty = element("div", "empty-board");
    empty.append(element("div", "empty-board-symbol", "✳"), element("h3", "", "Your next big thing starts here"), element("p", "", "Create a shared space for your team, then bring your plans to life one task at a time."));
    const create = element("button", "primary-button", "Create a project  →");
    create.type = "button";
    create.addEventListener("click", openProjectDialog);
    empty.append(create);
    board.append(empty);
    $("#project-title").textContent = "A little space to begin";
    $("#project-description").textContent = "Your work, your people, all moving forward.";
    $("#breadcrumb-project").textContent = "Get started";
    $("#project-eyebrow").lastChild.textContent = " YOUR WORKSPACE";
    $("#board-footer-text").textContent = "Your next big thing starts here.";
    $("#member-stack").replaceChildren();
    $("#footer-avatars").replaceChildren();
    $("#project-invite-button").disabled = true;
    $("#invite-button").disabled = true;
    return;
  }
  $("#project-title").textContent = project.name;
  $("#project-description").textContent = project.description || "A place for our next big thing.";
  $("#breadcrumb-project").textContent = project.name;
  $("#project-eyebrow").lastChild.textContent = " TEAM PROJECT";
  $("#project-invite-button").disabled = false;
  $("#invite-button").disabled = false;
  renderMembers();
  renderProjectList();
  const tasks = filteredTasks();
  if (!state.tasks.some((task) => task.projectId === project.id)) {
    const empty = element("div", "empty-board");
    empty.append(element("div", "empty-board-symbol", "✳"), element("h3", "", "Your board is a blank canvas"), element("p", "", "Add your first task and start turning this idea into something real."));
    const create = element("button", "primary-button", "Add your first task  →");
    create.type = "button";
    create.addEventListener("click", () => openTask());
    empty.append(create);
    board.append(empty);
    return;
  }
  if (!tasks.length) {
    board.append(element("div", "no-matches", "No tasks match. Try a different search or filter."));
    return;
  }
  for (const column of columns) {
    const section = element("section", `board-column ${column.className}`);
    const heading = element("div", "column-heading");
    heading.append(element("span", "column-indicator"), element("h2", "", column.title));
    const cards = tasks.filter((task) => task.status === column.id);
    heading.append(element("span", "column-count", String(cards.length)));
    const addButton = element("button", "icon-button column-add", "+");
    addButton.type = "button";
    addButton.setAttribute("aria-label", `Add a task to ${column.title}`);
    addButton.addEventListener("click", () => openTask(null, column.id));
    heading.append(addButton);
    const cardList = element("div", "column-cards");
    cardList.addEventListener("dragover", (event) => {
      event.preventDefault();
      cardList.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });
    cardList.addEventListener("dragleave", (event) => {
      if (!cardList.contains(event.relatedTarget)) cardList.classList.remove("drag-over");
    });
    cardList.addEventListener("drop", async (event) => {
      event.preventDefault();
      cardList.classList.remove("drag-over");
      const taskId = event.dataTransfer.getData("text/plain");
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task || task.status === column.id) return;
      try {
        const result = await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify({ status: column.id }) });
        replaceTask(result.task);
        renderBoard();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    if (!cards.length) cardList.append(element("div", "empty-column", "A little room for what's next."));
    else cards.forEach((task) => cardList.append(renderCard(task)));
    cardList.append(Object.assign(element("button", "add-task-inline", "+  Add a task"), {
      type: "button",
      onclick: () => openTask(null, column.id),
    }));
    section.append(heading, cardList);
    board.append(section);
  }
}

function renderNotifications() {
  const unread = state.notifications.some((notification) => !notification.read);
  $("#notification-dot").classList.toggle("hidden", !unread);
  const popover = $("#notification-popover");
  const heading = element("h3", "", "A little heads-up");
  const notifications = element("div", "notification-list");
  for (const notification of state.notifications.slice(0, 12)) {
    const item = element("button", "notification-item");
    item.type = "button";
    item.style.width = "100%";
    item.style.border = "0";
    item.style.background = notification.read ? "transparent" : "#f6f6ef";
    item.style.cursor = "pointer";
    item.style.textAlign = "left";
    item.append(element("span", "notification-icon", notification.taskId ? "✳" : "＋"));
    const content = element("span");
    content.append(element("p", "", notification.message), element("time", "", relativeTime(notification.createdAt)));
    item.append(content);
    item.addEventListener("click", async () => {
      const project = state.projects.find((entry) => entry.id === notification.projectId);
      if (project) {
        if (state.projectId !== project.id) await selectProject(project.id);
        if (notification.taskId) openTask(notification.taskId);
      }
      $("#notification-popover").classList.add("hidden");
    });
    notifications.append(item);
  }
  popover.replaceChildren(heading);
  if (!state.notifications.length) notifications.append(element("p", "notification-empty", "All caught up. Good things take time."));
  popover.append(notifications);
}

function openProjectDialog() {
  $("#project-error").textContent = "";
  const form = $("#project-form");
  form.reset();
  populateUsers($("#project-members"), state.users.filter((user) => user.id !== state.user.id));
  $("#project-dialog").showModal();
  form.elements.name.focus();
}

function openInviteDialog() {
  const project = activeProject();
  if (!project) return toast("Create a project first to invite teammates.");
  const members = new Set(project.memberIds);
  const available = state.users.filter((user) => !members.has(user.id));
  if (!available.length) return toast("Everyone with an account is already on this project.");
  populateUsers($("#invite-member"), available);
  $("#invite-error").textContent = "";
  $("#invite-dialog").showModal();
}

function renderComments(task) {
  const list = $("#comments-list");
  list.replaceChildren();
  const comments = task.comments || [];
  $("#comment-count").textContent = String(comments.length);
  if (!comments.length) {
    list.append(element("p", "comments-empty", "A good conversation starts somewhere.\nLeave the first note."));
    return;
  }
  for (const comment of comments) {
    const row = element("article", "comment-item");
    row.append(element("span", "avatar", initials(comment.author?.name || "Teammate")));
    const content = element("div", "comment-content");
    const meta = element("div", "comment-meta");
    meta.append(element("strong", "", comment.author?.name || "Teammate"));
    const time = element("time", "", relativeTime(comment.createdAt));
    time.dateTime = comment.createdAt;
    meta.append(time);
    content.append(meta, element("p", "", comment.text));
    row.append(content);
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}

function openTask(taskId = null, initialStatus = "todo") {
  const task = taskId ? state.tasks.find((item) => item.id === taskId) : null;
  if (taskId && !task) return;
  state.activeTaskId = task?.id || null;
  const form = $("#task-form");
  form.reset();
  $("#task-error").textContent = "";
  $("#task-dialog-title").textContent = task ? "A little more detail" : "Add a task";
  $("#task-save-label").textContent = task ? "Save changes" : "Add task";
  $("#delete-task-button").classList.toggle("hidden", !task);
  $("#comments-panel").classList.toggle("hidden", !task);
  populateUsers($("#task-assignee"), activeProject()?.members || [], true);
  if (task) {
    form.elements.title.value = task.title;
    form.elements.description.value = task.description;
    form.elements.status.value = task.status;
    form.elements.dueDate.value = task.dueDate || "";
    form.elements.assigneeId.value = task.assigneeId || "";
    renderComments(task);
  } else {
    form.elements.status.value = initialStatus;
    $("#comments-list").replaceChildren();
    $("#comment-count").textContent = "0";
  }
  $("#task-dialog").showModal();
  form.elements.title.focus();
}

function replaceTask(task) {
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index === -1) state.tasks.push(task);
  else state.tasks[index] = task;
}

async function selectProject(projectId) {
  if (!state.projects.some((project) => project.id === projectId)) return;
  state.projectId = projectId;
  state.search = "";
  $("#task-search").value = "";
  state.filter = "all";
  $("#filter-label").textContent = "Filter";
  renderProjectList();
  try {
    const { tasks } = await api(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
    if (state.projectId !== projectId) return;
    state.tasks = [...state.tasks.filter((task) => task.projectId !== projectId), ...tasks];
  } catch (error) {
    toast(error.message, "error");
  }
  renderBoard();
}

function attachSocket() {
  if (typeof io !== "function") return;
  state.socket = io();
  state.socket.on("connect", () => $("#live-indicator").classList.remove("offline"));
  state.socket.on("disconnect", () => $("#live-indicator").classList.add("offline"));
  state.socket.on("task:created", (task) => {
    replaceTask(task);
    renderBoard();
  });
  state.socket.on("task:updated", (task) => {
    replaceTask(task);
    renderBoard();
    if (state.activeTaskId === task.id) {
      const form = $("#task-form");
      form.elements.title.value = task.title;
      form.elements.description.value = task.description;
      form.elements.status.value = task.status;
      form.elements.dueDate.value = task.dueDate || "";
      form.elements.assigneeId.value = task.assigneeId || "";
      renderComments(task);
    }
  });
  state.socket.on("task:deleted", ({ taskId, projectId }) => {
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
    renderBoard();
    if (state.activeTaskId === taskId) $("#task-dialog").close();
    if (projectId === state.projectId) renderProjectList();
  });
  state.socket.on("comment:created", (comment) => {
    const task = state.tasks.find((item) => item.id === comment.taskId);
    if (!task) return;
    task.comments.push(comment);
    renderBoard();
    if (state.activeTaskId === task.id) renderComments(task);
  });
  state.socket.on("notification:new", (notification) => {
    state.notifications.unshift(notification);
    renderNotifications();
    toast(notification.message);
  });
  state.socket.on("project:updated", async ({ projectId }) => {
    try {
      const { projects } = await api("/api/projects");
      state.projects = projects;
      renderProjectList();
      if (projectId === state.projectId) renderMembers();
      renderBoard();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function loadWorkspace() {
  const [users, projects, notifications] = await Promise.all([
    api("/api/users"),
    api("/api/projects"),
    api("/api/notifications"),
  ]);
  state.users = users.users;
  state.projects = projects.projects;
  state.notifications = notifications.notifications;
  state.projectId = state.projects[0]?.id || null;
  showApp();
  renderProjectList();
  renderNotifications();
  if (state.projectId) await selectProject(state.projectId);
  else renderBoard();
  attachSocket();
}

document.querySelectorAll("[data-auth-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.authMode = button.dataset.authMode;
    document.querySelectorAll("[data-auth-mode]").forEach((tab) => tab.classList.toggle("active", tab === button));
    const registering = state.authMode === "register";
    $("#name-field").classList.toggle("hidden", !registering);
    $("#auth-heading").innerHTML = registering ? "Make good work<br><span>happen together.</span>" : "Good work<br><span>starts together.</span>";
    $("#auth-submit").firstChild.textContent = registering ? "Create your account" : "Welcome back ";
    $("#auth-form").elements.password.autocomplete = registering ? "new-password" : "current-password";
    $("#auth-form").elements.name.required = registering;
    $("#auth-error").textContent = "";
  });
});

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  $("#auth-error").textContent = "";
  const submit = $("#auth-submit");
  submit.disabled = true;
  try {
    const { user } = await api(`/api/auth/${state.authMode === "register" ? "register" : "login"}`, { method: "POST", body: JSON.stringify(body) });
    state.user = user;
    await loadWorkspace();
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  body.memberIds = Array.from(form.elements.memberIds.selectedOptions, (option) => option.value);
  $("#project-error").textContent = "";
  try {
    const { project } = await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
    state.projects.unshift(project);
    $("#project-dialog").close();
    await selectProject(project.id);
    toast("A fresh start. Your project is ready.");
  } catch (error) {
    $("#project-error").textContent = error.message;
  }
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  body.assigneeId = body.assigneeId || null;
  $("#task-error").textContent = "";
  try {
    if (state.activeTaskId) {
      const { task } = await api(`/api/tasks/${encodeURIComponent(state.activeTaskId)}`, { method: "PATCH", body: JSON.stringify(body) });
      replaceTask(task);
    } else {
      const { task } = await api(`/api/projects/${encodeURIComponent(state.projectId)}/tasks`, { method: "POST", body: JSON.stringify(body) });
      replaceTask(task);
    }
    $("#task-dialog").close();
    state.activeTaskId = null;
    renderBoard();
    renderProjectList();
  } catch (error) {
    $("#task-error").textContent = error.message;
  }
});

$("#delete-task-button").addEventListener("click", async () => {
  if (!state.activeTaskId) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(state.activeTaskId)}`, { method: "DELETE" });
    state.tasks = state.tasks.filter((task) => task.id !== state.activeTaskId);
    state.activeTaskId = null;
    $("#task-dialog").close();
    renderBoard();
    renderProjectList();
    toast("Task removed.");
  } catch (error) {
    $("#task-error").textContent = error.message;
  }
});

$("#comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = activeTask();
  const form = event.currentTarget;
  const text = form.elements.text.value.trim();
  if (!task || !text) return;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const { comment } = await api(`/api/tasks/${encodeURIComponent(task.id)}/comments`, { method: "POST", body: JSON.stringify({ text }) });
    task.comments.push(comment);
    form.reset();
    renderComments(task);
    renderBoard();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const project = activeProject();
  if (!project) return;
  $("#invite-error").textContent = "";
  try {
    const { project: updated } = await api(`/api/projects/${encodeURIComponent(project.id)}/members`, { method: "POST", body: JSON.stringify({ userId: form.elements.memberId.value }) });
    state.projects = state.projects.map((item) => item.id === updated.id ? updated : item);
    $("#invite-dialog").close();
    renderMembers();
    renderProjectList();
    renderBoard();
    toast("Your teammate is in. Good things ahead.");
  } catch (error) {
    $("#invite-error").textContent = error.message;
  }
});

$("#create-project-shortcut").addEventListener("click", openProjectDialog);
$("#create-project-top").addEventListener("click", openProjectDialog);
$("#project-invite-button").addEventListener("click", openInviteDialog);
$("#invite-button").addEventListener("click", openInviteDialog);
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close());
});

$("#task-search").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderBoard();
});

$("#filter-button").addEventListener("click", () => {
  const options = ["all", "mine", "unassigned"];
  state.filter = options[(options.indexOf(state.filter) + 1) % options.length];
  $("#filter-label").textContent = { all: "Filter", mine: "Assigned to me", unassigned: "Unassigned" }[state.filter];
  renderBoard();
});

$("#notification-button").addEventListener("click", async () => {
  const popover = $("#notification-popover");
  const opening = popover.classList.contains("hidden");
  popover.classList.toggle("hidden", !opening);
  if (!opening || !state.notifications.some((notification) => !notification.read)) return;
  try {
    await api("/api/notifications/read", { method: "PATCH" });
    state.notifications = state.notifications.map((notification) => ({ ...notification, read: true }));
    renderNotifications();
    popover.classList.remove("hidden");
  } catch (error) {
    toast(error.message, "error");
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#notification-button") && !event.target.closest("#notification-popover")) $("#notification-popover").classList.add("hidden");
});

$("#profile-button").addEventListener("click", async () => {
  if (!window.confirm("Sign out of Orbit?")) return;
  try {
    await api("/api/auth/logout", { method: "POST" });
    if (state.socket) state.socket.disconnect();
    state.user = null;
    state.projects = [];
    state.tasks = [];
    state.notifications = [];
    state.projectId = null;
    $("#auth-form").reset();
    showAuth();
    document.querySelector('[data-auth-mode="login"]').click();
  } catch (error) {
    toast(error.message, "error");
  }
});

$("#mobile-profile-button").addEventListener("click", () => $("#profile-button").click());
$("#task-dialog").addEventListener("close", () => {
  state.activeTaskId = null;
});

(async function init() {
  try {
    const { user } = await api("/api/auth/me");
    state.user = user;
    await loadWorkspace();
  } catch (error) {
    if (error.message !== "Please sign in to continue.") toast(error.message, "error");
    showAuth();
  }
})();
