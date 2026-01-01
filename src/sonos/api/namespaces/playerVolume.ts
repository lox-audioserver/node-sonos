import { PlayerVolume } from '../../types';
import { SonosNamespace, SubscribeCallback, UnsubscribeCallback } from '../namespace';

export class PlayerVolumeNamespace extends SonosNamespace<PlayerVolume> {
  constructor(api: any) {
    super(api, 'playerVolume', 'playerVolume', 'playerId');
  }

  async setVolume(playerId: string, volume?: number, muted?: boolean): Promise<void> {
    const options: Record<string, unknown> = {};
    if (typeof volume === 'number') options.volume = volume;
    if (typeof muted === 'boolean') options.muted = muted;
    await this.api.sendCommand(this.namespace, 'setVolume', options, { playerId });
  }

  async getVolume(playerId: string): Promise<PlayerVolume> {
    return this.api.sendCommand(this.namespace, 'getVolume', undefined, { playerId });
  }

  async duck(playerId: string, durationMillis?: number): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'duck',
      durationMillis ? { durationMillis } : undefined,
      { playerId },
    );
  }

  async unduck(playerId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'unduck', undefined, { playerId });
  }

  async setMute(playerId: string, muted: boolean): Promise<void> {
    await this.api.sendCommand(this.namespace, 'setMute', { muted }, { playerId });
  }

  async setRelativeVolume(playerId: string, volumeDelta?: number, muted?: boolean): Promise<void> {
    const options: Record<string, unknown> = {};
    if (typeof volumeDelta === 'number') options.volumeDelta = volumeDelta;
    if (typeof muted === 'boolean') options.muted = muted;
    await this.api.sendCommand(this.namespace, 'setRelativeVolume', options, { playerId });
  }

  async subscribe(
    playerId: string,
    callback: SubscribeCallback<PlayerVolume>,
  ): Promise<UnsubscribeCallback> {
    return this.handleSubscribe(playerId, callback);
  }
}
