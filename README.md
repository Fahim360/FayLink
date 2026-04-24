# FayLink

FayLink is a phone-buildable Android app for direct WebRTC chat and voice.

It is designed around this rule:

```text
Relay/signaling is only for finding the other device.
After WebRTC connects, chat and voice go directly device-to-device when the network allows it.
```

## What works in v1

- Android app, no PC required if you build with GitHub Actions.
- Manual signaling mode with no server at all.
- Optional WebSocket signaling relay mode.
- WebRTC direct chat and voice.
- App-level E2EE for text chat using P-256 ECDH + AES-GCM.
- Safety code to compare with the other phone.
- Voice is WebRTC encrypted in transit and does not pass through the signaling relay.

## Honest limits

- If both phones are behind strict NAT/CGNAT, direct WebRTC may fail.
- If direct WebRTC fails and you refuse media relay/TURN, voice calls cannot happen.
- Manual mode needs you to copy/paste offer and answer once.
- Optional relay mode needs a WebSocket relay URL.
- This is not yet a Signal/WhatsApp replacement. It is a working direct-P2P app foundation.

## Build APK on your phone using GitHub Actions

1. Create a GitHub account.
2. Create a new repository named `FayLink`.
3. Upload this whole project to the repository.
4. Open the repository on GitHub.
5. Go to **Actions**.
6. Open **Build FayLink APK**.
7. Tap **Run workflow**.
8. Wait until it finishes.
9. Open the finished workflow run.
10. Download the artifact named **FayLink-debug-apk**.
11. Extract it and install `app-debug.apk` on your Android phone.

Android will warn you because it is not from Play Store. That is normal for your own debug APK.

## How to use manual mode

Manual mode needs no relay/server.

### Phone A

1. Open FayLink.
2. Optional: tick **Enable voice before connecting**.
3. Tap **Host manual**.
4. Copy the generated signal and send it to Phone B.

### Phone B

1. Open FayLink.
2. Optional: tick **Enable voice before connecting**.
3. Paste Phone A's signal.
4. Tap **Join manual** or **Apply pasted signal**.
5. Copy the answer signal and send it back to Phone A.

### Phone A again

1. Paste Phone B's answer.
2. Tap **Apply pasted signal**.
3. Wait for **Direct P2P connected**.

## How to use relay mode

Relay mode only passes the WebRTC offer/answer. It does not carry your messages or voice.

1. Put the same **Room ID** on both phones.
2. Put the same relay URL on both phones, for example `wss://your-relay.example.com`.
3. Phone A taps **Host using relay**.
4. Phone B taps **Join using relay**.
5. Wait for **Direct P2P connected**.

## Optional relay server

The folder `relay-server/` contains a tiny Node.js WebSocket relay. It only forwards signaling JSON between room members.

Run it on any server that can expose WebSocket traffic:

```bash
cd relay-server
npm install
npm start
```

Then use:

```text
ws://SERVER_IP:8080
```

or, if you host with TLS:

```text
wss://your-domain.example.com
```

## For Bangladesh-only/local ISP networks

If the global internet is down but local ISP routing still works:

- Put the signaling relay inside Bangladesh or inside the ISP network.
- Use a local STUN server if available.
- If both phones are on the same Wi-Fi/LAN, clear the ICE/STUN field and try manual mode.

## Security notes

The relay can see temporary signaling metadata like room ID and WebRTC connection candidates. It should not see your chat content. Text messages are encrypted again inside the WebRTC data channel using keys derived directly between the two devices.

Always compare the safety code after connecting. If the safety code is different on the two phones, disconnect.
