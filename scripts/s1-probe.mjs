// Drives S1Client against a fake S1 speaker and checks what comes out.
//
// Run: node scripts/s1-probe.mjs   (after `npm run build`)

import { createRequire } from 'node:module';
import { FakeSpeaker, didlTrack } from './fake-s1-speaker.mjs';

const require = createRequire(import.meta.url);
const { S1Client, PlayBackState, ContainerType, EventType } = require('../dist/index.js');

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${ok ? '' : `\n       got:      ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`}`);
};
const truthy = (name, actual) => check(name, Boolean(actual), true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KITCHEN = 'RINCON_000E58AAAA1401400';
const STUDY = 'RINCON_000E58BBBB1401400';
const BRIDGE = 'RINCON_000E58CCCC1401400';

function topology(kitchenPort, studyPort, { grouped = false } = {}) {
  const member = (uuid, name, port, extra = '') =>
    `<ZoneGroupMember UUID="${uuid}" Location="http://127.0.0.1:${port}/xml/device_description.xml" ` +
    `ZoneName="${name}" Icon="x-rincon-roomicon:kitchen" SoftwareVersion="56.0-76060" ${extra}/>`;
  if (grouped) {
    // Study is the coordinator; Kitchen joined it. A stereo pair shows up as a nested
    // <Satellite>, and the Bridge as an Invisible member — neither is a player.
    return (
      '<ZoneGroupState><ZoneGroups>' +
      `<ZoneGroup Coordinator="${STUDY}" ID="${STUDY}:9">` +
      `<ZoneGroupMember UUID="${STUDY}" Location="http://127.0.0.1:${studyPort}/xml/device_description.xml" ZoneName="Studeerkamer" SoftwareVersion="56.0-76060">` +
      `<Satellite UUID="${STUDY}:SAT" ZoneName="Studeerkamer" Invisible="1"/>` +
      '</ZoneGroupMember>' +
      member(KITCHEN, 'Keuken', kitchenPort) +
      member(BRIDGE, 'BRIDGE', kitchenPort, 'Invisible="1" IsZoneBridge="1"') +
      '</ZoneGroup>' +
      '</ZoneGroups></ZoneGroupState>'
    );
  }
  return (
    '<ZoneGroupState><ZoneGroups>' +
    `<ZoneGroup Coordinator="${KITCHEN}" ID="${KITCHEN}:2">${member(KITCHEN, 'Keuken', kitchenPort)}</ZoneGroup>` +
    `<ZoneGroup Coordinator="${STUDY}" ID="${STUDY}:9">${member(STUDY, 'Studeerkamer', studyPort)}</ZoneGroup>` +
    '</ZoneGroups></ZoneGroupState>'
  );
}

async function main() {
  const kitchen = new FakeSpeaker({ uuid: KITCHEN, roomName: 'Keuken' });
  const study = new FakeSpeaker({ uuid: STUDY, roomName: 'Studeerkamer' });
  const kitchenPort = await kitchen.listen();
  const studyPort = await study.listen();
  kitchen.zoneGroupState = topology(kitchenPort, studyPort);
  study.zoneGroupState = kitchen.zoneGroupState;

  // The speaker is already playing before we ever connect — the state has to come
  // from the initial reads, since events only ever report changes.
  kitchen.state.transportState = 'PLAYING';
  kitchen.state.trackUri = 'x-sonos-spotify:spotify%3atrack%3a123';
  kitchen.state.trackMetadata = didlTrack({
    title: 'Rock & Roll',
    artist: 'Led Zeppelin',
    album: 'Led Zeppelin IV',
    art: '/getaa?u=x-sonos-spotify%3a123&v=53',
    res: 'x-sonos-spotify:spotify%3atrack%3a123',
  });
  kitchen.state.relTime = '0:01:30';
  kitchen.state.volume = 42;

  const client = new S1Client('127.0.0.1', { port: kitchenPort, positionPollIntervalMs: 0 });
  const seen = [];
  client.subscribe((e) => seen.push(e.eventType));

  await client.connect();

  // ---- identity + topology ----
  check('player id comes from the UDN', client.playerId, KITCHEN);
  check('player name comes from roomName', client.player.name, 'Keuken');
  check('both zone groups parsed', client.groups.length, 2);
  const group = client.player.group;
  truthy('the player resolves to its own group', group);
  check('group id', group.id, `${KITCHEN}:2`);
  check('group name is the room name when alone', group.name, 'Keuken');
  check('group members', group.playerIds, [KITCHEN]);
  check('CONNECTED was signalled', seen.includes(EventType.CONNECTED), true);

  // ---- state primed before any event ----
  check('transport state read on connect', group.playbackState, PlayBackState.PLAYING);
  check('volume read on connect', group.volume, 42);
  check('mute read on connect', group.muted, false);
  check('position read on connect', Math.round(group.positionSeconds), 90);
  const primed = group.playbackMetadataStatus;
  check('title survives the escaping', primed.currentItem.track.name, 'Rock & Roll');
  check('artist', primed.currentItem.track.artist.name, 'Led Zeppelin');
  check('album', primed.currentItem.track.album.name, 'Led Zeppelin IV');
  check(
    'relative album art is resolved against the speaker',
    primed.currentItem.track.images[0].url,
    `http://127.0.0.1:${kitchenPort}/getaa?u=x-sonos-spotify%3a123&v=53`,
  );
  check('duration', primed.currentItem.track.durationMillis, 232000);
  check('active service inferred from the uri', group.activeService, '9');

  // ---- GENA: a track change arrives as a double-escaped DIDL attribute ----
  const pushed = await kitchen.notifyTransport({
    TransportState: 'PAUSED_PLAYBACK',
    CurrentTrackURI: 'x-sonosapi-stream:s6712?sid=254',
    CurrentTrackMetaData: didlTrack({
      title: 'NPO Radio 2',
      art: 'http://cdn.example/logo.png',
      upnpClass: 'object.item.audioItem.audioBroadcast',
      streamContent: 'Fleetwood Mac - Dreams',
    }),
    'r:EnqueuedTransportURI': 'x-sonosapi-stream:s6712?sid=254',
    'r:EnqueuedTransportURIMetaData': didlTrack({ title: 'NPO Radio 2', upnpClass: 'object.item.audioItem.audioBroadcast' }),
  });
  check('the AVTransport subscription received the NOTIFY', pushed, 1);
  await sleep(150);

  check('transport state follows the event', group.playbackState, PlayBackState.PAUSED);
  const radio = group.playbackMetadataStatus;
  check('station title', radio.currentItem.track.name, 'NPO Radio 2');
  check('radio now-playing comes from r:streamContent', radio.streamInfo, 'Fleetwood Mac - Dreams');
  check('absolute album art is left alone', radio.currentItem.track.images[0].url, 'http://cdn.example/logo.png');
  check('container type from the stream uri', group.containerType, ContainerType.STATION);
  check('container name from the enqueued metadata', radio.container.name, 'NPO Radio 2');
  check('active service is TuneIn', group.activeService, '303');

  // ---- GENA: volume and mute ----
  await kitchen.notifyRendering({ volume: 17, mute: true });
  await sleep(150);
  check('volume follows the event', group.volume, 17);
  check('mute follows the event', group.muted, true);

  // ---- GENA: a group reshuffle ----
  await kitchen.notifyTopology(topology(kitchenPort, studyPort, { grouped: true }));
  await sleep(200);
  check('the two groups collapsed into one', client.groups.length, 1);
  const joined = client.player.group;
  check('joined group id', joined.id, `${STUDY}:9`);
  check('coordinator moved to the study', joined.coordinatorId, STUDY);
  check('bridge and satellite are not members', joined.playerIds, [STUDY, KITCHEN]);
  check('group name counts the joined rooms', joined.name, 'Studeerkamer + 1');
  check('player is now passive', client.player.isPassive, true);

  // ---- commands go to the coordinator, not to us ----
  study.calls.length = 0;
  kitchen.calls.length = 0;
  await joined.play();
  check('Play reached the coordinator', study.calls.map((c) => c.action), ['Play']);
  check('Play did not go to the joined member', kitchen.calls.length, 0);
  check('Play carried the Speed argument', study.calls[0].body.includes('<Speed>1</Speed>'), true);
  check('Play went to the AVTransport control url', study.calls[0].url, '/MediaRenderer/AVTransport/Control');

  // togglePlayPause has to pick its command from the current state
  study.calls.length = 0;
  await kitchen.notifyTransport({ TransportState: 'PLAYING' });
  await sleep(150);
  await joined.togglePlayPause();
  check('toggle pauses while playing', study.calls.map((c) => c.action), ['Pause']);
  study.calls.length = 0;
  await kitchen.notifyTransport({ TransportState: 'STOPPED' });
  await sleep(150);
  await joined.togglePlayPause();
  check('toggle plays while stopped', study.calls.map((c) => c.action), ['Play']);

  study.calls.length = 0;
  await joined.skipToNextTrack();
  await joined.skipToPreviousTrack();
  await joined.stop();
  check('skip/stop reach the coordinator', study.calls.map((c) => c.action), ['Next', 'Previous', 'Stop']);

  // ---- teardown ----
  await client.disconnect();
  check('DISCONNECTED was signalled', seen.includes(EventType.DISCONNECTED), true);
  await sleep(100);
  check('subscriptions were cancelled', kitchen.subscriptions.size, 0);

  kitchen.close();
  study.close();

  console.log(`\n# ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
