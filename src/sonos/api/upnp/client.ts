// Sonos S1 client, speaking UPnP/SOAP directly.
//
// Exposes the same `subscribe/connect/start/disconnect/player/groups` surface as
// the S2 SonosClient, so a consumer can switch backends on a single dispatcher
// decision. S1 firmware has no WebSocket API: state arrives through GENA events
// (see ./events) and commands go out as SOAP (see ./transport), with the household
// topology read from ZoneGroupTopology.

import { EventType } from '../../constants';
import { CannotConnect } from '../../errors';
import type { SonosEvent } from '../../types';
import { loadDeviceDescription, type SonosDeviceDescription } from './description';
import { parseClockToSec, parseTrackMetadata } from './didl';
import { S1EventBridge } from './events';
import { S1SonosGroup, type S1GroupSeed } from './group';
import { UpnpTransportState, type UpnpTrack, type ZoneGroup } from './models';
import { S1SonosPlayer } from './player';
import { SONOS_UPNP_PORT } from './soap';
import { getZoneGroups } from './topology';
import {
  getMediaInfo,
  getMute,
  getPositionInfo,
  getTransportState,
  getVolume,
  sendTransportCommand,
  type TransportCommand,
} from './transport';

type Subscriber = {
  cb: (event: SonosEvent) => void;
  eventFilter?: Set<EventType>;
  objectIdFilter?: Set<string>;
};

export interface S1ClientOptions {
  logger?: Console;
  /** Override the UPnP port (defaults to 1400). */
  port?: number;
  /**
   * How often to poll RelativeTimePosition while playing. AVTransport doesn't push
   * position, so we poll for it. Set to 0 to disable.
   */
  positionPollIntervalMs?: number;
  /**
   * Safety net behind the ZoneGroupTopology events, in case a NOTIFY is missed.
   * Set to 0 to rely on events alone.
   */
  topologyPollIntervalMs?: number;
}

export class S1Client {
  public player: S1SonosPlayer | null = null;
  public playerId = '';
  public householdId = '';

  private readonly playerIp: string;
  private readonly port: number;
  private readonly logger: Console;
  private readonly positionPollIntervalMs: number;
  private readonly topologyPollIntervalMs: number;

  private description: SonosDeviceDescription | null = null;
  private events: S1EventBridge | null = null;
  private groupMap = new Map<string, S1SonosGroup>();
  private zoneGroups: ZoneGroup[] = [];
  private subscribers: Subscriber[] = [];
  private positionPollTimer: NodeJS.Timeout | null = null;
  private topologyPollTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;

  // Speaker state, kept current by the GENA events and primed on connect.
  private transportState: UpnpTransportState | undefined;
  private volumeLevel: number | undefined;
  private mutedState: boolean | undefined;

  constructor(playerIp: string, options: S1ClientOptions = {}) {
    this.playerIp = playerIp;
    this.port = options.port ?? SONOS_UPNP_PORT;
    this.logger = options.logger ?? console;
    this.positionPollIntervalMs = options.positionPollIntervalMs ?? 5_000;
    this.topologyPollIntervalMs = options.topologyPollIntervalMs ?? 30_000;
  }

  // -------- public surface (mirrors SonosClient) --------

  get groups(): S1SonosGroup[] {
    return Array.from(this.groupMap.values());
  }

  subscribe(
    cb: (event: SonosEvent) => void,
    eventFilter?: EventType | EventType[] | null,
    objectIdFilter?: string | string[] | null,
  ): () => void {
    const eventSet =
      eventFilter == null
        ? undefined
        : Array.isArray(eventFilter)
          ? new Set(eventFilter)
          : new Set([eventFilter]);
    const objectSet =
      objectIdFilter == null
        ? undefined
        : Array.isArray(objectIdFilter)
          ? new Set(objectIdFilter)
          : new Set([objectIdFilter]);
    const sub: Subscriber = { cb, eventFilter: eventSet, objectIdFilter: objectSet };
    this.subscribers.push(sub);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== sub);
    };
  }

  signalEvent(event: SonosEvent): void {
    for (const sub of this.subscribers) {
      if (sub.eventFilter && !sub.eventFilter.has(event.eventType)) continue;
      if (sub.objectIdFilter && event.objectId && !sub.objectIdFilter.has(event.objectId)) {
        continue;
      }
      try {
        sub.cb(event);
      } catch (err) {
        this.logger.warn?.('S1 subscriber threw', err);
      }
    }
  }

  async connect(): Promise<void> {
    this.stopRequested = false;

    const description = await loadDeviceDescription(this.playerIp, { port: this.port });
    this.description = description;
    this.playerId = description.uuid;
    // S1 has no household id of its own; consumers only compare these for equality,
    // so the player's own uuid is a stable enough stand-in.
    this.householdId = description.uuid;

    this.player = new S1SonosPlayer(this, {
      id: description.uuid,
      name: description.name,
      host: description.host,
    });

    await this.refreshTopology();
    await this.primeState();
    await this.startEvents();

    this.signalEvent({ eventType: EventType.CONNECTED, objectId: this.playerId });
    this.startPositionPolling();
    this.startTopologyPolling();
  }

  /** Kept for parity with the S2 client, where it bootstraps the event listener. */
  async start(): Promise<void> {
    /* no-op: connect() already subscribed */
  }

  async disconnect(): Promise<void> {
    this.stopRequested = true;
    if (this.positionPollTimer) {
      clearInterval(this.positionPollTimer);
      this.positionPollTimer = null;
    }
    if (this.topologyPollTimer) {
      clearInterval(this.topologyPollTimer);
      this.topologyPollTimer = null;
    }
    this.events?.dispose();
    this.events = null;
    this.signalEvent({ eventType: EventType.DISCONNECTED, objectId: this.playerId });
  }

  // -------- state the group adapter reads --------

  get currentTransportState(): UpnpTransportState | undefined {
    return this.transportState;
  }

  get currentVolume(): number | undefined {
    return this.volumeLevel;
  }

  get currentMuted(): boolean | undefined {
    return this.mutedState;
  }

  /**
   * Run a transport command against a group's coordinator. Only the coordinator
   * accepts them; sending to a joined member is silently ignored by the speaker.
   */
  async runTransportCommand(groupId: string, command: TransportCommand): Promise<void> {
    const { host, port } = this.coordinatorEndpointFor(groupId);
    await sendTransportCommand(host, command, { port });
  }

  /**
   * Where to send a group's commands. The topology carries each member's own
   * address, which is what to trust — a household is normally all on 1400, but
   * nothing about the protocol says it has to be.
   */
  private coordinatorEndpointFor(groupId: string): { host: string; port: number } {
    const coordinator = this.zoneGroups.find((g) => g.groupId === groupId)?.coordinator;
    if (!coordinator?.host) {
      return { host: this.playerIp, port: this.port };
    }
    return { host: coordinator.host, port: coordinator.port || this.port };
  }

  // -------- topology --------

  private async refreshTopology(): Promise<void> {
    let zones: ZoneGroup[];
    try {
      zones = await getZoneGroups(this.playerIp, { port: this.port });
    } catch (err) {
      throw new CannotConnect(
        `Sonos S1 GetZoneGroupState failed (${(err as Error).message})`,
        err instanceof Error ? err : undefined,
      );
    }
    this.applyTopology(zones);
  }

  private applyTopology(zones: ZoneGroup[]): void {
    this.zoneGroups = zones;
    const seenIds = new Set<string>();
    for (const zone of zones) {
      const seed: S1GroupSeed = {
        id: zone.groupId,
        coordinatorId: zone.coordinator?.uuid ?? zone.groupId,
        name: zone.name,
        playerIds: zone.members.map((m) => m.uuid),
      };
      seenIds.add(seed.id);
      const existing = this.groupMap.get(seed.id);
      if (existing) {
        if (existing.updateSeed(seed)) {
          this.signalEvent({
            eventType: EventType.GROUP_UPDATED,
            objectId: existing.id,
            data: existing,
          });
        }
      } else {
        const group = new S1SonosGroup(this, seed);
        this.groupMap.set(group.id, group);
        this.signalEvent({
          eventType: EventType.GROUP_ADDED,
          objectId: group.id,
          data: group,
        });
      }
    }
    for (const id of Array.from(this.groupMap.keys())) {
      if (!seenIds.has(id)) {
        const removed = this.groupMap.get(id);
        this.groupMap.delete(id);
        if (removed) {
          this.signalEvent({
            eventType: EventType.GROUP_REMOVED,
            objectId: id,
            data: removed,
          });
        }
      }
    }

    this.resolveActiveGroup();
  }

  private resolveActiveGroup(): void {
    if (!this.player) return;
    const found =
      this.groups.find(
        (g) => g.coordinatorId === this.player!.id || g.playerIds.includes(this.player!.id),
      ) ?? null;
    this.player.setActiveGroup(found);
  }

  private startTopologyPolling(): void {
    if (this.topologyPollTimer || this.topologyPollIntervalMs <= 0) return;
    // ZoneGroupTopology events already report reshuffles; this only covers a NOTIFY
    // that never arrived. Cheap — one SOAP call.
    this.topologyPollTimer = setInterval(() => {
      if (this.stopRequested) return;
      void this.refreshTopology().catch(() => undefined);
    }, this.topologyPollIntervalMs);
    this.topologyPollTimer.unref?.();
  }

  // -------- initial state + event wiring --------

  /**
   * Events only report *changes*, so a speaker that has been sitting still since
   * before we subscribed would tell us nothing. Read the current state once.
   */
  private async primeState(): Promise<void> {
    const group = this.player?.group ?? null;
    const { host, port } = group
      ? this.coordinatorEndpointFor(group.id)
      : { host: this.playerIp, port: this.port };

    const [state, position, media, volume, muted] = await Promise.all([
      getTransportState(host, { port }).catch(() => undefined),
      getPositionInfo(host, { port }).catch(() => undefined),
      getMediaInfo(host, { port }).catch(() => undefined),
      getVolume(this.playerIp, { port: this.port }).catch(() => undefined),
      getMute(this.playerIp, { port: this.port }).catch(() => undefined),
    ]);

    this.transportState = toTransportState(state);
    this.volumeLevel = volume;
    this.mutedState = muted;

    if (!group) {
      return;
    }
    if (position) {
      group.applyCurrentTrackUri(position.trackUri ?? '');
      group.applyCurrentTrack(this.parseTrack(position.trackMetadata, host));
      group.setPosition(parseClockToSec(position.relTime));
    }
    if (media) {
      group.applyEnqueuedTrackUri(media.currentUri ?? '');
      group.applyEnqueuedTrack(this.parseTrack(media.currentUriMetadata, host));
    }
    group.emitUpdated();
  }

  private async startEvents(): Promise<void> {
    const bridge = new S1EventBridge(
      this.playerIp,
      {
        onTransport: (event) => {
          if (event.transportState !== undefined) {
            this.transportState = toTransportState(event.transportState);
          }
          const group = this.player?.group ?? null;
          if (!group) return;
          if (event.currentTrackUri !== undefined) {
            group.applyCurrentTrackUri(event.currentTrackUri);
          }
          if (event.currentTrackMetadata !== undefined) {
            group.applyCurrentTrack(this.parseTrack(event.currentTrackMetadata, this.playerIp));
          }
          if (event.enqueuedTransportUri !== undefined) {
            group.applyEnqueuedTrackUri(event.enqueuedTransportUri);
          }
          if (event.enqueuedTransportMetadata !== undefined) {
            group.applyEnqueuedTrack(this.parseTrack(event.enqueuedTransportMetadata, this.playerIp));
          }
          group.emitUpdated();
        },
        onRendering: (event) => {
          if (event.volume !== undefined) this.volumeLevel = event.volume;
          if (event.muted !== undefined) this.mutedState = event.muted;
          this.player?.group?.emitUpdated();
        },
        onTopology: (groups) => {
          if (this.stopRequested) return;
          this.applyTopology(groups);
        },
      },
      { port: this.port, logger: this.logger },
    );
    this.events = bridge;
    try {
      await bridge.start();
    } catch (err) {
      // Without events we still have the polls and the primed state, so this is a
      // degraded connection rather than a failed one.
      this.logger.warn?.('S1 event subscription failed; falling back to polling', {
        host: this.playerIp,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private parseTrack(metadata: string | undefined, host: string): UpnpTrack | null {
    return parseTrackMetadata(metadata, { host, port: this.port });
  }

  // -------- position polling --------

  private startPositionPolling(): void {
    if (this.positionPollTimer || this.positionPollIntervalMs <= 0) return;
    this.positionPollTimer = setInterval(() => {
      if (this.stopRequested) return;
      void this.refreshPosition();
    }, this.positionPollIntervalMs);
    this.positionPollTimer.unref?.();
  }

  private async refreshPosition(): Promise<void> {
    const group = this.player?.group ?? null;
    if (!group) return;
    if (this.transportState !== UpnpTransportState.Playing) return;
    try {
      const { host, port } = this.coordinatorEndpointFor(group.id);
      const position = await getPositionInfo(host, { port });
      const seconds = parseClockToSec(position.relTime);
      if (seconds !== null) {
        group.setPosition(seconds);
        group.emitUpdated();
      }
    } catch {
      // best-effort
    }
  }
}

function toTransportState(value: string | undefined): UpnpTransportState | undefined {
  if (!value) return undefined;
  const known = Object.values(UpnpTransportState) as string[];
  return known.includes(value) ? (value as UpnpTransportState) : undefined;
}
