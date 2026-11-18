# Konnect

Konnect is a browser-based peer-to-peer file sharing and chat app. GitHub Pages hosts the static frontend, and a small Cloudflare Worker performs temporary WebRTC signaling. Files and chat use a direct WebRTC data channel; Konnect has no accounts or file storage.

WebRTC data channels use DTLS encryption in transit. Konnect checks that the negotiated DTLS transport is connected before enabling chat or file sharing and fails closed if it cannot verify that state. There is no plaintext fallback. The browsers handle key negotiation; the app does not store or separately encrypt data.

## Publish on GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set the source to **GitHub Actions**.
3. Ensure the repository has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets, as described in [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
4. Push to `main`. The workflow deploys the signaling Worker, configures its URL in the Pages artifact, then publishes the static site.
5. Open the published HTTPS URL in a recent browser.

HTTPS is needed for camera scanning and clipboard access. QR scanning uses a locally bundled decoder, including on iPhone Safari where the browser's built-in QR detector may not be available. Camera video is decoded in the browser and is not uploaded. If camera access is unavailable, paste the connection code instead.

## Signaling service

The Cloudflare Worker exchanges only WebRTC offer/answer descriptions. It accepts a maximum of two peers per room, uses random 192-bit room IDs, restricts browser origins to `https://nguyentrucdn.github.io`, and expires room state after five minutes. It does not carry chat messages or file data. The Worker URL is injected into the deployed static site by the GitHub Actions workflow. If you use a custom Pages domain, update `ALLOWED_ORIGINS` in `signal/wrangler.jsonc`.

The Worker uses a SQLite-backed Durable Object. Cloudflare's Free plan currently supports SQLite-backed Durable Objects; see [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). The signaling endpoint is public, so treat invite links as temporary bearer tokens and share them only with the intended peer. The signaling service handles connection metadata and could theoretically substitute descriptions; DTLS encrypts the data channel but does not independently authenticate the peer.

## Connect

1. One person selects **Create room** and shares the displayed QR code or invite link.
2. The other person scans the QR with their iPhone Camera (or another QR reader). The invite opens Konnect and automatically exchanges the WebRTC signaling data.
3. Once the direct connection is established, either person can chat or send files.

The invite link contains a random room ID in its URL fragment; the SDP offer is exchanged through the signaling service and is not placed in the URL. Fragments are not sent to the website server, and Konnect removes the fragment from the address bar after reading it. The app uses Google's public STUN service to help browsers discover a direct network route; the signaling Worker does not relay file or chat data. Some firewalls and networks block direct WebRTC connections, in which case a connection may not be possible.

The QR generator is [qrcode-generator 1.4.4](https://github.com/kazuhikoarase/qrcode-generator), by Kazuhiko Arase, distributed under the MIT license. Its copyright and license notice is included in the vendored source. QR scanning uses [jsQR 1.4.0](https://github.com/cozmo/jsQR), distributed under the Apache 2.0 license; its license is included in the vendored source.
