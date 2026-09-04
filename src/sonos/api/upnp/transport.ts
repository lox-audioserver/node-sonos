// AVTransport / RenderingControl actions on an S1 speaker.

import { extractTag } from '@sonn-audio/node-upnp';

import { callAction, type CallActionOptions } from './soap';

export type TransportCommand = 'Play' | 'Pause' | 'Stop' | 'Next' | 'Previous';

/**
 * Transport commands only take effect on a group's coordinator, so callers are
 * expected to have resolved that host first.
 */
export async function sendTransportCommand(
  host: string,
  command: TransportCommand,
  options: CallActionOptions = {},
): Promise<void> {
  // Play is the only one of these that takes an argument.
  const args: Record<string, string> = command === 'Play' ? { Speed: '1' } : {};
  await callAction(host, 'AVTransport', command, args, options);
}

export interface PositionInfo {
  trackUri?: string;
  trackMetadata?: string;
  /** Elapsed time within the track, as a UPnP clock string. */
  relTime?: string;
  duration?: string;
}

export async function getPositionInfo(
  host: string,
  options: CallActionOptions = {},
): Promise<PositionInfo> {
  const xml = await callAction(host, 'AVTransport', 'GetPositionInfo', {}, options);
  return {
    trackUri: extractTag(xml, 'TrackURI') || undefined,
    trackMetadata: extractTag(xml, 'TrackMetaData') || undefined,
    relTime: extractTag(xml, 'RelTime') || undefined,
    duration: extractTag(xml, 'TrackDuration') || undefined,
  };
}

export interface MediaInfo {
  currentUri?: string;
  currentUriMetadata?: string;
}

export async function getMediaInfo(
  host: string,
  options: CallActionOptions = {},
): Promise<MediaInfo> {
  const xml = await callAction(host, 'AVTransport', 'GetMediaInfo', {}, options);
  return {
    currentUri: extractTag(xml, 'CurrentURI') || undefined,
    currentUriMetadata: extractTag(xml, 'CurrentURIMetaData') || undefined,
  };
}

export async function getTransportState(
  host: string,
  options: CallActionOptions = {},
): Promise<string | undefined> {
  const xml = await callAction(host, 'AVTransport', 'GetTransportInfo', {}, options);
  return extractTag(xml, 'CurrentTransportState') || undefined;
}

export async function getVolume(host: string, options: CallActionOptions = {}): Promise<number | undefined> {
  const xml = await callAction(host, 'RenderingControl', 'GetVolume', { Channel: 'Master' }, options);
  const value = Number(extractTag(xml, 'CurrentVolume'));
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : undefined;
}

export async function getMute(host: string, options: CallActionOptions = {}): Promise<boolean | undefined> {
  const xml = await callAction(host, 'RenderingControl', 'GetMute', { Channel: 'Master' }, options);
  const value = extractTag(xml, 'CurrentMute');
  if (value === null) {
    return undefined;
  }
  return value === '1' || value.toLowerCase() === 'true';
}
