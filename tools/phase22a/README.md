# Phase 22A PC Test Listener

This listener is a temporary feasibility tool, not the final MSC Connect
application. It lets the Android app prove that a CGNAT phone can initiate a
certificate-pinned TLS 1.3 connection to a reachable PC and exchange bounded
binary frames while the phone UI is backgrounded.

## Start the listener

From the repository root:

```powershell
node tools/phase22a/msc-direct-listener.mjs --port 44333
```

The first run uses the active JDK's `keytool` to create a local test identity in
`%USERPROFILE%\.msc-phase22a`. It prints:

- the listening port;
- a random one-time test token;
- the SHA-256 certificate fingerprint expected by the phone.

Copy those values into **More > Connectivity > Direct transport lab**. Keep the
listener window open during the test.

## Network test order

1. Run the first test on the same LAN using the PC's LAN IPv4 address.
2. Allow the listener through Windows Firewall for the intended network only.
3. For the real service-free CGNAT test, map TCP port `44333` on the player's
   router to the PC and enter that connection's public IPv4 address on the
   phone while the phone uses mobile data.
4. Run a 30-minute test, background the mobile UI, turn the screen off, and
   return to inspect probe/reconnect counters.

If the player's broadband connection is also behind carrier-grade NAT, a router
mapping will not make it public. That expected topology failure is distinct from
an Android transport failure.

## Automated listener test

```powershell
node --test tools/phase22a/msc-direct-listener.test.mjs
```

The test creates an isolated temporary PKCS#12 identity, negotiates TLS 1.3,
checks its fingerprint, verifies token rejection, and echoes a 65,537-byte
binary frame.
