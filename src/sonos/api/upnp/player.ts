// S1-backed equivalent of SonosPlayer.

import { EventType } from '../../constants';
import type { S1Client } from './client';
import type { S1SonosGroup } from './group';

export interface S1PlayerSeed {
  id: string;
  name: string;
  host: string;
}

export class S1SonosPlayer {
  private activeGroup: S1SonosGroup | null = null;

  constructor(
    private readonly client: S1Client,
    private seed: S1PlayerSeed,
  ) {}

  get id(): string {
    return this.seed.id;
  }

  get name(): string {
    return this.seed.name;
  }

  get host(): string {
    return this.seed.host;
  }

  get icon(): string {
    return '';
  }

  get group(): S1SonosGroup | null {
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

  // Unimplemented on S1 — callers in lox-audioserver catch the rejection and
  // fall back to their own SOAP path.
  async leaveGroup(): Promise<void> {
    throw new Error('S1: leaveGroup not implemented; use direct SOAP via consumer');
  }

  async joinGroup(groupId: string): Promise<void> {
    // Joining on S1 means pointing this player's transport at the coordinator
    // (`x-rincon:<uuid>`), which the consumer's own SOAP path already does with the
    // grouping semantics it wants. Leave it to them rather than guessing here.
    void groupId;
    throw new Error('S1: joinGroup not implemented; use direct SOAP via consumer');
  }

  async setVolume(_volume?: number, _muted?: boolean): Promise<void> {
    throw new Error('S1: per-player setVolume not implemented; use group volume');
  }

  updateSeed(seed: S1PlayerSeed): boolean {
    let changed = false;
    if (this.seed.name !== seed.name) {
      this.seed.name = seed.name;
      changed = true;
    }
    if (this.seed.host !== seed.host) {
      this.seed.host = seed.host;
      changed = true;
    }
    return changed;
  }

  setActiveGroup(group: S1SonosGroup | null): void {
    const prevId = this.activeGroup?.id ?? null;
    this.activeGroup = group;
    if (prevId !== (group?.id ?? null)) {
      this.client.signalEvent({
        eventType: EventType.PLAYER_UPDATED,
        objectId: this.id,
        data: this,
      });
    }
  }

  notifyUpdated(): void {
    this.client.signalEvent({
      eventType: EventType.PLAYER_UPDATED,
      objectId: this.id,
      data: this,
    });
  }
}
