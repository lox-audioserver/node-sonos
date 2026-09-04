// DIDL-Lite → UpnpTrack.
//
// Sonos hands track metadata around as a DIDL-Lite document, XML-escaped inside a
// SOAP argument or a LastChange attribute. node-upnp already parses the standard
// fields; this adds the two Sonos-specific touches: the vendor `r:streamContent`
// field that carries radio now-playing text, and resolving relative album art
// against the speaker that reported it.

import { parseDidlObject, unescapeXml } from '@sonn-audio/node-upnp';

import type { UpnpTrack } from './models';
import { SONOS_UPNP_PORT } from './soap';

export interface ParseTrackOptions {
  /** Speaker that reported the metadata; relative album art is resolved against it. */
  host?: string;
  port?: number;
}

export function parseTrackMetadata(
  metadata: string | undefined | null,
  options: ParseTrackOptions = {},
): UpnpTrack | null {
  if (!metadata) {
    return null;
  }
  const parsed = parseDidlObject(metadata);
  if (!parsed) {
    return null;
  }
  const streamContent = readStreamContent(metadata);
  const track: UpnpTrack = {
    title: parsed.title || undefined,
    artist: parsed.artist || undefined,
    album: parsed.album || undefined,
    albumArtUri: absoluteArtUri(parsed.albumArtUri, options),
    upnpClass: parsed.upnpClass || undefined,
    duration: parsed.duration || undefined,
    trackUri: parsed.res || undefined,
    streamContent: streamContent || undefined,
  };
  // A DIDL blob with nothing in it at all is the same as no metadata.
  if (!Object.values(track).some((v) => v !== undefined)) {
    return null;
  }
  return track;
}

/**
 * Radio streams carry their now-playing line in Sonos's own `r:streamContent`
 * rather than in dc:title, which stays fixed on the station name.
 */
function readStreamContent(metadata: string): string | undefined {
  const didl = unescapeXml(metadata);
  const m = /<r:streamContent[^>]*>([\s\S]*?)<\/r:streamContent>/i.exec(didl);
  return m ? unescapeXml(m[1] ?? '').trim() || undefined : undefined;
}

/**
 * Album art on a Sonos speaker is served by that speaker as a path-only URI
 * (`/getaa?...`). Consumers need something they can fetch.
 */
function absoluteArtUri(uri: string | undefined, options: ParseTrackOptions): string | undefined {
  if (!uri) {
    return undefined;
  }
  if (/^https?:\/\//i.test(uri)) {
    return uri;
  }
  if (!options.host) {
    return uri;
  }
  const port = options.port ?? SONOS_UPNP_PORT;
  return `http://${options.host}:${port}${uri.startsWith('/') ? '' : '/'}${uri}`;
}

/** UPnP clock strings (H:MM:SS[.ms]) to whole seconds. */
export function parseClockToSec(clock: string | undefined | null): number | null {
  if (!clock) {
    return null;
  }
  const parts = clock.split(':').map((s) => Number(s));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return null;
}
