import { SonosWebSocketApi } from './api/websocket';
import { EventType } from './constants';
import { FailedCommand } from './errors';
import { SonosGroup } from './group';
import { SonosPlayer } from './player';
import { getDiscoveryInfo, DiscoveryOptions } from './utils';
import { Group, Groups, SonosEvent } from './types';

type Subscriber = {
  cb: (event: SonosEvent) => void;
  eventFilter?: Set<EventType>;
  objectIdFilter?: Set<string>;
};

export interface SonosClientOptions extends DiscoveryOptions {
  logger?: Console;
  heartbeatIntervalMs?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
  maxReconnects?: number;
}

export class SonosClient {
  public api!: SonosWebSocketApi;
  public playerId!: string;
  public householdId!: string;
  public player: SonosPlayer | null = null;

  private groupMap = new Map<string, SonosGroup>();
  private subscribers: Subscriber[] = [];
  private logger: Console;
  private bootstrapPromise: Promise<void> | null = null;
  private connectedPlayerIds = new Set<string>();

  constructor(private playerIp: string, options: SonosClientOptions = {}) {
    this.logger = options.logger ?? console;
  }

  get groups(): SonosGroup[] {
    return Array.from(this.groupMap.values());
  }

  subscribe(
    cb: Subscriber['cb'],
    eventFilter?: EventType | EventType[] | null,
    objectIdFilter?: string | string[] | null,
  ): () => void {
    const eventSet =
      eventFilter == null
        ? undefined
        : Array.isArray(eventFilter)
          ? new Set(eventFilter)
          : new Set([eventFilter]);
    const objectSet =
      objectIdFilter == null
        ? undefined
        : Array.isArray(objectIdFilter)
          ? new Set(objectIdFilter)
          : new Set([objectIdFilter]);
    const sub: Subscriber = {
      cb,
      eventFilter: eventSet,
      objectIdFilter: objectSet,
    };
    this.subscribers.push(sub);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== sub);
    };
  }

  signalEvent(event: SonosEvent): void {
    for (const sub of this.subscribers) {
      if (sub.eventFilter && !sub.eventFilter.has(event.eventType)) continue;
      if (sub.objectIdFilter && event.objectId && !sub.objectIdFilter.has(event.objectId)) {
        continue;
      }
      sub.cb(event);
    }
  }

  async connect(options?: SonosClientOptions): Promise<void> {
    const discovery = await getDiscoveryInfo(this.playerIp, options);
    this.playerId = discovery.playerId;
    this.householdId = discovery.householdId;
    this.api = new SonosWebSocketApi(discovery.websocketUrl, {
      heartbeatIntervalMs: options?.heartbeatIntervalMs,
      retryDelayMs: options?.retryDelayMs,
      retryJitterMs: options?.retryJitterMs,
      maxReconnects: options?.maxReconnects,
    });
    if (options?.logger) this.api.logger = options.logger;
    this.api.onConnect = () => this.handleSocketConnected();
    this.api.onDisconnect = (reason?: string) => this.handleSocketDisconnected(reason);
    await this.api.connect();
  }

  async disconnect(): Promise<void> {
    for (const group of this.groupMap.values()) {
      group.cleanup();
    }
    await this.api.disconnect();
  }

  async start(): Promise<void> {
    await this.bootstrap();
    await this.api.startListening();
  }

  private async bootstrap(reconnect = false): Promise<void> {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      if (!this.api || !this.api.connected) {
        await this.connect();
      }
      if (reconnect || this.groupMap.size) {
        for (const group of this.groupMap.values()) group.cleanup();
        this.groupMap.clear();
      }
      const groupsData = await this.api.groups.getGroups(this.householdId, true);
      for (const groupData of groupsData.groups) {
        await this.setupGroup(groupData);
      }
      const playerData = groupsData.players.find((p) => p.id === this.playerId);
      if (!playerData) {
        throw new FailedCommand('playerNotFound', 'Local player not returned in groups response');
      }
      this.player = new SonosPlayer(this, playerData);
      await this.player.init();
      this.connectedPlayerIds = new Set(groupsData.players.map((p) => p.id));
      await this.api.groups.subscribe(this.householdId, (data) => this.handleGroupsEvent(data));
      this.signalEvent({ eventType: EventType.CONNECTED, objectId: this.playerId });
    })();
    try {
      await this.bootstrapPromise;
    } finally {
      this.bootstrapPromise = null;
    }
  }

  async createGroup(playerIds: string[], musicContextGroupId?: string): Promise<void> {
    await this.api.groups.createGroup(this.householdId, playerIds, musicContextGroupId);
  }

  private async setupGroup(groupData: Group): Promise<void> {
    const group = new SonosGroup(this, groupData);
    this.groupMap.set(group.id, group);
    await group.init();
    if (this.player) this.player.checkActiveGroup();
  }

  private handleGroupsEvent(groupsData: Groups): void {
    for (const groupData of groupsData.groups) {
      const existing = this.groupMap.get(groupData.id);
      if (existing) {
        existing.updateData(groupData);
        continue;
      }
      void this.setupGroup(groupData);
    }

    const removedIds = new Set(this.groupMap.keys());
    for (const g of groupsData.groups) removedIds.delete(g.id);
    for (const removedId of removedIds) {
      const group = this.groupMap.get(removedId);
      group?.cleanup();
      this.groupMap.delete(removedId);
      this.signalEvent({
        eventType: EventType.GROUP_REMOVED,
        objectId: removedId,
        data: group,
      });
    }

    const incomingPlayers = new Set(groupsData.players.map((p) => p.id));
    // removals
    for (const prev of Array.from(this.connectedPlayerIds)) {
      if (!incomingPlayers.has(prev)) {
        this.signalEvent({
          eventType: EventType.PLAYER_REMOVED,
          objectId: prev,
          data: prev,
        });
        this.connectedPlayerIds.delete(prev);
      }
    }
    // updates/additions
    for (const playerData of groupsData.players) {
      if (playerData.id === this.playerId && this.player) {
        this.player.updateData(playerData);
      }
      if (!this.connectedPlayerIds.has(playerData.id)) {
        this.connectedPlayerIds.add(playerData.id);
        this.signalEvent({
          eventType: EventType.PLAYER_ADDED,
          objectId: playerData.id,
          data: playerData,
        });
      }
    }
  }

  private async handleSocketConnected(): Promise<void> {
    try {
      await this.bootstrap(true);
    } catch (err) {
      this.logger.error?.('Failed to bootstrap after reconnect', err);
    }
  }

  private handleSocketDisconnected(reason?: string): void {
    this.signalEvent({
      eventType: EventType.DISCONNECTED,
      objectId: this.playerId,
      data: reason,
    });
  }
}
