# Konnect

Konnect is a browser-based group file sharing and chat app. GitHub Pages hosts the static frontend, and a Cloudflare Worker performs temporary WebRTC signaling, brokers TURN credentials, and maintains an aggregate page-load count. Room participants connect directly to the creator's browser, which relays chat and files to the group. Konnect has no accounts or file storage.

WebRTC data channels use DTLS encryption in transit. Konnect checks that each negotiated DTLS transport is connected before enabling chat or file sharing and fails closed if it cannot verify that state. The room creator's browser receives and can read all room messages and files before forwarding them. There is no plaintext fallback. The app does not store room messages or files.

## Publish on GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages** and set the source to **GitHub Actions**.
3. Ensure the repository has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets, as described in [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
4. Push to `main`. The workflow deploys the signaling Worker, configures its URL in the Pages artifact, then publishes the static site.
5. Open the published HTTPS URL in a recent browser.

HTTPS is needed for camera scanning and clipboard access. QR scanning uses a locally bundled decoder, including on iPhone Safari where the browser's built-in QR detector may not be available. Camera video is decoded in the browser and is not uploaded. If camera access is unavailable, paste the connection code instead.

## Signaling service

The Cloudflare Worker exchanges WebRTC offer/answer descriptions and obtains TURN ICE server details from Metered Open Relay. The creator selects a room limit from 2 to 20 people (including the creator); each person chooses a display name. The creator's browser makes a separate WebRTC connection to each participant and relays room chat and files. The Worker uses random 192-bit room IDs, restricts browser origins to `https://nguyentrucdn.github.io`, and expires room state after five minutes. The Worker does not proxy room chat or file data; TURN may relay the DTLS-encrypted WebRTC packets when direct routes fail. The Worker also increments a global page-load counter without storing visitor identities. The Worker URL is injected into the deployed static site by the GitHub Actions workflow. If you use a custom Pages domain, update `ALLOWED_ORIGINS` in `signal/wrangler.jsonc`.

The Worker uses a SQLite-backed Durable Object. Cloudflare's Free plan currently supports SQLite-backed Durable Objects; see [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). TURN credentials are fetched only by active room participants and requests are rate-limited per client IP. If TURN credentials are not configured, Konnect keeps its STUN-only behavior and warns that some networks may not connect.

To enable the free relay, sign up for [Metered Open Relay](https://dashboard.metered.ca/signup?tool=turnserver) and create a TURN credential. Its free plan currently includes 20 GB of TURN usage per month. In the Metered dashboard, copy the app name (the part before `.metered.live`) and the credential's API key (use **Show API Key** for that credential). Add these GitHub Actions repository secrets:

- `METERED_TURN_APP` — the app name only, without `.metered.live`
- `METERED_TURN_API_KEY` — the credential-scoped API key

The API key is stored as a Worker secret and never included in the static site. Push to `main` or run the Pages workflow after adding the secrets. The free quota is limited; connections that need TURN may stop working after the monthly allowance is reached. See [Open Relay](https://www.metered.ca/tools/openrelay/) and its [TURN credentials API](https://www.metered.ca/docs/turn-rest-api/get-credential/) for details. TURN relays ciphertext and connection metadata; WebRTC DTLS still encrypts the data channel, but a relay means data no longer travels only peer-to-peer.

## Connect

1. Everyone chooses a display name. The creator selects a maximum room size (2 by default), creates the room, and shares the QR code or invite link.
2. Participants scan the QR with their iPhone Camera (or another QR reader), choose a name, and join. The creator's browser connects each participant and relays room messages and files.
3. Once the encrypted connections are established, people in the room can chat or send files. The creator must remain connected for the room to work.

The invite link contains a random room ID in its URL fragment; the SDP offer is exchanged through the signaling service and is not placed in the URL. Fragments are not sent to the website server, and Konnect removes the fragment from the address bar after reading it. The app uses STUN for direct route discovery and Metered Open Relay as a fallback when configured. TURN traffic remains DTLS-encrypted.

The QR generator is [qrcode-generator 1.4.4](https://github.com/kazuhikoarase/qrcode-generator), by Kazuhiko Arase, distributed under the MIT license. Its copyright and license notice is included in the vendored source. QR scanning uses [jsQR 1.4.0](https://github.com/cozmo/jsQR), distributed under the Apache 2.0 license; its license is included in the vendored source.
