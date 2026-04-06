# PeerDrop Fileshare

A small `React + Vite` PWA for **browser-only file sharing** with:

- **WebRTC data channels** for direct file transfer
- **QR-based manual signaling** for serverless pairing
- repeated sends in both directions after one successful pairing

## Run locally

```bash
npm install
npm run dev:host
```

> Use `dev:host` so a phone or second laptop on the same LAN can open the app.

## Pairing flow

1. Open the app on **device A** and tap **Create invite**.
2. Scan the invite QR on **device B**. It opens the same app with the WebRTC offer in the URL.
3. Device B generates an **answer QR**.
4. On device A, either:
   - use **Scan answer QR** inside the app, or
   - paste the answer code manually.
5. After the direct connection opens, both devices can send files as many times as they want during the session.

## Important limitation

This app intentionally uses **no TURN relay** and no backend signaling server. That means:

- it works best on the **same LAN** or on permissive NAT setups
- some restrictive networks may still block direct peer connectivity
- Chromium-based browsers currently give the best results for QR scanning and WebRTC behavior

## Deploy

Because the app is static, it can be hosted on:

- GitHub Pages
- Netlify
- Vercel
- any static web server

Once deployed, the invite QR will point to the hosted app URL with the compressed pairing offer attached.
