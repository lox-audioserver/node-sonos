// Sonos S1 client built on top of @svrooij/sonos.
//
// Exposes the same `subscribe/connect/start/disconnect/player/groups` surface
// the existing S2 SonosClient does, so the state controller in lox-audioserver
// can switch backends with a single dispatcher decision. The heavy lifting —
// SOAP, UPnP eventing, topology parsing — is delegated to @svrooij/sonos. We
// translate its strongly-typed events into our SonosEvent enum and keep the
// MetadataStatus / PlayBackState shapes that consumers already rely on.

import SonosDevice from '@svrooij/sonos/lib/sonos-device';
import { SonosEvents } from '@svrooij/sonos/lib/models';
import type { Track } from '@svrooij/sonos/lib/models/track';
import type { ZoneGroup } from '@svrooij/sonos/lib/models/zone-group';

import { EventType } from '../../constants';
import { CannotConnect } from '../../errors';
import type { SonosEvent } from '../../types';
import { S1SonosGroup, type S1GroupSeed } from './group';
import { S1SonosPlayer, type S1PlayerSeed } from './player';

type Subscriber = {
  cb: (event: SonosEvent) => void;
  eventFilter?: Set<EventType>;
  objectIdFilter?: Set<string>;
};

export interface S1ClientOptions {
  logger?: Console;
  // Override the SDK port (defaults to 1400).
  port?: number;
  // How often to poll RelativeTimePosition while playing. AVTransport doesn't
  // push position; we poll for it. Set to 0 to disable.
  positionPollIntervalMs?: number;
}

export class S1Client {
  public player: S1SonosPlayer | null = null;
  public playerId = '';
  public householdId = '';

  private readonly playerIp: string;
  private readonly port: number;
  private readonly logger: Console;
  private readonly positionPollIntervalMs: number;

  private device: SonosDevice | null = null;
  private groupMap = new Map<string, S1SonosGroup>();
  private subscribers: Subscriber[] = [];
  private positionPollTimer: NodeJS.Timeout | null = null;
  private topologyPollTimer: NodeJS.Timeout | null = null;
  private detachEventListeners: Array<() => void> = [];
  private stopRequested = false;

  constructor(playerIp: string, options: S1ClientOptions = {}) {
    this.playerIp = playerIp;
    this.port = options.port ?? 1400;
    this.logger = options.logger ?? console;
    this.positionPollIntervalMs = options.positionPollIntervalMs ?? 5_000;
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
    const device = new SonosDevice(this.playerIp, this.port);
    this.device = device;

    try {
      await device.LoadDeviceData();
    } catch (err) {
      throw new CannotConnect(
        `Sonos S1 LoadDeviceData failed (${(err as Error).message})`,
        err instanceof Error ? err : undefined,
      );
    }

    this.playerId = device.Uuid;
    // The S1 stack doesn't expose a true "household id"; use the local UUID
    // as a stable identity placeholder — consumers only check for equality.
    this.householdId = device.Uuid;

    this.player = new S1SonosPlayer(this, device, {
      id: device.Uuid,
      name: device.Name,
      host: device.Host,
    });

    await this.refreshTopology();
    this.wireDeviceEvents();

    // GetState gives us track/transport state immediately so consumers don't
    // have to wait for the first event tick.
    try {
      const state = await device.GetState();
      const group = this.player?.group ?? null;
      if (group && state) {
        group.applyCurrentTrackUri(state.positionInfo?.TrackURI ?? '');
        if (state.positionInfo?.TrackMetaData && typeof state.positionInfo.TrackMetaData === 'object') {
          group.applyCurrentTrack(state.positionInfo.TrackMetaData as Track);
        }
        if (state.mediaInfo?.CurrentURI) {
          group.applyEnqueuedTrackUri(state.mediaInfo.CurrentURI);
        }
        if (state.mediaInfo?.CurrentURIMetaData && typeof state.mediaInfo.CurrentURIMetaData === 'object') {
          group.applyEnqueuedTrack(state.mediaInfo.CurrentURIMetaData as Track);
        }
        const positionSec = parseClockToSec(state.positionInfo?.RelTime);
        group.setPosition(positionSec);
        group.emitUpdated();
      }
    } catch {
      // Best-effort — events will refill state.
    }

    this.signalEvent({ eventType: EventType.CONNECTED, objectId: this.playerId });
    this.startPositionPolling();
    this.startTopologyPolling();
  }

  // start() kept for parity with the S2 client where it bootstraps the event
  // listener separately. The SDK auto-subscribes when an event handler is
  // attached, so this is a no-op here.
  async start(): Promise<void> {
    /* no-op */
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
    for (const detach of this.detachEventListeners.splice(0)) {
      try {
        detach();
      } catch {
        // ignore
      }
    }
    if (this.device) {
      try {
        // CancelEvents removes all subscriptions registered through this device.
        await (this.device as unknown as { CancelEvents?: () => Promise<unknown> }).CancelEvents?.();
      } catch {
        // ignore
      }
      this.device = null;
    }
    this.signalEvent({ eventType: EventType.DISCONNECTED, objectId: this.playerId });
  }

  // -------- topology --------

  private async refreshTopology(): Promise<void> {
    const device = this.device;
    if (!device) return;
    let zones: ZoneGroup[];
    try {
      zones = await device.GetZoneGroupState();
    } catch (err) {
      throw new CannotConnect(
        `Sonos S1 GetZoneGroupState failed (${(err as Error).message})`,
        err instanceof Error ? err : undefined,
      );
    }

    const seenIds = new Set<string>();
    for (const zone of zones) {
      const seed: S1GroupSeed = {
        id: zone.groupId,
        coordinatorId: zone.coordinator?.uuid ?? zone.groupId,
        name: zone.name,
        playerIds: (zone.members ?? []).map((m) => m.uuid),
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
        const group = new S1SonosGroup(this, device, seed);
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
    if (this.topologyPollTimer) return;
    // @svrooij/sonos surfaces coordinator/groupname events on the device, but
    // doesn't expose a strongly-typed topology-changed event. Poll the topology
    // every 30s to catch group reshuffles. Cheap (single SOAP call) and
    // bounded.
    this.topologyPollTimer = setInterval(() => {
      if (this.stopRequested) return;
      void this.refreshTopology().catch(() => undefined);
    }, 30_000);
    this.topologyPollTimer.unref?.();
  }

  // -------- device event wiring --------

  private wireDeviceEvents(): void {
    const device = this.device;
    if (!device) return;

    const events = device.Events;

    const onCurrentTrack = (track: Track): void => {
      this.player?.group?.applyCurrentTrack(track ?? null);
    };
    const onCurrentTrackUri = (uri: string): void => {
      this.player?.group?.applyCurrentTrackUri(uri ?? '');
    };
    const onEnqueuedTransport = (track: Track): void => {
      this.player?.group?.applyEnqueuedTrack(track ?? null);
    };
    const onEnqueuedTransportUri = (uri: string): void => {
      this.player?.group?.applyEnqueuedTrackUri(uri ?? '');
    };
    const onTransportState = (): void => {
      // The device's CurrentTransportStateSimple is already updated under the
      // hood; we just need to signal an update so consumers re-read the patch.
      this.player?.group?.emitUpdated();
    };
    const onVolume = (): void => {
      this.player?.group?.emitUpdated();
    };
    const onMuted = (): void => {
      this.player?.group?.emitUpdated();
    };
    const onCoordinator = (): void => {
      // Coordinator change means our group's coordinatorId moved; refresh
      // topology so members align.
      void this.refreshTopology().catch(() => undefined);
    };
    const onGroupName = (): void => {
      void this.refreshTopology().catch(() => undefined);
    };

    events.on(SonosEvents.CurrentTrackMetadata, onCurrentTrack);
    events.on(SonosEvents.CurrentTrackUri, onCurrentTrackUri);
    events.on(SonosEvents.EnqueuedTransportMetadata, onEnqueuedTransport);
    events.on(SonosEvents.EnqueuedTransportUri, onEnqueuedTransportUri);
    events.on(SonosEvents.CurrentTransportState, onTransportState);
    events.on(SonosEvents.Volume, onVolume);
    events.on(SonosEvents.Mute, onMuted);
    events.on(SonosEvents.Coordinator, onCoordinator);
    events.on(SonosEvents.GroupName, onGroupName);

    this.detachEventListeners.push(() => {
      events.off(SonosEvents.CurrentTrackMetadata, onCurrentTrack);
      events.off(SonosEvents.CurrentTrackUri, onCurrentTrackUri);
      events.off(SonosEvents.EnqueuedTransportMetadata, onEnqueuedTransport);
      events.off(SonosEvents.EnqueuedTransportUri, onEnqueuedTransportUri);
      events.off(SonosEvents.CurrentTransportState, onTransportState);
      events.off(SonosEvents.Volume, onVolume);
      events.off(SonosEvents.Mute, onMuted);
      events.off(SonosEvents.Coordinator, onCoordinator);
      events.off(SonosEvents.GroupName, onGroupName);
    });
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
    const device = this.device;
    const group = this.player?.group ?? null;
    if (!device || !group) return;
    if (group.playbackState !== 'PLAYBACK_STATE_PLAYING') return;
    try {
      const positionInfo = await device.AVTransportService.GetPositionInfo();
      const positionSec = parseClockToSec(positionInfo?.RelTime);
      if (positionSec !== null) {
        group.setPosition(positionSec);
        group.emitUpdated();
      }
    } catch {
      // best-effort
    }
  }
}

function parseClockToSec(clock: string | undefined): number | null {
  if (!clock) return null;
  const parts = clock.split(':').map((s) => Number(s));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}
