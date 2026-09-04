// Wire-level shapes for the S1 (UPnP/SOAP) backend.
//
// These mirror what a Sonos speaker actually puts on the wire — DIDL-Lite track
// metadata and the ZoneGroupState topology document — and stay separate from the
// neutral `Track`/`Group` types in ../../types that both backends translate into.

/** Raw UPnP AVTransport states, as they appear in a LastChange event. */
export enum UpnpTransportState {
  Stopped = 'STOPPED',
  Playing = 'PLAYING',
  PausedPlayback = 'PAUSED_PLAYBACK',
  Transitioning = 'TRANSITIONING',
  NoMediaPresent = 'NO_MEDIA_PRESENT',
}

/** A track as described by a DIDL-Lite metadata blob. */
export interface UpnpTrack {
  title?: string;
  artist?: string;
  album?: string;
  albumArtUri?: string;
  upnpClass?: string;
  /** UPnP clock string, H:MM:SS. */
  duration?: string;
  trackUri?: string;
  /**
   * Sonos's `r:streamContent`: the "artist - title" string a radio stream reports
   * out-of-band. Present only on broadcast items.
   */
  streamContent?: string;
}

export interface ZoneMember {
  uuid: string;
  name: string;
  host: string;
  port: number;
  /** Bridges, Boosts and paired satellites — present in the topology, not playable on their own. */
  invisible: boolean;
}

export interface ZoneGroup {
  groupId: string;
  name: string;
  coordinator: ZoneMember | null;
  members: ZoneMember[];
}
