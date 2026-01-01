import { SonosClient } from './client';
import { EventType } from './constants';
import { FailedCommand } from './errors';
import {
  Container,
  ContainerType,
  Group,
  GroupVolume,
  MetadataStatus,
  MusicService,
  PlaybackActions,
  PlaybackStatus,
  PlayBackState,
  PlayModes,
  SessionStatus,
  Track,
} from './types';
import {
  normalizeContainerType,
  normalizeMusicService,
  PlaybackActionsWrapper,
  PlayModesWrapper,
} from './models';

export class SonosGroup {
  public activeSessionId: string | null = null;
  private playbackStatus: PlaybackStatus | null = null;
  private playbackMetadata: MetadataStatus | null = null;
  private playbackStatusUpdatedAt = 0;
  private volumeData: GroupVolume | null = null;
  private playModes: PlayModesWrapper = new PlayModesWrapper({});
  private playbackActions: PlaybackActionsWrapper = new PlaybackActionsWrapper({});
  private unsubscribeCallbacks: Array<() => void> = [];

  constructor(
    private client: SonosClient,
    private data: Group,
  ) {}

  async init(): Promise<void> {
    try {
      this.volumeData = await this.client.api.groupVolume.getVolume(this.id);
      this.playbackStatus = await this.client.api.playback.getPlaybackStatus(this.id);
      this.playbackStatusUpdatedAt = Date.now();
      this.playbackActions = new PlaybackActionsWrapper(
        this.playbackStatus.availablePlaybackActions ?? {},
      );
      this.playModes = new PlayModesWrapper(this.playbackStatus.playModes ?? {});
      this.playbackMetadata = await this.client.api.playbackMetadata.getMetadataStatus(this.id);
      this.unsubscribeCallbacks = [
        await this.client.api.playback.subscribe(this.id, (data) =>
          this.handlePlaybackStatusUpdate(data),
        ),
        await this.client.api.groupVolume.subscribe(this.id, (data) =>
          this.handleVolumeUpdate(data),
        ),
        await this.client.api.playbackMetadata.subscribe(this.id, (data) =>
          this.handleMetadataUpdate(data),
        ),
      ];
    } catch (err) {
      if (err instanceof FailedCommand && err.errorCode === 'groupCoordinatorChanged') {
        this.volumeData = null;
        this.playbackStatus = null;
        this.playbackActions = new PlaybackActionsWrapper({});
        this.playModes = new PlayModesWrapper({});
        this.playbackMetadata = null;
        return;
      }
      throw err;
    }
    this.client.signalEvent({
      eventType: EventType.GROUP_ADDED,
      objectId: this.id,
      data: this,
    });
  }

  cleanup(): void {
    for (const cb of this.unsubscribeCallbacks) cb();
    this.unsubscribeCallbacks = [];
  }

  get id(): string {
    return this.data.id;
  }

  get name(): string {
    return this.data.name;
  }

  get coordinatorId(): string {
    return this.data.coordinatorId;
  }

  get playerIds(): string[] {
    return this.data.playerIds;
  }

  get areaIds(): string[] {
    return this.data.areaIds ?? [];
  }

  get playbackState(): PlayBackState {
    return (
      this.playbackStatus?.playbackState ??
      (this.data.playbackState as PlayBackState) ??
      PlayBackState.IDLE
    );
  }

  get playbackMetadataStatus(): MetadataStatus | null {
    return this.playbackMetadata;
  }

  get playbackActionsWrapper(): PlaybackActionsWrapper {
    return this.playbackActions;
  }

  get playModesWrapper(): PlayModesWrapper {
    return this.playModes;
  }

  get positionSeconds(): number {
    if (!this.playbackStatus) return 0;
    if (this.playbackState === PlayBackState.PLAYING) {
      const elapsed = (Date.now() - this.playbackStatusUpdatedAt) / 1000;
      return (this.playbackStatus.positionMillis ?? 0) / 1000 + elapsed;
    }
    return (this.playbackStatus.positionMillis ?? 0) / 1000;
  }

  get isDucking(): boolean {
    return this.playbackStatus?.isDucking ?? false;
  }

  get activeService(): MusicService | string | null {
    return normalizeMusicService(this.playbackMetadata?.container?.id?.serviceId);
  }

  get containerType(): ContainerType | string | null {
    return normalizeContainerType(this.playbackMetadata?.container?.type);
  }

  async play(): Promise<void> {
    await this.client.api.playback.play(this.id);
  }

  async pause(): Promise<void> {
    await this.client.api.playback.pause(this.id);
  }

  async stop(): Promise<void> {
    try {
      if (this.activeSessionId) {
        await this.client.api.playbackSession.suspend(this.activeSessionId);
      }
    } catch (err) {
      if (!(err instanceof FailedCommand)) throw err;
      try {
        await this.playStreamUrl('clear');
      } catch {
        // ignore
      }
    } finally {
      this.activeSessionId = null;
    }
  }

  async togglePlayPause(): Promise<void> {
    await this.client.api.playback.togglePlayPause(this.id);
  }

  async skipToNextTrack(): Promise<void> {
    await this.client.api.playback.skipToNextTrack(this.id);
  }

  async skipToPreviousTrack(): Promise<void> {
    await this.client.api.playback.skipToPreviousTrack(this.id);
  }

  async setPlayModes(options: PlayModes): Promise<void> {
    await this.client.api.playback.setPlayModes(this.id, options);
  }

  async seek(positionMillis: number): Promise<void> {
    await this.client.api.playback.seek(this.id, positionMillis);
  }

  async seekRelative(deltaMillis: number): Promise<void> {
    await this.client.api.playback.seekRelative(this.id, deltaMillis);
  }

  async loadLineIn(deviceId?: string, playOnCompletion = false): Promise<void> {
    await this.client.api.playback.loadLineIn(this.id, deviceId, playOnCompletion);
  }

  async modifyGroupMembers(playerIdsToAdd: string[], playerIdsToRemove: string[]): Promise<void> {
    await this.client.api.groups.modifyGroupMembers(this.id, playerIdsToAdd, playerIdsToRemove);
  }

  async setGroupMembers(playerIds: string[], areaIds?: string[]): Promise<void> {
    await this.client.api.groups.setGroupMembers(this.id, playerIds, areaIds);
  }

  async createPlaybackSession(
    appId = 'com.lox.sonos.playback',
    appContext = '1',
    accountId?: string,
    customData?: Record<string, unknown>,
  ): Promise<SessionStatus> {
    const session = await this.client.api.playbackSession.createSession(
      this.id,
      appId,
      appContext,
      accountId,
      customData,
    );
    this.activeSessionId = session.sessionId;
    return session;
  }

  async playStreamUrl(url: string, metadata?: Container): Promise<void> {
    await this.ensureSession();
    if (!this.activeSessionId) throw new Error('No active session');
    await this.client.api.playbackSession.loadStreamUrl(this.activeSessionId, url, {
      playOnCompletion: true,
      stationMetadata: metadata as unknown as Record<string, unknown> | undefined,
    });
  }

  async playCloudQueue(
    queueBaseUrl: string,
    options: {
      httpAuthorization?: string;
      useHttpAuthorizationForMedia?: boolean;
      itemId?: string;
      queueVersion?: string;
      positionMillis?: number;
      trackMetadata?: Track;
    },
  ): Promise<void> {
    await this.ensureSession();
    if (!this.activeSessionId) throw new Error('No active session');
    await this.client.api.playbackSession.loadCloudQueue(this.activeSessionId, queueBaseUrl, {
      ...options,
      playOnCompletion: true,
    });
  }

  updateData(newData: Group): void {
    let changed = false;
    for (const [key, value] of Object.entries(newData)) {
      if ((this.data as any)[key] !== value) {
        (this.data as any)[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.client.signalEvent({
        eventType: EventType.GROUP_UPDATED,
        objectId: this.id,
        data: this,
      });
    }
  }

  private async ensureSession(): Promise<void> {
    if (!this.activeSessionId) {
      await this.createPlaybackSession();
    }
  }

  private handlePlaybackStatusUpdate(data: PlaybackStatus): void {
    this.playbackStatus = data;
    this.playbackStatusUpdatedAt = Date.now();
    this.playbackActions = new PlaybackActionsWrapper(data.availablePlaybackActions ?? {});
    this.playModes = new PlayModesWrapper(data.playModes ?? {});
    this.client.signalEvent({
      eventType: EventType.GROUP_UPDATED,
      objectId: this.id,
      data: this,
    });
  }

  private handleMetadataUpdate(data: MetadataStatus): void {
    this.playbackMetadata = data;
    this.client.signalEvent({
      eventType: EventType.GROUP_UPDATED,
      objectId: this.id,
      data: this,
    });
  }

  private handleVolumeUpdate(data: GroupVolume): void {
    this.volumeData = data;
    this.client.signalEvent({
      eventType: EventType.GROUP_UPDATED,
      objectId: this.id,
      data: this,
    });
  }
}
