import { MetadataStatus } from '../../types';
import { SonosNamespace, SubscribeCallback, UnsubscribeCallback } from '../namespace';

export class PlaybackMetadataNamespace extends SonosNamespace<MetadataStatus> {
  constructor(api: any) {
    super(api, 'playbackMetadata', 'metadataStatus', 'groupId');
  }

  async getMetadataStatus(groupId: string): Promise<MetadataStatus> {
    return this.api.sendCommand(this.namespace, 'getMetadataStatus', undefined, { groupId });
  }

  async subscribe(
    groupId: string,
    callback: SubscribeCallback<MetadataStatus>,
  ): Promise<UnsubscribeCallback> {
    return this.handleSubscribe(groupId, callback);
  }
}
