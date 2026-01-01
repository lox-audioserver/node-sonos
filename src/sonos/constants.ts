export const LOCAL_API_TOKEN = '123e4567-e89b-12d3-a456-426655440000';
export const LOG_LEVEL_VERBOSE = 5;
export const API_VERSION = 1;

export enum EventType {
  GROUP_ADDED = 'group_added',
  GROUP_UPDATED = 'group_updated',
  GROUP_REMOVED = 'group_removed',
  PLAYER_ADDED = 'player_added',
  PLAYER_UPDATED = 'player_updated',
  PLAYER_REMOVED = 'player_removed',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  MATCH_ALL = 'match_all',
}
