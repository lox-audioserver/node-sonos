// A stand-in Sonos S1 speaker: device description, SOAP control, and GENA eventing.
//
// Real S1 hardware is the only true test, but the wire format is fully specified and
// this reproduces it — including the double-escaped DIDL inside a LastChange
// attribute, which is where a hand-rolled parser is most likely to go wrong.

import http from 'node:http';

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function didlTrack({ title, artist, album, art, res, upnpClass, streamContent }) {
  const parts = [
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
      'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
      'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">',
    '<item id="-1" parentID="-1" restricted="true">',
  ];
  if (res) parts.push(`<res protocolInfo="sonos.com-http:*:audio/mp4:*" duration="0:03:52">${esc(res)}</res>`);
  if (art) parts.push(`<upnp:albumArtURI>${esc(art)}</upnp:albumArtURI>`);
  if (title) parts.push(`<dc:title>${esc(title)}</dc:title>`);
  if (artist) parts.push(`<dc:creator>${esc(artist)}</dc:creator>`);
  if (album) parts.push(`<upnp:album>${esc(album)}</upnp:album>`);
  if (streamContent) parts.push(`<r:streamContent>${esc(streamContent)}</r:streamContent>`);
  parts.push(`<upnp:class>${upnpClass ?? 'object.item.audioItem.musicTrack'}</upnp:class>`);
  parts.push('</item></DIDL-Lite>');
  return parts.join('');
}

export class FakeSpeaker {
  constructor({ uuid, roomName, port = 0 }) {
    this.uuid = uuid;
    this.roomName = roomName;
    this.requestedPort = port;
    this.calls = [];
    this.subscriptions = new Map(); // sid -> { callback, service }
    this.sidSeq = 0;
    this.zoneGroupState = '<ZoneGroups></ZoneGroups>';
    this.state = {
      transportState: 'STOPPED',
      trackUri: '',
      trackMetadata: '',
      relTime: '0:00:00',
      duration: '0:00:00',
      currentUri: '',
      currentUriMetadata: '',
      volume: 25,
      mute: false,
    };
  }

  async listen() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve) => this.server.listen(this.requestedPort, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  close() {
    this.server?.close();
  }

  handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const method = (req.method ?? '').toUpperCase();
      if (method === 'SUBSCRIBE') return this.onSubscribe(req, res);
      if (method === 'UNSUBSCRIBE') {
        this.subscriptions.delete((req.headers.sid ?? '').trim());
        res.writeHead(200).end();
        return;
      }
      if (method === 'GET' && req.url.includes('device_description')) {
        res.writeHead(200, { 'Content-Type': 'text/xml' }).end(this.description());
        return;
      }
      if (method === 'POST') return this.onSoap(req, res, body);
      res.writeHead(404).end();
    });
  }

  description() {
    return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
<friendlyName>127.0.0.1 - Sonos Play:1</friendlyName>
<manufacturer>Sonos, Inc.</manufacturer><modelName>Sonos Play:1</modelName>
<UDN>uuid:${this.uuid}</UDN><roomName>${esc(this.roomName)}</roomName>
</device></root>`;
  }

  onSubscribe(req, res) {
    const sid = `uuid:sub-${this.uuid}-${(this.sidSeq += 1)}`;
    const callbackHeader = req.headers.callback ?? '';
    const callback = /<([^>]+)>/.exec(callbackHeader)?.[1];
    const existing = (req.headers.sid ?? '').trim();
    if (existing && this.subscriptions.has(existing)) {
      // Renew in place.
      res.writeHead(200, { SID: existing, TIMEOUT: 'Second-300' }).end();
      return;
    }
    this.subscriptions.set(sid, { callback, path: req.url });
    res.writeHead(200, { SID: sid, TIMEOUT: 'Second-300' }).end();
  }

  onSoap(req, res, body) {
    const action = /"[^"]*#([A-Za-z]+)"/.exec(req.headers.soapaction ?? '')?.[1] ?? '';
    this.calls.push({ action, url: req.url, body, port: this.port });
    const reply = (serviceType, args) =>
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><u:${action}Response xmlns:u="${serviceType}">${args}</u:${action}Response>` +
          `</s:Body></s:Envelope>`,
      );
    const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
    const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
    const ZGT = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1';

    switch (action) {
      case 'GetZoneGroupState':
        return reply(ZGT, `<ZoneGroupState>${esc(this.zoneGroupState)}</ZoneGroupState>`);
      case 'GetTransportInfo':
        return reply(
          AVT,
          `<CurrentTransportState>${this.state.transportState}</CurrentTransportState>` +
            `<CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`,
        );
      case 'GetPositionInfo':
        return reply(
          AVT,
          `<Track>1</Track><TrackDuration>${this.state.duration}</TrackDuration>` +
            `<TrackMetaData>${esc(this.state.trackMetadata)}</TrackMetaData>` +
            `<TrackURI>${esc(this.state.trackUri)}</TrackURI>` +
            `<RelTime>${this.state.relTime}</RelTime><AbsTime>NOT_IMPLEMENTED</AbsTime>`,
        );
      case 'GetMediaInfo':
        return reply(
          AVT,
          `<NrTracks>1</NrTracks><MediaDuration>0:00:00</MediaDuration>` +
            `<CurrentURI>${esc(this.state.currentUri)}</CurrentURI>` +
            `<CurrentURIMetaData>${esc(this.state.currentUriMetadata)}</CurrentURIMetaData>`,
        );
      case 'GetVolume':
        return reply(RC, `<CurrentVolume>${this.state.volume}</CurrentVolume>`);
      case 'GetMute':
        return reply(RC, `<CurrentMute>${this.state.mute ? 1 : 0}</CurrentMute>`);
      case 'Play':
        this.state.transportState = 'PLAYING';
        return reply(AVT, '');
      case 'Pause':
        this.state.transportState = 'PAUSED_PLAYBACK';
        return reply(AVT, '');
      case 'Stop':
        this.state.transportState = 'STOPPED';
        return reply(AVT, '');
      case 'Next':
      case 'Previous':
        return reply(AVT, '');
      default:
        res.writeHead(500, { 'Content-Type': 'text/xml' }).end(
          `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
            `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>` +
            `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode></UPnPError>` +
            `</detail></s:Fault></s:Body></s:Envelope>`,
        );
    }
  }

  /** Push a NOTIFY to every subscriber whose subscription path matches. */
  async notify(pathFragment, propertyXml) {
    const body =
      `<?xml version="1.0"?><e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">` +
      `<e:property>${propertyXml}</e:property></e:propertyset>`;
    const targets = [...this.subscriptions.entries()].filter(([, s]) =>
      (s.path ?? '').includes(pathFragment),
    );
    await Promise.all(
      targets.map(
        ([sid, sub]) =>
          new Promise((resolve) => {
            const url = new URL(sub.callback);
            const req = http.request(
              {
                method: 'NOTIFY',
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                headers: { SID: sid, NT: 'upnp:event', NTS: 'upnp:propchange', 'Content-Type': 'text/xml' },
              },
              (res) => {
                res.resume();
                res.on('end', resolve);
              },
            );
            req.on('error', resolve);
            req.end(body);
          }),
      ),
    );
    return targets.length;
  }

  /** AVTransport LastChange — vars go in escaped, DIDL therefore double-escaped. */
  notifyTransport(vars) {
    const event =
      `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/" ` +
      `xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"><InstanceID val="0">` +
      Object.entries(vars)
        .map(([k, v]) => `<${k} val="${esc(String(v))}"/>`)
        .join('') +
      `</InstanceID></Event>`;
    return this.notify('/AVTransport/Event', `<LastChange>${esc(event)}</LastChange>`);
  }

  notifyRendering({ volume, mute }) {
    const entries = [];
    if (volume !== undefined) entries.push(`<Volume channel="Master" val="${volume}"/>`);
    if (mute !== undefined) entries.push(`<Mute channel="Master" val="${mute ? 1 : 0}"/>`);
    const event =
      `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0">` +
      entries.join('') +
      `</InstanceID></Event>`;
    return this.notify('/RenderingControl/Event', `<LastChange>${esc(event)}</LastChange>`);
  }

  /** ZoneGroupTopology puts its state straight in the property set. */
  notifyTopology(state) {
    this.zoneGroupState = state;
    return this.notify('/ZoneGroupTopology/Event', `<ZoneGroupState>${esc(state)}</ZoneGroupState>`);
  }
}
