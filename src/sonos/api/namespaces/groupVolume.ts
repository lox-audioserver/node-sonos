import { GroupVolume } from '../../types';
import { SonosNamespace, SubscribeCallback, UnsubscribeCallback } from '../namespace';

export class GroupVolumeNamespace extends SonosNamespace<GroupVolume> {
  constructor(api: any) {
    super(api, 'groupVolume', 'groupVolume', 'groupId');
  }

  async setVolume(groupId: string, volume: number): Promise<void> {
    await this.api.sendCommand(this.namespace, 'setVolume', { volume }, { groupId });
  }

  async getVolume(groupId: string): Promise<GroupVolume> {
    return this.api.sendCommand(this.namespace, 'getVolume', undefined, { groupId });
  }

  async setMute(groupId: string, muted: boolean): Promise<void> {
    await this.api.sendCommand(this.namespace, 'setMute', { muted }, { groupId });
  }

  async setRelativeVolume(groupId: string, volumeDelta?: number): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'setRelativeVolume',
      { volumeDelta },
      { groupId },
    );
  }

  async subscribe(
    groupId: string,
    callback: SubscribeCallback<GroupVolume>,
  ): Promise<UnsubscribeCallback> {
    return this.handleSubscribe(groupId, callback);
  }
}
