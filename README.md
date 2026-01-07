# node-sonos

TypeScript Sonos controller that talks directly to the local WebSocket API on a Sonos player.

## Install

```bash
npm install @lox-audioserver/node-sonos
```

Node.js 18+ is required.

## Usage

```ts
import { SonosClient, EventType } from '@lox-audioserver/sonos';

async function main() {
const client = new SonosClient('192.168.1.50'); // IP of any Sonos player
await client.connect();

  // Listen for group/player updates
  client.subscribe((evt) => console.log(evt.eventType, evt.objectId));

  // Start websocket + initial sync (blocks until socket closes)
  await client.start();

  // Access player + groups
  const player = client.player;
  const [group] = client.groups;
  await group.play();
}

void main();
```

### Opties

`SonosClient` accepteert optionele betrouwbaarheidsettings:

- `heartbeatIntervalMs` (default 30000)
- `retryDelayMs` (default 2000) + `retryJitterMs` (default 500)
- `maxReconnects` (default onbeperkt)

## Features

- Local Sonos WebSocket client (token-based TLS)
- Group + player state sync with event callbacks
- Playback controls: play/pause/seek/skip, play modes, line-in, cloud queue/stream
- Group management: create/modify membership
- Volume controls for player + group, duck/unduck
- Audio clips + home theater helper

## Notes

- The local API uses a self-signed TLS certificate; the client disables certificate validation for this connection, matching the official behavior.
- Only one player connection is handled per client instance (per Sonos requirements). Create multiple clients for multiple players.
