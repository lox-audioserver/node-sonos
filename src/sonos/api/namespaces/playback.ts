import { LoadContentRequest, PlaybackStatus, PlayModes } from '../../types';
import { SonosNamespace, SubscribeCallback, UnsubscribeCallback } from '../namespace';

export class PlaybackNamespace extends SonosNamespace<PlaybackStatus> {
  constructor(api: any) {
    super(api, 'playback', 'playbackStatus', 'groupId');
  }

  async getPlaybackStatus(groupId: string): Promise<PlaybackStatus> {
    return this.api.sendCommand(this.namespace, 'getPlaybackStatus', undefined, { groupId });
  }

  async loadLineIn(groupId: string, deviceId?: string, playOnCompletion = false): Promise<void> {
    const options: Record<string, unknown> = {};
    if (deviceId) options.deviceId = deviceId;
    options.playOnCompletion = playOnCompletion;
    await this.api.sendCommand(this.namespace, 'loadLineIn', options, { groupId });
  }

  async loadContent(groupId: string, content: LoadContentRequest): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'loadContent',
      content as unknown as Record<string, unknown>,
      { groupId },
    );
  }

  async pause(groupId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'pause', undefined, { groupId });
  }

  async play(groupId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'play', undefined, { groupId });
  }

  async togglePlayPause(groupId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'togglePlayPause', undefined, { groupId });
  }

  async setPlayModes(
    groupId: string,
    playModes: PlayModes,
  ): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'setPlayModes',
      { playModes },
      { groupId },
    );
  }

  async seek(groupId: string, positionMillis: number, itemId?: string): Promise<void> {
    const options: Record<string, unknown> = { positionMillis };
    if (itemId) options.itemId = itemId;
    await this.api.sendCommand(this.namespace, 'seek', options, { groupId });
  }

  async seekRelative(groupId: string, deltaMillis: number, itemId?: string): Promise<void> {
    const options: Record<string, unknown> = { deltaMillis };
    if (itemId) options.itemId = itemId;
    await this.api.sendCommand(this.namespace, 'seekRelative', options, { groupId });
  }

  async skipToNextTrack(groupId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'skipToNextTrack', undefined, { groupId });
  }

  async skipToPreviousTrack(groupId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'skipToPreviousTrack', undefined, { groupId });
  }

  async subscribe(
    groupId: string,
    callback: SubscribeCallback<PlaybackStatus>,
  ): Promise<UnsubscribeCallback> {
    return this.handleSubscribe(groupId, callback);
  }
}
