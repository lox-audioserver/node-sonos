// Generation probe for Sonos speakers.
//
// S2 speakers expose a JSON REST endpoint over TLS on port 1443. S1 speakers
// do not — they only speak UPnP/SOAP on port 1400. We probe both endpoints and
// classify accordingly. The S2 probe runs first so a clean S2 fleet doesn't
// incur the S1 fallback cost. Returns 'unknown' if neither responds, which
// usually means the host isn't a Sonos speaker at all.

import { Agent, fetch } from 'undici';

import { combineSignals } from './abort';

export type SonosGeneration = 'S1' | 'S2' | 'unknown';

const LOCAL_API_TOKEN = '123e4567-e89b-12d3-a456-426655440000';

export interface DetectGenerationOptions {
  signal?: AbortSignal;
  s2TimeoutMs?: number;
  s1TimeoutMs?: number;
  dispatcher?: Agent;
}

export async function detectGeneration(
  host: string,
  options: DetectGenerationOptions = {},
): Promise<SonosGeneration> {
  const s2TimeoutMs = options.s2TimeoutMs ?? 1_500;
  const s1TimeoutMs = options.s1TimeoutMs ?? 3_000;

  // S2 serves this endpoint over a self-signed cert ("Sonos Device
  // Authentication Root CA"), so we must disable TLS validation — exactly as
  // getDiscoveryInfo and the WebSocket client do. Without it undici throws
  // DEPTH_ZERO_SELF_SIGNED_CERT, the probe falls through to the S1 branch, and
  // since S2 speakers also serve the legacy UPnP description on :1400 we'd
  // misclassify every S2 unit as S1.
  const dispatcher = options.dispatcher ?? new Agent({ connect: { rejectUnauthorized: false } });

  try {
    const s2Response = await fetch(`https://${host}:1443/api/v1/players/local/info`, {
      method: 'GET',
      headers: { 'X-Sonos-Api-Key': LOCAL_API_TOKEN },
      dispatcher,
      signal: combineSignals(options.signal, AbortSignal.timeout(s2TimeoutMs)),
    });
    if (s2Response.ok) {
      await s2Response.text().catch(() => '');
      return 'S2';
    }
  } catch {
    // Refused / timeout / TLS error → not S2 from our side.
  }

  try {
    const s1Response = await fetch(`http://${host}:1400/xml/device_description.xml`, {
      method: 'GET',
      signal: combineSignals(options.signal, AbortSignal.timeout(s1TimeoutMs)),
    });
    if (s1Response.ok) {
      const body = await s1Response.text();
      if (body.includes('<UDN>')) return 'S1';
    }
  } catch {
    // Neither endpoint answered.
  }

  return 'unknown';
}
