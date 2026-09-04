// S1-backed equivalent of SonosGroup.
//
// The state controller in a consumer app reads a small slice of SonosGroup
// (playbackState, playbackMetadataStatus, positionSeconds, activeService,
// transport commands). This adapter answers those from the speaker state the
// client keeps current, and routes commands to the group's coordinator.

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
import { parseClockToSec } from './didl';
import { UpnpTransportState, type UpnpTrack } from './models';

export interface S1GroupSeed {
  id: string;
  coordinatorId: string;
  name: string;
  playerIds: string[];
}

export class S1SonosGroup {
  // Track metadata mirrored from the speaker's events, in the shape the
  // MetadataStatus consumers expect.
  private currentTrack: UpnpTrack | null = null;
  private enqueuedTrack: UpnpTrack | null = null;
  private currentTrackUri = '';
  private enqueuedTrackUri = '';
  private positionAtUpdate = 0;
  private updatedAtMs = Date.now();

  constructor(
    private readonly client: S1Client,
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

  // ----- state derived from the speaker -----

  get playbackState(): PlayBackState {
    switch (this.client.currentTransportState) {
      case UpnpTransportState.Playing:
        return PlayBackState.PLAYING;
      case UpnpTransportState.PausedPlayback:
        return PlayBackState.PAUSED;
      case UpnpTransportState.Transitioning:
        return PlayBackState.BUFFERING;
      default:
        return PlayBackState.IDLE;
    }
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
    return this.client.currentVolume ?? null;
  }

  get muted(): boolean | null {
    return this.client.currentMuted ?? null;
  }

  // ----- transport commands (route to coordinator) -----

  async play(): Promise<void> {
    await this.client.runTransportCommand(this.id, 'Play');
  }

  async pause(): Promise<void> {
    await this.client.runTransportCommand(this.id, 'Pause');
  }

  async stop(): Promise<void> {
    await this.client.runTransportCommand(this.id, 'Stop');
  }

  async togglePlayPause(): Promise<void> {
    // AVTransport has no toggle; pick the command from what the speaker is doing.
    const playing = this.playbackState === PlayBackState.PLAYING;
    await this.client.runTransportCommand(this.id, playing ? 'Pause' : 'Play');
  }

  async skipToNextTrack(): Promise<void> {
    await this.client.runTransportCommand(this.id, 'Next');
  }

  async skipToPreviousTrack(): Promise<void> {
    await this.client.runTransportCommand(this.id, 'Previous');
  }

  // ----- updates from the event stream -----

  applyCurrentTrack(track: UpnpTrack | null): void {
    this.currentTrack = track;
    this.emitUpdated();
  }

  applyCurrentTrackUri(uri: string): void {
    this.currentTrackUri = uri ?? '';
    this.emitUpdated();
  }

  applyEnqueuedTrack(track: UpnpTrack | null): void {
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
    const durationSec = parseClockToSec(track?.duration);
    const currentItem: QueueItem | undefined = track
      ? {
          _objectType: 'queueItem',
          id: `${this.id}:current`,
          track: {
            _objectType: 'track',
            type: track.upnpClass ?? 'audioItem',
            name: track.title ?? '',
            mediaUrl: track.trackUri || this.currentTrackUri || undefined,
            artist: track.artist ? { _objectType: 'artist', name: track.artist } : undefined,
            album: track.album ? { _objectType: 'album', name: track.album } : undefined,
            durationMillis: durationSec !== null ? durationSec * 1000 : undefined,
            images: track.albumArtUri ? [{ _objectType: 'image', url: track.albumArtUri }] : undefined,
          },
        }
      : undefined;
    return {
      _objectType: 'metadataStatus',
      currentItem,
      container,
      // Radio carries its now-playing line out-of-band, in Sonos's r:streamContent,
      // while dc:title stays on the station name.
      streamInfo: track?.streamContent,
    };
  }
}

function buildContainer(
  currentUri: string,
  enqueuedUri: string,
  enqueuedTrack: UpnpTrack | null,
): Container | undefined {
  const containerType = inferContainerType(currentUri, enqueuedUri, enqueuedTrack);
  if (!enqueuedUri && !enqueuedTrack) return undefined;
  return {
    _objectType: 'container',
    name: enqueuedTrack?.title ?? '',
    type: containerType ?? 'unknown',
    images: enqueuedTrack?.albumArtUri
      ? [{ _objectType: 'image', url: enqueuedTrack.albumArtUri }]
      : undefined,
  };
}

function inferContainerType(
  currentUri: string,
  enqueuedUri: string,
  track: UpnpTrack | null,
): ContainerType | string | null {
  const probe = `${currentUri} ${enqueuedUri}`.toLowerCase();
  if (probe.includes('x-rincon-stream:')) return ContainerType.LINEIN;
  if (probe.includes('x-sonos-htastream:')) return ContainerType.HOME_THEATER_SPDIF;
  if (probe.includes('x-rincon-mp3radio:') || probe.includes('x-sonosapi-stream:')) {
    return ContainerType.STATION;
  }
  if (probe.includes('x-sonos-vli:')) return ContainerType.AIRPLAY;
  if (probe.includes('x-sonos-spotify:')) return 'spotify';
  const upnpClass = track?.upnpClass?.toLowerCase() ?? '';
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
