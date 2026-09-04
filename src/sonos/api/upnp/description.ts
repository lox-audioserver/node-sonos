// The speaker's own identity, from its UPnP device description.

import { fetch } from 'undici';
import { extractTag } from '@sonn-audio/node-upnp';

import { CannotConnect } from '../../errors';
import { combineSignals } from './abort';
import { SONOS_UPNP_PORT } from './soap';

export interface SonosDeviceDescription {
  /** RINCON_… — the stable player id, with the UDN's `uuid:` prefix stripped. */
  uuid: string;
  /** The room the speaker is assigned to; what a user calls this player. */
  name: string;
  host: string;
  port: number;
  modelName?: string;
}

export interface LoadDescriptionOptions {
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function loadDeviceDescription(
  host: string,
  options: LoadDescriptionOptions = {},
): Promise<SonosDeviceDescription> {
  const port = options.port ?? SONOS_UPNP_PORT;
  const url = `http://${host}:${port}/xml/device_description.xml`;
  const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 5_000));

  let xml: string;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    xml = await response.text();
  } catch (err) {
    throw new CannotConnect(
      `Sonos S1 device description from ${host} failed (${(err as Error).message})`,
      err instanceof Error ? err : undefined,
    );
  }

  const udn = extractTag(xml, 'UDN') ?? '';
  const uuid = udn.replace(/^uuid:/i, '').trim();
  if (!uuid) {
    throw new CannotConnect(`Sonos S1 device description from ${host} carried no UDN`);
  }
  // roomName is what the user named the speaker. friendlyName is "<ip> - <model>",
  // which is a fallback, not a name anyone chose.
  const name = extractTag(xml, 'roomName') || extractTag(xml, 'friendlyName') || uuid;

  return {
    uuid,
    name,
    host,
    port,
    modelName: extractTag(xml, 'modelName') || undefined,
  };
}
