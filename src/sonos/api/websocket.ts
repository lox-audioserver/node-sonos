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
    if (this.connected) {
      throw new InvalidState('Already connected');
    }
    // A socket that closed on its own stays in `this.ws` until disconnect() clears it. Drop it
    // here so a reconnect creates a fresh socket instead of failing forever with
    // 'Already connected' — which left the client permanently unable to reconnect while every
    // command kept throwing 'Not connected'.
    this.discardSocket();

    this.logger.debug?.(`Connecting to Sonos WebSocket ${this.websocketUrl}`);
    this.stopCalled = false;
    try {
      // The Sonos subprotocol MUST be requested via ws's `protocols` argument,
      // not as a raw Sec-WebSocket-Protocol header. ws only registers a
      // requested-protocol set when you pass `protocols`; with the header form
      // that set stays empty, so when Sonos echoes the subprotocol back in its
      // 101 response ws aborts the handshake with "Server sent a subprotocol but
      // none was requested" — surfacing as an error immediately after a 101.
      this.ws = new WebSocket(this.websocketUrl, 'v1.api.smartspeaker.audio', {
        headers: {
          'X-Sonos-Api-Key': LOCAL_API_TOKEN,
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
      let upgradeInfo: { statusCode?: number; statusMessage?: string; headers?: Record<string, unknown> } | null = null;
      this.ws.once('upgrade', (res: { statusCode?: number; statusMessage?: string; headers?: Record<string, unknown> }) => {
        upgradeInfo = {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
        };
        this.logger.debug?.('Sonos WebSocket upgrade response', upgradeInfo);
      });
      this.ws.once('unexpected-response', (_req: unknown, res: { statusCode?: number; statusMessage?: string; headers?: Record<string, unknown> }) => {
        const chunks: Buffer[] = [];
        const stream = res as unknown as NodeJS.ReadableStream;
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 512);
          this.logger.warn?.('Sonos WebSocket upgrade rejected', {
            url: this.websocketUrl,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body,
          });
          reject(
            new CannotConnect(
              `Upgrade rejected: ${res.statusCode ?? '?'} ${res.statusMessage ?? ''} body=${body}`,
            ),
          );
        });
        stream.on('error', () => {
          reject(
            new CannotConnect(
              `Upgrade rejected: ${res.statusCode ?? '?'} ${res.statusMessage ?? ''}`,
            ),
          );
        });
      });
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err: Error) => {
        const detail = upgradeInfo
          ? ` (upgrade ${upgradeInfo.statusCode} ${upgradeInfo.statusMessage ?? ''})`
          : '';
        reject(new CannotConnect(`Failed to connect${detail}`, err));
      });
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
    // Kept outside the loop: a per-iteration counter never grows, so maxReconnects would never
    // trip and the backoff would stay at its minimum forever.
    let attempts = 0;
    while (!this.stopCalled) {
      let reason: string | undefined;
      try {
        if (!this.connected) {
          await this.connect();
        }
        // A healthy session resets the backoff so a long uptime is not punished by an old
        // streak of failures.
        attempts = 0;
        reason = await this.waitForClose();
        if (this.stopCalled) break;
        this.discardSocket(reason);
        await this.onDisconnect?.(reason);
        this.logger.warn?.('WebSocket closed, reconnecting...', reason);
      } catch (err) {
        if (this.stopCalled) break;
        reason = err instanceof Error ? err.message : undefined;
        this.discardSocket(reason);
        this.logger.warn?.('WebSocket listen error, reconnecting...', err);
        await this.onDisconnect?.(reason);
      }
      attempts += 1;
      if (this.maxReconnects && attempts > this.maxReconnects) {
        this.logger.error?.('Max reconnect attempts reached');
        break;
      }
      await this.delay(this.computeRetryDelay(attempts));
    }
  }

  public async disconnect(): Promise<void> {
    this.stopCalled = true;
    this.clearHeartbeat();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        this.ws?.once('close', () => resolve());
        this.ws?.close();
      });
    }
    this.discardSocket('Connection closed');
  }

  /**
   * Forgets the current socket and fails every command still waiting on it. Without this a
   * command issued while the socket dies would hang forever (no result frame is ever coming),
   * and the stale socket would block the next connect().
   */
  private discardSocket(reason = 'Connection closed'): void {
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = undefined;
    for (const pending of this.resultFutures.values()) {
      pending.reject(new ConnectionClosed(reason));
    }
    this.resultFutures.clear();
    if (!ws) return;
    ws.removeAllListeners();
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
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
