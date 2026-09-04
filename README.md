# node-sonos

TypeScript Sonos controller for both S2 (modern) and S1 (legacy) firmware. Talks the local WebSocket API on S2 speakers, and UPnP/SOAP for S1 speakers.

## Install

```bash
npm install @lox-audioserver/node-sonos
```

Node.js 18+ is required.

## Usage

### S2 (modern firmware)

```ts
import { SonosClient, EventType } from '@lox-audioserver/node-sonos';

const client = new SonosClient('192.168.1.50'); // IP of any Sonos player
await client.connect();

client.subscribe((evt) => console.log(evt.eventType, evt.objectId));

// Starts the websocket + initial sync (blocks until the socket closes)
await client.start();

const player = client.player;
const [group] = client.groups;
await group.play();
```

### S1 (legacy firmware)

S1 speakers don't expose the modern local WebSocket API, so use `S1Client` instead. The surface is the same — same `subscribe/connect/start/disconnect/player/groups` — so consumer code only needs to pick the right constructor.

```ts
import { S1Client } from '@lox-audioserver/node-sonos';

const client = new S1Client('192.168.1.50');
await client.connect();
client.subscribe((evt) => console.log(evt.eventType, evt.objectId));
await client.start(); // no-op on S1; events fire immediately after connect
```

### Auto-detect (recommended)

`detectGeneration(host)` probes both endpoints and tells you which client to instantiate. Returns `'S2' | 'S1' | 'unknown'`.

```ts
import { SonosClient, S1Client, detectGeneration } from '@lox-audioserver/node-sonos';

const gen = await detectGeneration('192.168.1.50');
const client = gen === 'S1' ? new S1Client('192.168.1.50') : new SonosClient('192.168.1.50');
await client.connect();
```

### S2 options

`SonosClient` accepts optional reliability settings:

- `heartbeatIntervalMs` (default 30000)
- `retryDelayMs` (default 2000) + `retryJitterMs` (default 500)
- `maxReconnects` (default unlimited)

### S1 options

`S1Client` accepts:

- `port` (default 1400)
- `positionPollIntervalMs` (default 5000; AVTransport doesn't push position, so we poll while playing — set to 0 to disable)

## Features

### Shared (both generations)

- Group + player state with event callbacks (`GROUP_ADDED/UPDATED/REMOVED`, `PLAYER_ADDED/UPDATED/REMOVED`, `CONNECTED/DISCONNECTED`)
- Transport controls: `play`, `pause`, `stop`, `togglePlayPause`, `skipToNextTrack`, `skipToPreviousTrack`
- `playbackMetadataStatus` with track / artist / album / duration / cover art / current container
- Volume + mute state

### S2 only

- Cloud queue + stream loading via `playbackSession`
- Group membership management (`createGroup`, `modifyGroupMembers`, `setGroupMembers`)
- Per-player volume + ducking
- Audio clip playback
- Home theater helper

S2-only operations on `S1Client` throw at the call site so consumers can fall back to direct SOAP if needed.

### Testing the S1 backend

There is no S1 hardware in the loop here, so `scripts/s1-probe.mjs` drives `S1Client` against a
fake speaker (`scripts/fake-s1-speaker.mjs`) that reproduces the wire format: device description,
SOAP control, and GENA NOTIFYs carrying the double-escaped DIDL that real firmware sends.

```sh
npm run build && npm run probe:s1
```

## Notes

- S2 uses a self-signed TLS certificate on port 1443; the client disables certificate validation for this connection, matching the official behavior.
- S1 uses plain HTTP/SOAP on port 1400 with UPnP eventing, built on [`@sonn-audio/node-upnp`](https://www.npmjs.com/package/@sonn-audio/node-upnp) for the SOAP envelopes, DIDL parsing and GENA subscriptions.
- Only one player connection per client instance (matches the per-player Sonos requirements). Create multiple clients for multiple players.
- For S1, topology changes (group reshuffles) arrive as ZoneGroupTopology events, with a 30 s poll behind them in case a NOTIFY is missed.
