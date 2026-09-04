// GENA eventing for S1 speakers.
//
// A Sonos speaker pushes its state to whoever subscribes: transport and track
// metadata on AVTransport, volume/mute on RenderingControl, and group reshuffles
// on ZoneGroupTopology. The subscription machinery — callback server, renewals,
// re-subscribe on failure — comes from @sonn-audio/node-upnp; this module adds the
// Sonos payload reading, which needs more state variables than node-upnp's typed
// DLNA events carry (notably the vendor-namespaced `r:EnqueuedTransportURI*`).

import net from 'node:net';
import { DlnaEventSubscriber, extractTag, unescapeXml } from '@sonn-audio/node-upnp';

import type { ZoneGroup } from './models';
import { serviceEventUrl, SONOS_UPNP_PORT } from './soap';
import { parseZoneGroups } from './topology';

const TOPOLOGY_KIND = 'zonegrouptopology';

export interface S1TransportEvent {
  transportState?: string;
  currentTrackUri?: string;
  /** Raw DIDL-Lite; parse with parseTrackMetadata. */
  currentTrackMetadata?: string;
  enqueuedTransportUri?: string;
  enqueuedTransportMetadata?: string;
}

export interface S1RenderingEvent {
  volume?: number;
  muted?: boolean;
}

export interface S1EventHandlers {
  onTransport?: (event: S1TransportEvent) => void;
  onRendering?: (event: S1RenderingEvent) => void;
  onTopology?: (groups: ZoneGroup[]) => void;
}

export interface S1EventBridgeOptions {
  port?: number;
  logger?: Console;
}

export class S1EventBridge {
  private subscriber: DlnaEventSubscriber | null = null;
  private disposed = false;

  constructor(
    private readonly host: string,
    private readonly handlers: S1EventHandlers,
    private readonly options: S1EventBridgeOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.disposed || this.subscriber) {
      return;
    }
    const port = this.options.port ?? SONOS_UPNP_PORT;
    // The speaker POSTs its NOTIFYs back to us, so it needs an address of ours that
    // it can actually reach. Asking the routing table which local address a socket to
    // *this speaker* uses beats guessing at an interface.
    const localHost = await resolveLocalAddress(this.host, port);
    if (!localHost) {
      throw new Error(`could not determine a local address reachable from ${this.host}`);
    }
    if (this.disposed) {
      return;
    }

    const subscriber = new DlnaEventSubscriber(`sonos-s1:${this.host}`, localHost, {
      onRaw: (event) => this.handleRaw(event.kind, event.body, event.lastChange),
    });
    this.subscriber = subscriber;
    await subscriber.start({
      avTransportEventUrl: serviceEventUrl(this.host, 'AVTransport', port),
      renderingControlEventUrl: serviceEventUrl(this.host, 'RenderingControl', port),
      extraServices: [
        { kind: TOPOLOGY_KIND, eventUrl: serviceEventUrl(this.host, 'ZoneGroupTopology', port) },
      ],
    });
  }

  dispose(): void {
    this.disposed = true;
    this.subscriber?.dispose();
    this.subscriber = null;
  }

  private handleRaw(kind: string | undefined, body: string, lastChange: string | undefined): void {
    // ZoneGroupTopology puts its state straight in the property set, with no
    // LastChange document at all.
    if (kind === TOPOLOGY_KIND || (!lastChange && /ZoneGroupState/i.test(body))) {
      const state = extractTag(body, 'ZoneGroupState');
      if (state) {
        const groups = parseZoneGroups(state);
        if (groups.length > 0) {
          this.handlers.onTopology?.(groups);
        }
      }
      return;
    }
    if (!lastChange) {
      return;
    }
    if (kind === 'renderingcontrol') {
      const event = parseRendering(lastChange);
      if (event) {
        this.handlers.onRendering?.(event);
      }
      return;
    }
    const event = parseTransport(lastChange);
    if (event) {
      this.handlers.onTransport?.(event);
    }
  }
}

function parseTransport(lastChange: string): S1TransportEvent | null {
  const event: S1TransportEvent = {
    transportState: attrVal(lastChange, 'TransportState'),
    currentTrackUri: attrVal(lastChange, 'CurrentTrackURI'),
    currentTrackMetadata: attrVal(lastChange, 'CurrentTrackMetaData'),
    // Sonos reports what was *put on* the transport (the station, the playlist) in
    // its own namespace, distinct from the track currently playing out of it.
    enqueuedTransportUri:
      attrVal(lastChange, 'r:EnqueuedTransportURI') ?? attrVal(lastChange, 'AVTransportURI'),
    enqueuedTransportMetadata:
      attrVal(lastChange, 'r:EnqueuedTransportURIMetaData') ??
      attrVal(lastChange, 'AVTransportURIMetaData'),
  };
  return Object.values(event).some((v) => v !== undefined) ? event : null;
}

function parseRendering(lastChange: string): S1RenderingEvent | null {
  const event: S1RenderingEvent = {};
  const volume = channelAttrVal(lastChange, 'Volume');
  if (volume !== undefined) {
    const n = Number(volume);
    if (Number.isFinite(n)) {
      event.volume = Math.min(100, Math.max(0, Math.round(n)));
    }
  }
  const mute = channelAttrVal(lastChange, 'Mute');
  if (mute !== undefined) {
    event.muted = mute === '1' || mute.toLowerCase() === 'true';
  }
  return event.volume !== undefined || event.muted !== undefined ? event : null;
}

/**
 * LastChange entries are `<Tag val="…"/>`. The value is XML-escaped, which is how a
 * whole DIDL document fits inside an attribute.
 */
function attrVal(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${escapeTag(tag)}\\b[^>]*\\bval="([^"]*)"`, 'i');
  const raw = re.exec(xml)?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const value = unescapeXml(raw);
  return value === '' ? undefined : value;
}

/** RenderingControl reports per channel; the Master channel is the one that matters. */
function channelAttrVal(xml: string, tag: string): string | undefined {
  const master = new RegExp(
    `<${tag}\\b[^>]*channel="Master"[^>]*\\bval="([^"]*)"|<${tag}\\b[^>]*\\bval="([^"]*)"[^>]*channel="Master"`,
    'i',
  ).exec(xml);
  if (master) {
    return master[1] ?? master[2];
  }
  return new RegExp(`<${tag}\\b[^>]*\\bval="([^"]*)"`, 'i').exec(xml)?.[1];
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Which of our addresses can this speaker reach us on? Ask the routing table. */
export function resolveLocalAddress(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value: string | null): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(3_000);
    socket.once('connect', () => done(socket.localAddress ?? null));
    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));
  });
}
