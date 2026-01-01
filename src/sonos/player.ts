import { SonosClient } from './client';
import { EventType } from './constants';
import { SonosGroup } from './group';
import { Player, PlayerVolume } from './types';

export class SonosPlayer {
  private volumeData: PlayerVolume | null = null;
  private activeGroup: SonosGroup | null = null;

  constructor(
    private client: SonosClient,
    private data: Player,
  ) {
    this.activeGroup = this.client.groups.find(
      (g) => g.coordinatorId === this.id || g.playerIds.includes(this.id),
    ) ?? null;
  }

  async init(): Promise<void> {
    this.volumeData = await this.client.api.playerVolume.getVolume(this.id);
    await this.client.api.playerVolume.subscribe(this.id, (data) => this.handleVolumeUpdate(data));
  }

  get id(): string {
    return this.data.id;
  }

  get name(): string {
    return this.data.name;
  }

  get icon(): string {
    return this.data.icon ?? '';
  }

  get volumeLevel(): number | undefined {
    return this.volumeData?.volume;
  }

  get volumeMuted(): boolean | undefined {
    return this.volumeData?.muted;
  }

  get hasFixedVolume(): boolean | undefined {
    return this.volumeData?.fixed;
  }

  get group(): SonosGroup | null {
    return this.activeGroup;
  }

  get groupMembers(): string[] {
    return this.group?.playerIds ?? [];
  }

  get isCoordinator(): boolean {
    return Boolean(this.group && this.group.coordinatorId === this.id);
  }

  get isPassive(): boolean {
    return Boolean(this.group && this.group.coordinatorId !== this.id);
  }

  async setVolume(volume?: number, muted?: boolean): Promise<void> {
    await this.client.api.playerVolume.setVolume(this.id, volume, muted);
  }

  async duck(durationMillis?: number): Promise<void> {
    await this.client.api.playerVolume.duck(this.id, durationMillis);
  }

  async leaveGroup(): Promise<void> {
    if (!this.group) return;
    await this.client.api.groups.modifyGroupMembers(this.group.id, [], [this.id]);
  }

  async joinGroup(groupId: string): Promise<void> {
    await this.client.api.groups.modifyGroupMembers(groupId, [this.id], []);
  }

  async playAudioClip(
    url: string,
    options: { volume?: number; name?: string } = {},
  ): Promise<void> {
    await this.client.api.audioClip.loadAudioClip(this.id, {
      name: options.name ?? 'lox-sonos',
      appId: 'lox-sonos',
      streamUrl: url,
      volume: options.volume,
    });
  }

  async loadHomeTheaterPlayback(): Promise<void> {
    await this.client.api.homeTheater.loadHomeTheaterPlayback(this.id);
  }

  updateData(newData: Player): void {
    this.checkActiveGroup();
    let changed = false;
    for (const [key, value] of Object.entries(newData)) {
      if ((this.data as any)[key] !== value) {
        (this.data as any)[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.client.signalEvent({
        eventType: EventType.PLAYER_UPDATED,
        objectId: this.id,
        data: this,
      });
    }
  }

  checkActiveGroup(): void {
    const prevGroupId = this.activeGroup?.id;
    this.activeGroup =
      this.client.groups.find(
        (g) => g.coordinatorId === this.id || g.playerIds.includes(this.id),
      ) ?? null;
    if (prevGroupId !== this.activeGroup?.id) {
      this.client.signalEvent({
        eventType: EventType.PLAYER_UPDATED,
        objectId: this.id,
        data: this,
      });
    }
  }

  private handleVolumeUpdate(data: PlayerVolume): void {
    this.volumeData = data;
    this.client.signalEvent({
      eventType: EventType.PLAYER_UPDATED,
      objectId: this.id,
      data: this,
    });
  }
}
