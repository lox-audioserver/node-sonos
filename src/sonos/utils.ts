import { Agent, fetch } from 'undici';

import { LOCAL_API_TOKEN } from './constants';
import { DiscoveryInfo } from './types';

export interface DiscoveryOptions {
  dispatcher?: Agent;
}

export async function getDiscoveryInfo(
  playerIp: string,
  options?: DiscoveryOptions,
): Promise<DiscoveryInfo> {
  const dispatcher = options?.dispatcher ?? new Agent({ connect: { rejectUnauthorized: false } });
  const resp = await fetch(`https://${playerIp}:1443/api/v1/players/local/info`, {
    method: 'GET',
    headers: { 'X-Sonos-Api-Key': LOCAL_API_TOKEN },
    dispatcher,
  });
  if (!resp.ok) {
    throw new Error(`Sonos discovery failed (${resp.status} ${resp.statusText})`);
  }
  const data = (await resp.json()) as DiscoveryInfo;
  return data;
}
