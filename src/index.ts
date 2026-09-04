export { SonosClient, SonosClientOptions } from './sonos/client';
export { SonosGroup } from './sonos/group';
export { SonosPlayer } from './sonos/player';
export * from './sonos/models';
export * from './sonos/types';
export * from './sonos/constants';
export * from './sonos/errors';

// S1 (legacy / Sonos OS 1 firmware) support.
export { S1Client, type S1ClientOptions } from './sonos/api/upnp/client';
export { S1SonosGroup } from './sonos/api/upnp/group';
export { S1SonosPlayer } from './sonos/api/upnp/player';
export { detectGeneration, type SonosGeneration } from './sonos/api/upnp/discovery';
export {
  UpnpTransportState,
  type UpnpTrack,
  type ZoneGroup,
  type ZoneMember,
} from './sonos/api/upnp/models';
