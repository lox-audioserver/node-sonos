import { GroupInfo, Groups } from '../../types';
import { SonosNamespace, SubscribeCallback, UnsubscribeCallback } from '../namespace';

export class GroupsNamespace extends SonosNamespace<Groups> {
  constructor(api: any) {
    super(api, 'groups', 'groups', 'householdId');
  }

  async modifyGroupMembers(
    groupId: string,
    playerIdsToAdd: string[],
    playerIdsToRemove: string[],
  ): Promise<GroupInfo> {
    return this.api.sendCommand(
      this.namespace,
      'modifyGroupMembers',
      { playerIdsToAdd, playerIdsToRemove },
      { groupId },
    );
  }

  async setGroupMembers(
    groupId: string,
    playerIds: string[],
    areaIds?: string[],
  ): Promise<GroupInfo> {
    const options: Record<string, unknown> = { playerIds };
    if (areaIds) options.areaIds = areaIds;
    return this.api.sendCommand(this.namespace, 'setGroupMembers', options, { groupId });
  }

  async getGroups(householdId: string, includeDeviceInfo = false): Promise<Groups> {
    return this.api.sendCommand(
      this.namespace,
      'getGroups',
      { includeDeviceInfo },
      { householdId },
    );
  }

  async createGroup(
    householdId: string,
    playerIds: string[],
    musicContextGroupId?: string,
  ): Promise<GroupInfo> {
    const options: Record<string, unknown> = { playerIds };
    if (musicContextGroupId) options.musicContextGroupId = musicContextGroupId;
    return this.api.sendCommand(
      this.namespace,
      'createGroup',
      options,
      { householdId },
    );
  }

  async subscribe(
    householdId: string,
    callback: SubscribeCallback<Groups>,
  ): Promise<UnsubscribeCallback> {
    return this.handleSubscribe(householdId, callback);
  }
}
