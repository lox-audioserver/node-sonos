import { EventType } from './constants';

export interface CommandMessage {
  namespace: string;
  command: string;
  sessionId?: string;
  cmdId?: string;
  [key: string]: unknown;
}

export interface ResultMessage {
  namespace: string;
  response: string;
  householdId: string;
  type?: string;
  sessionId?: string;
  cmdId?: string;
  success?: boolean;
  [key: string]: unknown;
}

export interface ErrorResponse {
  errorCode: string;
  reason?: string;
}

export enum PlayBackState {
  IDLE = 'PLAYBACK_STATE_IDLE',
  BUFFERING = 'PLAYBACK_STATE_BUFFERING',
  PAUSED = 'PLAYBACK_STATE_PAUSED',
  PLAYING = 'PLAYBACK_STATE_PLAYING',
}

export enum SonosCapability {
  CLOUD = 'CLOUD',
  PLAYBACK = 'PLAYBACK',
  AIRPLAY = 'AIRPLAY',
  LINE_IN = 'LINE_IN',
  VOICE = 'VOICE',
  AUDIO_CLIP = 'AUDIO_CLIP',
  MICROPHONE_SWITCH = 'MICROPHONE_SWITCH',
  HT_PLAYBACK = 'HT_PLAYBACK',
}

export interface Group {
  _objectType: 'group';
  coordinatorId: string;
  id: string;
  name: string;
  playbackState?: string;
  playerIds: string[];
  areaIds?: string[];
}

export interface GroupInfo {
  _objectType: 'groupInfo';
  group: Group;
}

export interface ZoneMemberState {
  _objectType: 'zoneMemberState';
  disconnected: boolean;
}

export interface ActiveZoneMember {
  _objectType: 'activeZoneMember';
  channelMap: string[];
  id: string;
  state: ZoneMemberState;
}

export interface ActiveZone {
  _objectType: 'activeZone';
  members: ActiveZoneMember[];
  name: string;
  zoneId?: string;
}

export interface DeviceInfo {
  _objectType: 'deviceInfo';
  id: string;
  primaryDeviceId?: string;
  serialNumber?: string;
  modelDisplayName?: string;
  color?: string;
  capabilities: SonosCapability[];
  apiVersion?: string;
  minApiVersion?: string;
  name?: string;
  websocketUrl?: string;
  softwareVersion?: string;
  hwVersion?: string;
  swGen?: number;
}

export interface Player {
  _objectType: 'player';
  id: string;
  name: string;
  websocketUrl: string;
  softwareVersion: string;
  apiVersion: string;
  minApiVersion: string;
  devices: DeviceInfo[];
  zoneInfo: ActiveZone;
  icon?: string;
}

export interface Groups {
  _objectType: 'groups';
  groups: Group[];
  partial: boolean;
  players: Player[];
}

export interface DiscoveryInfo {
  _objectType: 'discoveryInfo';
  device: DeviceInfo;
  householdId: string;
  locationId: string;
  playerId: string;
  groupId: string;
  websocketUrl: string;
  restUrl: string;
}

export interface PlaybackActions {
  _objectType?: 'playbackAction';
  canCrossfade?: boolean;
  canPause?: boolean;
  canPlay?: boolean;
  canRepeat?: boolean;
  canRepeatOne?: boolean;
  canSeek?: boolean;
  canShuffle?: boolean;
  canSkip?: boolean;
  canSkipBack?: boolean;
  canSkipToPrevious?: boolean;
  canStop?: boolean;
  canSkipForward?: boolean;
}

export interface PlayModes {
  _objectType?: 'playModes';
  crossfade?: boolean;
  repeat?: boolean;
  repeatOne?: boolean;
  shuffle?: boolean;
}

export interface PlaybackStatus {
  _objectType: 'playbackStatus';
  availablePlaybackActions: PlaybackActions;
  isDucking: boolean;
  playbackState: PlayBackState;
  playModes: PlayModes;
  positionMillis: number;
  previousPositionMillis: number;
}

export interface GroupVolume {
  _objectType: 'groupVolume';
  fixed: boolean;
  muted: boolean;
  volume: number;
}

export interface PlayerVolume {
  _objectType: 'playerVolume';
  fixed: boolean;
  muted: boolean;
  volume: number;
}

export enum MusicService {
  SPOTIFY = '9',
  MUSIC_ASSISTANT = 'mass',
  TUNEIN = '303',
  QOBUZ = '31',
  YOUTUBE_MUSIC = '284',
  LOCAL_LIBRARY = 'local-library',
}

export interface MetadataId {
  _objectType: 'id';
  serviceId?: string;
  objectId?: string;
  accountId?: string;
}

export interface Service {
  _objectType: 'service';
  name: string;
  images?: Image[];
}

export interface Image {
  _objectType: 'image';
  url: string;
  name?: string;
  type?: string;
}

export interface Artist {
  _objectType: 'artist';
  name: string;
}

export interface Album {
  _objectType: 'album';
  name: string;
}

export interface Track {
  _objectType: 'track';
  type: string;
  name: string;
  mediaUrl?: string;
  images?: Image[];
  contentType?: string;
  album?: Album;
  artist?: Artist;
  releaseDate?: string;
  id?: MetadataId;
  service?: Service;
  durationMillis?: number;
  trackNumber?: number;
  explicit?: boolean;
}

export enum ContainerType {
  LINEIN = 'linein',
  STATION = 'station',
  PLAYLIST = 'playlist',
  AIRPLAY = 'linein.airplay',
  PODCAST = 'podcast',
  BOOK = 'book',
  ARTIST = 'artist',
  ALBUM = 'album',
  ARTIST_LOCAL = 'artist.local',
  ALBUM_LOCAL = 'album.local',
  HOME_THEATER_SPDIF = 'linein.homeTheater.spdif',
  HOME_THEATER_HDMI = 'linein.homeTheater.hdmi',
  // fallbacks for unknown types will be treated as strings
}

export interface Container {
  _objectType: 'container';
  name: string;
  type: string;
  id?: MetadataId;
  service?: Service;
  images?: Image[];
  explicit?: boolean;
}

export interface QueueItem {
  _objectType: 'queueItem';
  id: string;
  deleted?: boolean;
  track?: Track;
}

export interface PlaybackSession {
  _objectType: 'sessionStatus';
  sessionId: string;
  sessionState: string;
  sessionCreated: boolean;
  customData: string;
}

export interface MetadataStatus {
  _objectType: 'metadataStatus';
  container?: Container;
  currentItem?: QueueItem;
  nextItem?: QueueItem;
  streamInfo?: string;
  playbackSession?: PlaybackSession;
}

export interface AudioClip {
  _objectType: 'audioClip';
  id: string;
  name: string;
  appId: string;
  priority: string;
  clipType: string;
  status: string;
  clipLEDBehavior: string;
}

export interface AudioClipStatusEvent {
  _objectType: 'audioClipStatus';
  audioClips: AudioClip[];
}

export interface LoadContentRequest {
  type: string;
  id: MetadataId;
  playbackAction: string;
  playModes?: PlayModes;
}

export interface SessionStatus {
  _objectType: 'sessionStatus';
  sessionId: string;
  sessionState: string;
  sessionCreated: boolean;
  customData: string;
}

export interface SonosEvent {
  eventType: EventType;
  objectId?: string | null;
  data?: any;
}
