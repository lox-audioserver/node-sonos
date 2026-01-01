import { SessionStatus, Track } from '../../types';
import { SonosNamespace, SubscribeCallback, UnsubscribeCallback } from '../namespace';

export class PlaybackSessionNamespace extends SonosNamespace<SessionStatus> {
  constructor(api: any) {
    super(api, 'playbackSession', 'playbackSession', 'sessionId');
  }

  async createSession(
    groupId: string,
    appId: string,
    appContext: string,
    accountId?: string,
    customData?: Record<string, unknown>,
  ): Promise<SessionStatus> {
    const options: Record<string, unknown> = { appId, appContext };
    if (accountId) options.accountId = accountId;
    if (customData) options.customData = customData;
    return this.api.sendCommand(this.namespace, 'createSession', options, { groupId });
  }

  async loadCloudQueue(
    sessionId: string,
    queueBaseUrl: string,
    options: {
      httpAuthorization?: string;
      useHttpAuthorizationForMedia?: boolean;
      itemId?: string;
      queueVersion?: string;
      positionMillis?: number;
      playOnCompletion?: boolean;
      trackMetadata?: Track;
    },
  ): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'loadCloudQueue',
      {
        queueBaseUrl,
        httpAuthorization: options.httpAuthorization,
        useHttpAuthorizationForMedia: options.useHttpAuthorizationForMedia,
        itemId: options.itemId,
        queueVersion: options.queueVersion,
        positionMillis: options.positionMillis,
        playOnCompletion: options.playOnCompletion,
        trackMetadata: options.trackMetadata,
      },
      { sessionId },
    );
  }

  async loadStreamUrl(
    sessionId: string,
    streamUrl: string,
    options: {
      playOnCompletion?: boolean;
      stationMetadata?: Record<string, unknown>;
      itemId?: string;
    } = {},
  ): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'loadStreamUrl',
      {
        streamUrl,
        playOnCompletion: options.playOnCompletion,
        stationMetadata: options.stationMetadata,
        itemId: options.itemId,
      },
      { sessionId },
    );
  }

  async refreshCloudQueue(sessionId: string): Promise<void> {
    await this.api.sendCommand(this.namespace, 'refreshCloudQueue', undefined, { sessionId });
  }

  async seek(sessionId: string, positionMillis: number, itemId?: string): Promise<void> {
    const options: Record<string, unknown> = { positionMillis };
    if (itemId) options.itemId = itemId;
    await this.api.sendCommand(this.namespace, 'seek', options, { sessionId });
  }

  async seekRelative(sessionId: string, deltaMillis: number, itemId?: string): Promise<void> {
    const options: Record<string, unknown> = { deltaMillis };
    if (itemId) options.itemId = itemId;
    await this.api.sendCommand(this.namespace, 'seekRelative', options, { sessionId });
  }

  async skipToItem(
    sessionId: string,
    itemId: string,
    options: { queueVersion?: string; positionMillis?: number; playOnCompletion?: boolean } = {},
  ): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'skipToItem',
      {
        itemId,
        queueVersion: options.queueVersion,
        positionMillis: options.positionMillis,
        playOnCompletion: options.playOnCompletion,
      },
      { sessionId },
    );
  }

  async suspend(sessionId: string, queueVersion?: string): Promise<void> {
    await this.api.sendCommand(
      this.namespace,
      'suspend',
      queueVersion ? { queueVersion } : undefined,
      { sessionId },
    );
  }

  async subscribe(
    sessionId: string,
    callback: SubscribeCallback<SessionStatus>,
  ): Promise<UnsubscribeCallback> {
    return this.handleSubscribe(sessionId, callback);
  }
}
