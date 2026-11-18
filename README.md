# Konnect

Konnect is a static, browser-based peer-to-peer file sharing and chat app. It can be hosted on GitHub Pages; it has no application backend, accounts, or file storage. The WebRTC data channel sends files and messages directly between connected browsers.

WebRTC data channels use DTLS encryption in transit. Konnect checks that the negotiated DTLS transport is connected before enabling chat or file sharing and fails closed if it cannot verify that state. There is no plaintext fallback. The browsers handle key negotiation; the app does not store or separately encrypt data.

## Publish on GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages**.
3. Choose **Deploy from a branch**, select `main` and the `/ (root)` folder, then save.
4. Open the published HTTPS URL in a recent browser.

HTTPS is needed for camera scanning and clipboard access. QR scanning uses a locally bundled decoder, including on iPhone Safari where the browser's built-in QR detector may not be available. Camera video is decoded in the browser and is not uploaded. If camera access is unavailable, paste the connection code instead.

## Connect

1. One person selects **Create room** and shares the displayed QR code or code.
2. The other person scans it or pastes it under **Join a room**. They then share the reply QR code or code back.
3. The room creator scans or pastes that reply code. Once connected, either person can chat or send files.

Connection codes are temporary WebRTC signaling data. They contain network connection details, so share them privately and only with a trusted peer using a trusted channel. DTLS protects data in transit, but someone who can replace the exchanged codes could attempt to intercept the connection. The app uses Google's public STUN service to help browsers discover a direct network route; it does not relay file or chat data. Some firewalls and networks block direct WebRTC connections, in which case a connection may not be possible.

The QR generator is [qrcode-generator 1.4.4](https://github.com/kazuhikoarase/qrcode-generator), by Kazuhiko Arase, distributed under the MIT license. Its copyright and license notice is included in the vendored source. QR scanning uses [jsQR 1.4.0](https://github.com/cozmo/jsQR), distributed under the Apache 2.0 license; its license is included in the vendored source.
