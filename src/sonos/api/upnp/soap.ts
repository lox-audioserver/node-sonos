// SOAP control for Sonos S1 speakers.
//
// S1 firmware speaks plain UPnP on port 1400: a POST of a SOAP envelope to a
// service's control URL. The envelope building and fault reading come from
// @sonn-audio/node-upnp — this module only adds the Sonos service table and the
// HTTP round trip, since node-upnp's own control point discards response bodies
// and we need to read out-arguments (GetPositionInfo, GetZoneGroupState).

import { fetch } from 'undici';
import { buildSoapRequest, extractFaultCode } from '@sonn-audio/node-upnp';

import { FailedCommand, TransportError } from '../../errors';
import { combineSignals } from './abort';

export const SONOS_UPNP_PORT = 1400;

export interface SonosServiceDef {
  type: string;
  controlPath: string;
  eventPath: string;
  /** null for services that take no InstanceID argument at all. */
  instanceId: number | null;
}

export const SONOS_SERVICES = {
  AVTransport: {
    type: 'urn:schemas-upnp-org:service:AVTransport:1',
    controlPath: '/MediaRenderer/AVTransport/Control',
    eventPath: '/MediaRenderer/AVTransport/Event',
    instanceId: 0,
  },
  RenderingControl: {
    type: 'urn:schemas-upnp-org:service:RenderingControl:1',
    controlPath: '/MediaRenderer/RenderingControl/Control',
    eventPath: '/MediaRenderer/RenderingControl/Event',
    instanceId: 0,
  },
  GroupRenderingControl: {
    type: 'urn:schemas-upnp-org:service:GroupRenderingControl:1',
    controlPath: '/MediaRenderer/GroupRenderingControl/Control',
    eventPath: '/MediaRenderer/GroupRenderingControl/Event',
    instanceId: 0,
  },
  ZoneGroupTopology: {
    type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
    controlPath: '/ZoneGroupTopology/Control',
    eventPath: '/ZoneGroupTopology/Event',
    instanceId: null,
  },
} satisfies Record<string, SonosServiceDef>;

export type SonosServiceName = keyof typeof SONOS_SERVICES;

export function serviceEventUrl(host: string, service: SonosServiceName, port = SONOS_UPNP_PORT): string {
  return `http://${host}:${port}${SONOS_SERVICES[service].eventPath}`;
}

export interface CallActionOptions {
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Invoke a SOAP action and return the raw response body.
 *
 * Argument values are inserted verbatim, matching node-upnp's builder — a caller
 * passing DIDL metadata must escape it first.
 */
export async function callAction(
  host: string,
  service: SonosServiceName,
  action: string,
  args: Record<string, string> = {},
  options: CallActionOptions = {},
): Promise<string> {
  const def = SONOS_SERVICES[service];
  const port = options.port ?? SONOS_UPNP_PORT;
  const url = `http://${host}:${port}${def.controlPath}`;
  const body = buildSoapRequest(def.type, action, args, { instanceId: def.instanceId });
  const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 5_000));

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${def.type}#${action}"`,
      },
      body,
      signal,
    });
  } catch (err) {
    throw new TransportError(
      `${service}.${action} to ${host} failed: ${(err as Error).message}`,
      err instanceof Error ? err : undefined,
    );
  }

  const text = await response.text().catch(() => '');
  if (response.ok) {
    return text;
  }
  // UPnP reports action errors as HTTP 500 with a UPnPError detail; anything else
  // is a transport-level problem.
  const upnpError = extractFaultCode(text);
  if (upnpError) {
    throw new FailedCommand(upnpError, `${service}.${action} on ${host}`);
  }
  throw new TransportError(`${service}.${action} to ${host} returned HTTP ${response.status}`);
}
