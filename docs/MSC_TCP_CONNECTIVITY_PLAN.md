# MSC Service-Free TCP Translator Plan

## Objective

Allow a Minecraft Java server hosted by the Android or desktop application to
reach remote players without operating a project relay and without depending
on Playit, Cloudflare, Tailscale, or another tunnel service.

The translator is a clean-room implementation based on public networking
standards. It carries Minecraft's TCP byte stream unchanged; it does not copy a
third-party protocol and does not need version-specific Minecraft packet logic.

Technical basis:

- QUIC transport: RFC 9000 — <https://www.rfc-editor.org/rfc/rfc9000>
- TLS 1.3 fallback transport: RFC 8446 — <https://www.rfc-editor.org/rfc/rfc8446>
- ICE connectivity checks: RFC 8445 — <https://www.rfc-editor.org/rfc/rfc8445>
- Port Control Protocol: RFC 6887 — <https://www.rfc-editor.org/rfc/rfc6887>
- NAT-PMP: RFC 6886 — <https://www.rfc-editor.org/rfc/rfc6886>

## Honest feasibility boundary

A phone behind CGNAT cannot accept an unsolicited connection from an ordinary
remote Minecraft client. A service-free design is possible only by placing a
small MSC Connect translator on the player's PC and reversing the connection:
the CGNAT host phone dials outward to the player's reachable translator.

```text
Minecraft client on player PC
        -> 127.0.0.1:<local-port>
        -> MSC Connect translator
        <- encrypted QUIC or direct TLS/TCP connection initiated by host
        <- Android connector
        <- 127.0.0.1:<minecraft-server-port>
```

This works at zero infrastructure cost when at least one side has a usable
direct path. In the intended mobile-host flow, the player's PC must obtain one
of these:

1. a reachable global IPv6 address and firewall permission;
2. a public/easy-NAT UDP or TCP mapping through PCP, NAT-PMP, or UPnP;
3. a manually forwarded UDP or TCP port on a public IPv4 connection; or
4. a successful peer-to-peer UDP traversal using endpoints exchanged by the
   users.

If the phone and player are both behind hard/symmetric CGNAT with no reachable
IPv6 or mapped port, a direct path is mathematically unavailable. A third
reachable machine is then required. The application must report this honestly
instead of claiming a guaranteed CGNAT bypass.

## No-service rendezvous

The core mode will not require a hosted signaling, STUN, TURN, account, or
relay service. Pairing data is exchanged out of band by the users as a short
text code, QR code, or file.

### Pairing flow

1. The host app creates a long-lived device identity key and a short-lived
   server invitation containing only its public identity and session nonce.
2. The player opens MSC Connect. It binds a loopback TCP port for Minecraft,
   plus QUIC/UDP and TLS/TCP direct listeners.
3. MSC Connect attempts IPv6 reachability and PCP/NAT-PMP/UPnP mapping. It can
   also accept a manually configured public endpoint.
4. MSC Connect creates a one-time **Join Offer** containing its reachable
   candidates, public key, target server identity, nonce, and expiry.
5. The player sends the Join Offer to the host through any existing channel or
   displays it as a QR code.
6. The host imports the offer and tries QUIC candidates first, followed by a
   direct TLS/TCP candidate if UDP is unavailable.
7. After mutual key verification, the peers open a bidirectional byte stream.
8. The player connects Minecraft to the loopback address shown by MSC Connect.
9. MSC Connect copies that TCP byte stream into QUIC; the Android connector
   copies it to the local Minecraft server port.

Each player has an independent connection and Join Offer. This avoids a public
lobby and prevents one player device from becoming an unintended relay for
others.

## Repository and product boundary

This is a cross-platform feature even though the current worktree is focused on
mobile development.

Recommended component layout:

```text
apps/
  mobile/              Android host integration
  desktop/             Stable PC product; do not modify first
  connect/             New lightweight player translator
packages/
  connectivity-protocol/  Messages, validation, test vectors
native/
  connectivity-core/   Shared Rust QUIC and cryptographic core
```

The first PC work should be a standalone `MSC Connect` companion. It must not
change the stable desktop application's existing hosting behavior. After the
protocol passes real-network tests, the same core can be integrated into the PC
version so a PC can act as either host connector or player translator.

Recommended implementation split:

- Rust shared core for QUIC, direct TLS/TCP fallback, identity, candidate
  checks, framing, bounded streaming, and Windows/Android portability;
- a small desktop shell for status, pairing codes, firewall/port-mapping help,
  and the loopback Minecraft address;
- JNI bindings for the Android foreground hosting service;
- TypeScript types generated from or validated against the versioned protocol.

## Phase 22A — Direct-path feasibility spike

Before building product UI, prove the unusual reversed topology on real
networks.

Prototype requirements:

- PC opens QUIC/UDP and direct TLS/TCP listeners plus one loopback TCP listener;
- PC obtains a reachable endpoint using IPv6, UPnP/PCP/NAT-PMP, or a manual
  router forward;
- endpoint and one-time secret are copied manually to the Android prototype;
- Android on mobile data initiates QUIC to the PC and separately proves the
  direct TLS/TCP fallback;
- arbitrary TCP bytes pass from a PC loopback test client through each direct
  transport to an Android loopback echo server;
- connection survives at least 30 minutes and transfers bounded test data;
- no Playit, Tailscale, Cloudflare, public STUN, signaling, or relay is used.

Gate: if the mobile-data phone cannot reach a correctly mapped public/easy-NAT
PC, diagnose the transport or firewall before implementing Minecraft UX. Do not
proceed based only on emulator or same-LAN success.

### Implementation tracking

The first feasibility harness is implemented with the direct TLS 1.3/TCP
fallback transport:

- a standalone Node-based PC listener creates a persistent local identity,
  prints a one-time token and certificate SHA-256 fingerprint, and echoes
  bounded authenticated binary frames;
- an isolated Android foreground service pins that certificate, authenticates
  the token, performs 65,537-byte echo probes, records RTT/byte/reconnect
  counters, and keeps running when the Capacitor UI is backgrounded;
- the Connectivity screen starts/stops the test and reads its file-backed
  cross-process status;
- the harness never opens a Minecraft destination or generic proxy.

Automated listener, Android protocol, mobile build, APK packaging, and desktop
regression validation pass. A real LAN test followed by a mobile-data-to-mapped-
PC test is still required because no Android device is currently connected.
The QUIC half remains Phase 22A work and will use the shared Rust core; it is not
being represented by a non-QUIC UDP probe.

## Phase 22B — Versioned translator protocol

Define and test:

- protocol version negotiation;
- host invitation and player Join Offer formats;
- candidate types and priorities;
- Ed25519 or equivalent device identity;
- ephemeral session key agreement;
- one-time nonce and expiry validation;
- replay rejection;
- explicit user consent for every player;
- stream open/close and structured failure reasons;
- heartbeats, migration, reconnect, and re-pair behavior;
- maximum frame, buffer, stream, and connection limits.

Pairing codes must be authenticated and compact enough for QR/text transfer.
Private keys never enter React storage or exported logs.

## Phase 22C — Standalone PC translator

Build `MSC Connect` before changing the stable desktop application.

Required behavior:

- Windows first, then Linux/macOS where practical;
- listen only on `127.0.0.1` for the Minecraft client;
- show `localhost:<port>` for the player's server list;
- detect global IPv6;
- attempt PCP, NAT-PMP, and UPnP mapping for supported direct transports;
- guide manual UDP/TCP port forwarding when automatic mapping fails;
- request the minimum Windows Firewall permission required;
- generate/copy/share Join Offers;
- verify the expected host fingerprint before forwarding traffic;
- display direct-path status, latency, bytes, and actionable errors;
- never operate as a generic proxy or forward arbitrary destinations.

## Phase 22D — Android host connector

Integrate the shared core with the existing isolated foreground hosting
service.

Required behavior:

- connect only to the selected server's loopback port;
- import and approve one-time player Join Offers;
- initiate all Internet connections outward from Android;
- maintain one independent QUIC or direct TLS/TCP connection per approved
  player;
- survive UI backgrounding and screen-off operation;
- handle Wi-Fi/mobile-data changes with QUIC connection migration or a clear
  re-pair/reconnect path;
- stop accepting streams while Minecraft is stopping;
- publish connection status through the existing file-backed state bridge;
- revoke a player and erase expired offers;
- never expose the Capacitor bridge or management UI.

## Phase 22E — Product integration and PC host support

After the standalone translator and Android connector work on real networks:

- add Direct Translator controls to the mobile Connectivity screen;
- add player approval, revoke, connection health, and troubleshooting UI;
- integrate the same core into the PC version on a separate feature branch;
- allow the PC version to choose Host mode or Player Translator mode;
- keep LAN and direct IPv6 modes available;
- make the standalone companion downloadable for players who do not need the
  full server customizer.

## Phase 22F — Optional reachability extensions

These are optional and outside the no-service completion gate:

- user-configured STUN server for easier candidate discovery;
- user-owned peer relay for cases where both sides have hard CGNAT;
- community relays with explicit trust and abuse controls;
- provider adapters only when the user deliberately chooses them.

The application will not operate a mandatory first-party relay as part of the
service-free translator goal.

## Security requirements

- mutually authenticated encrypted QUIC with direct TLS 1.3 fallback;
- one-time, expiring Join Offers bound to one host identity;
- replay protection and explicit host approval;
- loopback-only Minecraft listener on the player PC;
- fixed Android destination of the selected Minecraft server port;
- no arbitrary host/port proxying;
- bounded buffers and backpressure in both directions;
- connection and retry rate limits;
- no packet payload retention in logs;
- clear device removal and key reset workflow;
- fuzz tests for pairing-code and frame parsers.

## Test matrix

Required networks:

- Android host on Philippine mobile data, PC player on public/easy home IPv4;
- Android host on mobile data, PC player on global IPv6;
- Android host on Wi-Fi CGNAT, PC player with manual UDP port forward;
- both sides behind hard CGNAT, expected to fail with an honest diagnostic;
- PC and Android on the same LAN;
- two players with independent direct connections;
- screen off, UI backgrounded, and Wi-Fi/mobile-data transition;
- packet loss, temporary disconnection, replayed offer, wrong fingerprint, and
  expired offer.

## Completion gates

The no-service translator milestone is complete only when:

- a Minecraft client connects to the PC companion through `localhost`;
- the companion carries the unchanged TCP stream over authenticated QUIC or
  direct TLS/TCP;
- a CGNAT Android phone initiates the connection to the player's reachable PC;
- the stream reaches a real Minecraft server on Android;
- at least two players work through independent direct paths;
- no project or third-party signaling, STUN, tunnel, or relay service is used;
- backgrounding the mobile UI does not drop established sessions;
- failure on hard-CGNAT-to-hard-CGNAT networks is detected and explained;
- secrets never appear in the web bundle, pairing logs, or exported console;
- the stable desktop application's existing behavior remains unchanged until
  its separate integration phase.
