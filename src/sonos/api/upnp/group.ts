// S1-backed equivalent of SonosGroup, sitting on top of @svrooij/sonos.
//
// The state controller in lox-audioserver consumes a small slice of SonosGroup
// (playbackState, playbackMetadataStatus, positionSeconds, activeService,
// transport commands). This adapter forwards reads to a SonosDevice from
// @svrooij/sonos and routes writes to the device's coordinator.

import type SonosDevice from '@svrooij/sonos/lib/sonos-device';
import { TransportState } from '@svrooij/sonos/lib/models';
import type { Track } from '@svrooij/sonos/lib/models/track';

import { EventType } from '../../constants';
import {
  ContainerType,
  MetadataStatus,
  MusicService,
  PlayBackState,
  type Container,
  type QueueItem,
} from '../../types';
import type { S1Client } from './client';

export interface S1GroupSeed {
  id: string;
  coordinatorId: string;
  name: string;
  playerIds: string[];
}

export class S1SonosGroup {
  // Track metadata snapshot kept in sync with the device's events. The device
  // itself caches CurrentTrackUri/Coordinator/etc, but exposing it via our
  // adapter requires us to mirror enough to satisfy the MetadataStatus shape.
  private currentTrack: Track | null = null;
  private enqueuedTrack: Track | null = null;
  private currentTrackUri = '';
  private enqueuedTrackUri = '';
  private positionAtUpdate = 0;
  private updatedAtMs = Date.now();

  constructor(
    private readonly client: S1Client,
    private readonly device: SonosDevice,
    private seed: S1GroupSeed,
  ) {}

  // ----- topology -----

  get id(): string {
    return this.seed.id;
  }

  get coordinatorId(): string {
    return this.seed.coordinatorId;
  }

  get playerIds(): string[] {
    return this.seed.playerIds;
  }

  get name(): string {
    return this.seed.name;
  }

  get areaIds(): string[] {
    return [];
  }

  updateSeed(seed: S1GroupSeed): boolean {
    let changed = false;
    if (this.seed.coordinatorId !== seed.coordinatorId) {
      this.seed.coordinatorId = seed.coordinatorId;
      changed = true;
    }
    if (this.seed.playerIds.join(',') !== seed.playerIds.join(',')) {
      this.seed.playerIds = seed.playerIds;
      changed = true;
    }
    if (this.seed.name !== seed.name && seed.name) {
      this.seed.name = seed.name;
      changed = true;
    }
    return changed;
  }

  // ----- state derived from the device -----

  get playbackState(): PlayBackState {
    const s = this.device.CurrentTransportStateSimple;
    if (s === TransportState.Playing) return PlayBackState.PLAYING;
    if (s === TransportState.Paused) return PlayBackState.PAUSED;
    if (s === TransportState.Transitioning) return PlayBackState.BUFFERING;
    return PlayBackState.IDLE;
  }

  get positionSeconds(): number {
    if (this.playbackState === PlayBackState.PLAYING) {
      const elapsed = (Date.now() - this.updatedAtMs) / 1000;
      return Math.max(0, this.positionAtUpdate + elapsed);
    }
    return Math.max(0, this.positionAtUpdate);
  }

  setPosition(seconds: number | null): void {
    if (seconds === null || !Number.isFinite(seconds)) return;
    this.positionAtUpdate = Math.max(0, seconds);
    this.updatedAtMs = Date.now();
  }

  get isDucking(): boolean {
    return false;
  }

  get activeService(): MusicService | string | null {
    return inferActiveService(this.currentTrackUri);
  }

  get containerType(): ContainerType | string | null {
    return inferContainerType(this.currentTrackUri, this.enqueuedTrackUri, this.currentTrack);
  }

  get playbackMetadataStatus(): MetadataStatus | null {
    return this.buildMetadataStatus();
  }

  get volume(): number | null {
    const v = this.device.Volume;
    return typeof v === 'number' ? v : null;
  }

  get muted(): boolean | null {
    const m = this.device.Muted;
    return typeof m === 'boolean' ? m : null;
  }

  // ----- transport commands (route to coordinator) -----

  async play(): Promise<void> {
    await this.device.Coordinator.Play();
  }

  async pause(): Promise<void> {
    await this.device.Coordinator.Pause();
  }

  async stop(): Promise<void> {
    await this.device.Coordinator.Stop();
  }

  async togglePlayPause(): Promise<void> {
    await this.device.Coordinator.TogglePlayback();
  }

  async skipToNextTrack(): Promise<void> {
    await this.device.Coordinator.Next();
  }

  async skipToPreviousTrack(): Promise<void> {
    await this.device.Coordinator.Previous();
  }

  // ----- updates from the SDK's event stream -----

  applyCurrentTrack(track: Track | null): void {
    this.currentTrack = track;
    this.emitUpdated();
  }

  applyCurrentTrackUri(uri: string): void {
    this.currentTrackUri = uri ?? '';
    this.emitUpdated();
  }

  applyEnqueuedTrack(track: Track | null): void {
    this.enqueuedTrack = track;
    this.emitUpdated();
  }

  applyEnqueuedTrackUri(uri: string): void {
    this.enqueuedTrackUri = uri ?? '';
    this.emitUpdated();
  }

  emitUpdated(): void {
    this.client.signalEvent({
      eventType: EventType.GROUP_UPDATED,
      objectId: this.id,
      data: this,
    });
  }

  // ----- helpers -----

  private buildMetadataStatus(): MetadataStatus | null {
    const track = this.currentTrack;
    const container = buildContainer(this.currentTrackUri, this.enqueuedTrackUri, this.enqueuedTrack);
    if (!track && !this.currentTrackUri && !container) {
      return {
        _objectType: 'metadataStatus',
        currentItem: undefined,
        container: undefined,
        streamInfo: undefined,
      };
    }
    const durationSec = parseClockToSec(track?.Duration);
    const currentItem: QueueItem | undefined = track
      ? {
          _objectType: 'queueItem',
          id: `${this.id}:current`,
          track: {
            _objectType: 'track',
            type: track.UpnpClass ?? 'audioItem',
            name: track.Title ?? '',
            mediaUrl: track.TrackUri || this.currentTrackUri || undefined,
            artist: track.Artist
              ? { _objectType: 'artist', name: track.Artist }
              : undefined,
            album: track.Album ? { _objectType: 'album', name: track.Album } : undefined,
            durationMillis: durationSec !== null ? durationSec * 1000 : undefined,
            images: track.AlbumArtUri
              ? [{ _objectType: 'image', url: track.AlbumArtUri }]
              : undefined,
          },
        }
      : undefined;
    return {
      _objectType: 'metadataStatus',
      currentItem,
      container,
      // @svrooij/sonos doesn't surface ICY r:streamContent as a discrete field.
      // Radio metadata typically arrives via the next CurrentTrack event with
      // a Title carrying the broadcast string, which the consumer picks up via
      // currentItem.track.name.
      streamInfo: undefined,
    };
  }
}

function buildContainer(
  currentUri: string,
  enqueuedUri: string,
  enqueuedTrack: Track | null,
): Container | undefined {
  const containerType = inferContainerType(currentUri, enqueuedUri, enqueuedTrack);
  if (!enqueuedUri && !enqueuedTrack) return undefined;
  return {
    _objectType: 'container',
    name: enqueuedTrack?.Title ?? '',
    type: containerType ?? 'unknown',
    images: enqueuedTrack?.AlbumArtUri
      ? [{ _objectType: 'image', url: enqueuedTrack.AlbumArtUri }]
      : undefined,
  };
}

function inferContainerType(
  currentUri: string,
  enqueuedUri: string,
  track: Track | null,
): ContainerType | string | null {
  const probe = `${currentUri} ${enqueuedUri}`.toLowerCase();
  if (probe.includes('x-rincon-stream:')) return ContainerType.LINEIN;
  if (probe.includes('x-sonos-htastream:')) return ContainerType.HOME_THEATER_SPDIF;
  if (probe.includes('x-rincon-mp3radio:') || probe.includes('x-sonosapi-stream:')) {
    return ContainerType.STATION;
  }
  if (probe.includes('x-sonos-vli:')) return ContainerType.AIRPLAY;
  if (probe.includes('x-sonos-spotify:')) return 'spotify';
  const upnpClass = track?.UpnpClass?.toLowerCase() ?? '';
  if (upnpClass.includes('audiobroadcast')) return ContainerType.STATION;
  if (upnpClass.includes('musictrack')) return ContainerType.PLAYLIST;
  return null;
}

function inferActiveService(currentUri: string): string | null {
  const uri = (currentUri ?? '').toLowerCase();
  if (uri.includes('spotify')) return MusicService.SPOTIFY;
  if (uri.includes('tunein') || uri.startsWith('x-sonosapi-stream:')) return MusicService.TUNEIN;
  if (uri.startsWith('x-rincon-stream:')) return 'linein';
  if (uri.startsWith('x-sonos-vli:')) return 'airplay';
  return null;
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
