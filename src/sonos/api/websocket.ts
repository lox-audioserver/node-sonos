import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

import { API_VERSION, LOCAL_API_TOKEN, LOG_LEVEL_VERBOSE } from '../constants';
import { ErrorResponse, ResultMessage, CommandMessage } from '../types';
import {
  CannotConnect,
  ConnectionClosed,
  ConnectionFailed,
  FailedCommand,
  InvalidMessage,
  InvalidState,
  NotConnected,
} from '../errors';
import { SonosNamespace } from './namespace';
import { AudioClipNamespace } from './namespaces/audioClip';
import { GroupsNamespace } from './namespaces/groups';
import { GroupVolumeNamespace } from './namespaces/groupVolume';
import { PlaybackNamespace } from './namespaces/playback';
import { PlaybackMetadataNamespace } from './namespaces/playbackMetadata';
import { PlaybackSessionNamespace } from './namespaces/playbackSession';
import { PlayerVolumeNamespace } from './namespaces/playerVolume';
import { HomeTheaterNamespace } from './namespaces/homeTheater';

type Pending = {
  resolve: (value: any) => void;
  reject: (err: unknown) => void;
};

export interface WebSocketReliabilityOptions {
  heartbeatIntervalMs?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
  maxReconnects?: number;
}

export class SonosWebSocketApi {
  private ws?: WebSocket;
  private resultFutures = new Map<string, Pending>();
  private stopCalled = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatIntervalMs: number;
  private retryDelayMs: number;
  private retryJitterMs: number;
  private maxReconnects?: number;

  public readonly audioClip: AudioClipNamespace;
  public readonly groups: GroupsNamespace;
  public readonly groupVolume: GroupVolumeNamespace;
  public readonly playback: PlaybackNamespace;
  public readonly playbackMetadata: PlaybackMetadataNamespace;
  public readonly playbackSession: PlaybackSessionNamespace;
  public readonly playerVolume: PlayerVolumeNamespace;
  public readonly homeTheater: HomeTheaterNamespace;

  public logger: Console = console;
  public onConnect?: () => void | Promise<void>;
  public onDisconnect?: (reason?: string) => void | Promise<void>;

  constructor(private websocketUrl: string, opts: WebSocketReliabilityOptions = {}) {
    this.audioClip = new AudioClipNamespace(this);
    this.groups = new GroupsNamespace(this);
    this.groupVolume = new GroupVolumeNamespace(this);
    this.playback = new PlaybackNamespace(this);
    this.playbackMetadata = new PlaybackMetadataNamespace(this);
    this.playbackSession = new PlaybackSessionNamespace(this);
    this.playerVolume = new PlayerVolumeNamespace(this);
    this.homeTheater = new HomeTheaterNamespace(this);
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30000;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.retryJitterMs = opts.retryJitterMs ?? 500;
    this.maxReconnects = opts.maxReconnects;
  }

  get connected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  public async connect(): Promise<void> {
    if (this.ws) {
      throw new InvalidState('Already connected');
    }

    this.logger.debug?.(`Connecting to Sonos WebSocket ${this.websocketUrl}`);
    this.stopCalled = false;
    try {
      this.ws = new WebSocket(this.websocketUrl, {
        headers: {
          'X-Sonos-Api-Key': LOCAL_API_TOKEN,
          'Sec-WebSocket-Protocol': 'v1.api.smartspeaker.audio',
        },
        rejectUnauthorized: false,
        perMessageDeflate: true,
        maxPayload: 0,
      });
    } catch (err) {
      throw new CannotConnect('Failed to create websocket', err as Error);
    }

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new CannotConnect('No websocket'));
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err: Error) => reject(new CannotConnect('Failed to connect', err)));
    });

    this.ws.on('message', (data: WebSocket.RawData) => this.handleRawMessage(data));
    this.ws.on('close', () => {
      this.clearHeartbeat();
    });
    this.ws.on('error', (err: Error) => {
      this.logger.warn?.('WebSocket error', err);
    });
    this.ws.on('pong', () => {
      // noop; pong receipt confirms liveness
    });

    this.startHeartbeat();
    await this.onConnect?.();
  }

  public async startListening(): Promise<void> {
    this.stopCalled = false;
    while (!this.stopCalled) {
      let attempts = 0;
      try {
        if (!this.connected) {
          await this.connect();
        }
        const reason = await this.waitForClose();
        if (this.stopCalled) break;
        await this.onDisconnect?.(reason);
        this.logger.warn?.('WebSocket closed, reconnecting...', reason);
        attempts += 1;
        if (this.maxReconnects && attempts > this.maxReconnects) {
          this.logger.error?.('Max reconnect attempts reached');
          break;
        }
        await this.delay(this.computeRetryDelay(attempts));
      } catch (err) {
        if (this.stopCalled) break;
        this.logger.warn?.('WebSocket listen error, reconnecting...', err);
        await this.onDisconnect?.(err instanceof Error ? err.message : undefined);
        attempts += 1;
        if (this.maxReconnects && attempts > this.maxReconnects) {
          this.logger.error?.('Max reconnect attempts reached after error');
          break;
        }
        await this.delay(this.computeRetryDelay(attempts));
      }
    }
  }

  public async disconnect(): Promise<void> {
    this.stopCalled = true;
    this.clearHeartbeat();
    for (const pending of this.resultFutures.values()) {
      pending.reject(new ConnectionClosed('Connection closed'));
    }
    this.resultFutures.clear();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        this.ws?.once('close', () => resolve());
        this.ws?.close();
      });
    }
    this.ws = undefined;
  }

  public async sendCommand(
    namespace: string,
    command: string,
    options?: Record<string, unknown>,
    pathParams?: Record<string, unknown>,
  ): Promise<any> {
    if (!this.connected || !this.ws) throw new InvalidState('Not connected');
    const cmdId = randomUUID();
    const cmdMessage: CommandMessage = {
      namespace: `${namespace}:${API_VERSION}`,
      command,
      cmdId,
      ...(pathParams ?? {}),
    };

    const payload = [cmdMessage, options ?? {}];
    const resultPromise = new Promise<any>((resolve, reject) => {
      this.resultFutures.set(cmdId, { resolve, reject });
    });
    await this.send(payload);
    return resultPromise.finally(() => this.resultFutures.delete(cmdId));
  }

  public sendCommandNoWait(
    namespace: string,
    command: string,
    options?: Record<string, unknown>,
    pathParams?: Record<string, unknown>,
  ): void {
    if (!this.connected || !this.ws) throw new NotConnected('Not connected');
    const cmdMessage: CommandMessage = {
      namespace: `${namespace}:${API_VERSION}`,
      command,
      cmdId: randomUUID(),
      ...(pathParams ?? {}),
    };
    const payload = [cmdMessage, options ?? {}];
    void this.send(payload);
  }

  private async send(payload: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new NotConnected('Not connected');
    }
    if (this.logger && (this.logger as any).log && LOG_LEVEL_VERBOSE) {
      this.logger.log?.(LOG_LEVEL_VERBOSE, 'Publishing message', payload);
    }
    const data = JSON.stringify(payload);
    await new Promise<void>((resolve, reject) => {
      this.ws?.send(data, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRawMessage(raw: WebSocket.RawData): void {
    try {
      const parsed = JSON.parse(raw.toString());
      try {
        this.handleIncoming(parsed);
      } catch (err) {
        this.logger.error?.('Failed to handle Sonos message', err);
      }
    } catch (err) {
      this.logger.error?.('Invalid JSON from Sonos', err);
    }
  }

  private handleIncoming(raw: [ResultMessage, Record<string, unknown>]): void {
    if (!Array.isArray(raw) || raw.length !== 2) {
      this.logger.error?.('Invalid Sonos message shape', raw);
      return;
    }
    const [msg, msgData] = raw;
    if (!msg || typeof msg !== 'object') {
      throw new InvalidMessage('Received malformed message');
    }
    // error response
    if ('errorCode' in msgData) {
      const errData = msgData as unknown as ErrorResponse;
      if ('cmdId' in msg && msg.cmdId) {
        const future = this.resultFutures.get(msg.cmdId);
        future?.reject(new FailedCommand(errData.errorCode, errData.reason));
      } else {
        this.logger.error?.('Unhandled error', msgData);
      }
      return;
    }

    // command result
    if ('success' in msg) {
      if (msg.cmdId && this.resultFutures.has(msg.cmdId)) {
        const pending = this.resultFutures.get(msg.cmdId);
        if (msg.success) {
          pending?.resolve(msgData);
        } else {
          pending?.reject(new FailedCommand(String(msgData['_objectType'] ?? 'unknown')));
        }
      }
      return;
    }

    // event
    if (msg.type) {
      const namespaces: SonosNamespace<any>[] = [
        this.audioClip,
        this.groups,
        this.groupVolume,
        this.playbackMetadata,
        this.playbackSession,
        this.playback,
        this.playerVolume,
        this.homeTheater,
      ];
      const target = namespaces.find((ns) => ns.eventType === msg.type);
      if (target) {
        target.handleEvent(msg as any, msgData);
      } else {
        this.logger.debug?.(`Unhandled event type ${msg.type}`);
      }
      return;
    }

    this.logger.debug?.('Unhandled message', raw);
  }

  private async waitForClose(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new NotConnected('No websocket'));
      const onClose = (code: number, reason: Buffer) => {
        ws.removeListener('error', onError);
        resolve(`${code}:${reason.toString()}`);
      };
      const onError = (err: Error) => {
        ws.removeListener('close', onClose);
        reject(new ConnectionFailed(err));
      };
      ws.once('close', onClose);
      ws.once('error', onError);
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    if (!this.heartbeatIntervalMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
      } catch (err) {
        this.logger.warn?.('Heartbeat ping failed', err);
        this.ws.terminate();
      }
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private computeRetryDelay(attempt: number): number {
    const base = this.retryDelayMs * Math.min(2 ** (attempt - 1), 8);
    const jitter = Math.random() * this.retryJitterMs;
    return base + jitter;
  }
}
