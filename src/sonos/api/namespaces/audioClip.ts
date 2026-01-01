import { SonosNamespace, SubscribeCallback, UnsubscribeCallback } from '../namespace';
import { AudioClipStatusEvent } from '../../types';

export class AudioClipNamespace extends SonosNamespace<AudioClipStatusEvent> {
  constructor(api: any) {
    super(api, 'audioClip', 'audioClip', 'playerId');
  }

  async loadAudioClip(
    playerId: string,
    options: {
      name: string;
      appId: string;
      streamUrl?: string;
      volume?: number;
      priority?: string;
      clipType?: string;
      httpAuthorization?: string;
      clipLEDBehavior?: string;
    },
  ) {
    return this.api.sendCommand(
      this.namespace,
      'loadAudioClip',
      {
        name: options.name,
        appId: options.appId,
        priority: options.priority,
        clipType: options.clipType,
        streamUrl: options.streamUrl,
        httpAuthorization: options.httpAuthorization,
        volume: options.volume,
        clipLEDBehavior: options.clipLEDBehavior,
      },
      { playerId },
    );
  }

  async subscribe(
    playerId: string,
    callback: SubscribeCallback<AudioClipStatusEvent>,
  ): Promise<UnsubscribeCallback> {
    return this.handleSubscribe(playerId, callback);
  }
}
