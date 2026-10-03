# Gather

Gather is a browser-based meeting room for video calls, screen sharing, encrypted chat and file sharing, and a collaborative whiteboard.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open [http://localhost:3100](http://localhost:3100), create an account, then start a room. To invite someone, share the full invite link; its encryption key is in the URL fragment and is never sent to the server. Room codes by themselves are not enough to decrypt room content. Set the `PORT` environment variable to use another port.

Camera and microphone permissions work on `localhost` and on HTTPS sites. For multi-person calls to work across restrictive networks, add your TURN service to the `iceServers` list in [public/app.js](./public/app.js); this starter uses a public STUN server.

## Security and deployment

- Chat messages, file contents, and whiteboard strokes use AES-GCM in the browser. The room key is a random 256-bit secret carried in the invite link fragment.
- WebRTC encrypts audio, video, and screen-share media using DTLS-SRTP. Signaling and encrypted collaboration payloads use Socket.IO.
- Passwords are hashed with Node's scrypt. Authentication uses a signed, HTTP-only, SameSite cookie; account records are stored in `data/users.json`.
- Serve the app behind HTTPS in production and set `NODE_ENV=production` and a persistent, randomly generated `SESSION_SECRET`. The secure session cookie is enabled in production mode. Back up and restrict access to the data directory.
- The server relays signaling and opaque encrypted room content; it does not persist messages, files, or whiteboard data. Meeting membership and whiteboard history are kept in memory and disappear when the room empties or the server restarts.
- Invite links grant access to their room and encryption key. Share them only with the intended participants.

This is a small self-hostable starter, not a substitute for an operational security review, managed identity provider, durable database, or production TURN deployment.
