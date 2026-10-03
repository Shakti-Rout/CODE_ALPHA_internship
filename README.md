# Orbit Projects

A small, full-stack team project board with accounts, task assignments, task conversations, notifications, and live updates.

## Run locally

Requires Node.js 18 or newer.

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000), create an account, and create a project. Create a second account in another browser or private window to try project invitations and live collaboration.

Set `PORT` to change the listening port. Set `SESSION_SECRET` to a long, random value when deploying; otherwise the app creates and stores a local session secret. Set `NODE_ENV=production` when serving the app over HTTPS so session cookies are marked secure.

App data and the generated development session secret are stored in `data/`. This JSON-backed store is intended for local use and small demonstrations; use a managed database and shared session secret for multi-instance production deployments.

## Included

- Password-based registration and sign-in, with scrypt password hashes and signed, HTTP-only session cookies.
- Shared project boards with project member invitations, assignees, due dates, search, filters, and drag-and-drop status changes.
- Task comments, persisted notifications, and Socket.IO updates for shared task and project activity.
- Responsive desktop and mobile layouts.
