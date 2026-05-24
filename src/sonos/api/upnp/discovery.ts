// Generation probe for Sonos speakers.
//
// S2 speakers expose a JSON REST endpoint over TLS on port 1443. S1 speakers
// do not — they only speak UPnP/SOAP on port 1400. We probe both endpoints and
// classify accordingly. The S2 probe runs first so a clean S2 fleet doesn't
// incur the S1 fallback cost. Returns 'unknown' if neither responds, which
// usually means the host isn't a Sonos speaker at all.

import { fetch } from 'undici';

export type SonosGeneration = 'S1' | 'S2' | 'unknown';

const LOCAL_API_TOKEN = '123e4567-e89b-12d3-a456-426655440000';

export interface DetectGenerationOptions {
  signal?: AbortSignal;
  s2TimeoutMs?: number;
  s1TimeoutMs?: number;
}

export async function detectGeneration(
  host: string,
  options: DetectGenerationOptions = {},
): Promise<SonosGeneration> {
  const s2TimeoutMs = options.s2TimeoutMs ?? 1_500;
  const s1TimeoutMs = options.s1TimeoutMs ?? 3_000;

  try {
    const s2Response = await fetch(`https://${host}:1443/api/v1/players/local/info`, {
      method: 'GET',
      headers: { 'X-Sonos-Api-Key': LOCAL_API_TOKEN },
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

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
