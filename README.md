# Meet Strangers

Anonymous, signup-free random voice and video chat with strangers — in the spirit of Omegle,
built with a security-first, privacy-first design.

> **Status:** project scaffold. The application itself is developed on a feature branch and
> merged into `main` through a pull request.

## Planned architecture

| Layer     | Technology                         | Responsibility                                        |
| --------- | ---------------------------------- | ----------------------------------------------------- |
| Client    | React + TypeScript + Vite          | UI, camera/mic access, WebRTC peer connection         |
| Signaling | Node.js + `ws` WebSocket server    | Anonymous sessions, matchmaking, SDP/ICE relay        |
| Media     | WebRTC (peer-to-peer, STUN / TURN) | Audio/video flows directly between the two browsers   |
| Shared    | TypeScript + Zod                   | One validated wire protocol used by client and server |

Audio and video never pass through the application server: the server only introduces two
peers to each other and relays the connection handshake.

## Repository layout

```
packages/
  shared/   # wire protocol (types + runtime validation)
  server/   # signaling + matchmaking server
  client/   # web application
```

## Development prerequisites

- Node.js `>= 22.12` (see `.nvmrc`)
- npm `>= 10`

```bash
npm install
npm run lint
npm run format:check
```
