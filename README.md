# PeerDrop Fileshare

A small `React + Vite` PWA for **direct browser-to-browser file sharing** with:

- **WebRTC data channels** for the actual file transfer
- **short room links** via a tiny Cloudflare Worker signaling service
- optional **manual QR fallback** when no signaling URL is configured
- repeated sends in both directions after one successful pairing

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev:host
```

Then set `VITE_SIGNALING_URL` in `.env.local` to your deployed Cloudflare Worker URL.

> Use `dev:host` so a phone or second laptop on the same LAN can open the app.

## Pairing flow with the signaling worker

1. Open the app on **device A** and tap **Create room**.
2. A short QR code and **room code** are generated.
3. On **device B**, open that room link or type the room code.
4. The Cloudflare Worker exchanges the WebRTC offer/answer automatically.
5. Once the direct connection opens, both devices can keep sending files in the same session.

## Cloudflare Worker setup

This repo includes a starter worker in `cloudflare/worker.js` and a sample `wrangler.toml`.

### Deploy it

```bash
npm install
npx wrangler login
npx wrangler deploy
```

After deployment, copy the worker URL and set:

```bash
VITE_SIGNALING_URL=https://your-worker-subdomain.workers.dev
```

## GitHub Pages deployment

The GitHub Actions workflow now deploys the Cloudflare Worker automatically before building the site.

### Required secret

- `CLOUDFLARE_TOKEN` — API token with permission to deploy Workers

### Optional variable if Cloudflare asks for it

- `CLOUDFLARE_ACCOUNT_ID` — only needed if Wrangler reports that no account ID was found

Keep **Pages → Source = GitHub Actions** enabled.

## Important note

The worker is only used for **signaling**. The actual file bytes still go directly over **WebRTC P2P**.

A TURN relay is still not configured, so very restrictive networks may block direct peer connectivity.
