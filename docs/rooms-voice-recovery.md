# Room voice recovery

Desktop and browser guests use the same bounded ICE recovery policy. Recovery applies to an existing voice call; it never joins voice, requests a microphone while idle, or starts a room engine by itself.

## Connection policy

- Initial negotiation and each restarted attempt have a 20-second deadline.
- A disconnected link gets 5 seconds to recover before restarting ICE.
- At most three automatic ICE restarts run, after delays of 1, 3 and 8 seconds, with up to 250 ms of random spread. Repeated failure notifications and remote presence/signaling do not replenish the budget.
- A connection that stays healthy for 30 seconds replenishes its budget. Brief connection flaps do not.
- When the budget is exhausted, the participant stays visible with a failed connection state. The user can retry from the voice panel; repeated clicks are limited to one restart per second.
- A local browser `online` event retries an active call, at most once per link every 30 seconds. A VPN/interface change that does not emit this event must be detected by ICE or retried explicitly.

The existing RTCPeerConnection is kept during an ICE restart. Microphone processing, screen tracks, output device, volume, local mute, mute/deafen and push-to-talk state are retained. Incoming negotiation may restore a failed link, but cannot reset its spent automatic budget. Connected state is reconciled after SDP negotiation and at the deadline: a successful ICE restart may keep the native connection in `connected` without emitting another connection-state event.

Leave, kick, room teardown and the VPN kill-switch close peers and cancel recovery timers. Late asynchronous SDP/media work cannot answer after leave or attach a microphone captured for an earlier call. Releasing the kill-switch does not automatically join voice again.

## Microphone and output devices

The desktop client recaptures an ended input, switches the system-default input after a device change, and retries a preferred device that previously fell back to the default. Capture work is serialized; a device update received during capture is applied afterward. Output settings are reapplied after device changes.

Browser guests follow the default input. Device events are coalesced for 300 ms; a change arriving during capture schedules one further check. A removed microphone is shown explicitly and can be retried. Both clients gate a replacement microphone before attaching it to senders, preserving mute/deafen/PTT. Desktop recapture replaces the microphone sender without replacing a screen-audio sender. A failed recapture does not discard a still-working microphone.

## Automated verification

~~~powershell
npx vitest run shared/room-voice-recovery.test.ts electron/sharing/room-voice-recovery.test.ts electron/sharing/room-voice-capture.test.ts guest/voice-policy.test.ts electron/sharing/room-manager.test.ts --maxWorkers=2
npm run build:electron
node scripts/smoke-room-voice.cjs
node scripts/smoke-room-lifecycle.cjs
~~~

The voice smoke runs the actual desktop and guest voice classes in two isolated Electron renderers with synthetic microphones and local ICE. These test windows explicitly use default_public_and_private_interfaces so host candidates do not depend on the default IP-exposure policy; production policy is unchanged. Initial host gathering with the default policy was intermittent on this test host, including after separating renderers. Two consecutive runs with the explicit local policy passed; this does not establish recovery under the default policy on a physical browser/VPN. It checks initial connection, simultaneous ICE restarts, changed ICE credentials, retained peers/tracks and mute/deafen, local recovery, and teardown. The signaling transport is local IPC instead of encrypted room gossip. It uses temporary profiles and does not join user rooms or contact trackers/STUN/TURN. Failure output includes state metadata, without SDP, addresses or room secrets.

Unit tests cover exhausted budgets, interrupted first negotiation, flapping, device changes during capture, late capture/SDP after leave, microphone recovery, screen-audio separation, and interleaved ICE while an SDP answer is pending. The native test does not establish physical hotplug, cross-machine audibility, sleep/resume, real VPN/NAT/TURN behavior, or screen capture with system sound; use [testing-rooms.md](D:/reps/Havvn/Havvn/docs/testing-rooms.md) for those checks. The browser guest bundle must be published separately after its local build.

## References

The implementation follows the WebRTC [ICE restart API](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce) and [perfect negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation). A restart renegotiates ICE; it cannot make a blocked route or unavailable TURN server reachable.
