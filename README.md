# Konnect

Konnect is a browser-based file sharing and chat app. GitHub Pages hosts the static frontend, and a Cloudflare Worker performs temporary WebRTC signaling and issues short-lived TURN credentials. Files and chat use an encrypted WebRTC data channel, sent directly when possible or through a TURN relay when the network blocks a direct route. Konnect has no accounts or file storage.

WebRTC data channels use DTLS encryption in transit. Konnect checks that the negotiated DTLS transport is connected before enabling chat or file sharing and fails closed if it cannot verify that state. There is no plaintext fallback. The browsers handle key negotiation; the app does not store or separately encrypt data.

## Publish on GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set the source to **GitHub Actions**.
3. Ensure the repository has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets, as described in [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
4. Push to `main`. The workflow deploys the signaling Worker, configures its URL in the Pages artifact, then publishes the static site.
5. Open the published HTTPS URL in a recent browser.

HTTPS is needed for camera scanning and clipboard access. QR scanning uses a locally bundled decoder, including on iPhone Safari where the browser's built-in QR detector may not be available. Camera video is decoded in the browser and is not uploaded. If camera access is unavailable, paste the connection code instead.

## Signaling service

The Cloudflare Worker exchanges WebRTC offer/answer descriptions and brokers short-lived Cloudflare TURN credentials for peers already connected to a room. It accepts a maximum of two peers per room, uses random 192-bit room IDs, restricts browser origins to `https://nguyentrucdn.github.io`, and expires room state after five minutes. It does not carry chat messages or file data; the separate TURN service may relay encrypted WebRTC packets when direct ICE candidates fail. The Worker URL is injected into the deployed static site by the GitHub Actions workflow. If you use a custom Pages domain, update `ALLOWED_ORIGINS` in `signal/wrangler.jsonc`.

The Worker uses a SQLite-backed Durable Object. Cloudflare's Free plan currently supports SQLite-backed Durable Objects; see [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). TURN credentials last ten minutes, are requested only by active room participants, and are rate-limited per client IP. If TURN credentials are not configured, Konnect keeps its STUN-only behavior and warns that some networks may not connect.

To enable TURN, create a Cloudflare Realtime TURN key from **Cloudflare Dashboard → Realtime → TURN**. The key has a `uid` and a `secret` (Bearer token). Add these GitHub Actions repository secrets:

- `CLOUDFLARE_TURN_KEY_ID` — the TURN key's `uid`
- `CLOUDFLARE_TURN_KEY_SECRET` — the TURN key's `secret`

Do not use the existing `CLOUDFLARE_API_TOKEN` deployment token here. Push to `main` or run the Pages workflow after adding the secrets. The workflow stores the TURN key secret as a Worker secret; it is never included in the static site. Cloudflare currently charges `$0.05` per real-time GB outbound for TURN used without its Realtime SFU. See [Cloudflare TURN documentation](https://developers.cloudflare.com/realtime/turn/) and [credential setup](https://developers.cloudflare.com/realtime/turn/generate-credentials/) for details. TURN relays ciphertext and connection metadata; WebRTC DTLS still encrypts the data channel, but a relay means data no longer travels only peer-to-peer.

## Connect

1. One person selects **Create room** and shares the displayed QR code or invite link.
2. The other person scans the QR with their iPhone Camera (or another QR reader). The invite opens Konnect and automatically exchanges the WebRTC signaling data.
3. Once the encrypted connection is established, either person can chat or send files.

The invite link contains a random room ID in its URL fragment; the SDP offer is exchanged through the signaling service and is not placed in the URL. Fragments are not sent to the website server, and Konnect removes the fragment from the address bar after reading it. The app uses STUN for direct route discovery and Cloudflare TURN as a relay fallback when configured. TURN traffic remains DTLS-encrypted.

The QR generator is [qrcode-generator 1.4.4](https://github.com/kazuhikoarase/qrcode-generator), by Kazuhiko Arase, distributed under the MIT license. Its copyright and license notice is included in the vendored source. QR scanning uses [jsQR 1.4.0](https://github.com/cozmo/jsQR), distributed under the Apache 2.0 license; its license is included in the vendored source.
