# Aviation Live Traffic V1.1 — Cloudflare

This release fixes the two problems seen in the first live deployment.

## Changes

1. The backend now tries three free aircraft-data sources in order:
   - ADSB.lol
   - airplanes.live
   - adsb.fi

   If one provider is temporarily unavailable or rejects the Cloudflare request, the next provider is tried automatically.

2. The map now uses CARTO's dark OpenStreetMap-based tiles instead of the original OpenStreetMap tile server.

3. Added `/api/health` so we can verify that the Cloudflare Worker itself is running.

4. The status indicator now shows which aircraft provider is currently supplying traffic.

## Updating the existing deployment

You do NOT need to make another Cloudflare project.

Replace the files in your existing GitHub repository with the files from this V1.1 folder.

Cloudflare's Git integration should detect the new commit automatically and redeploy the same workers.dev URL.

The key files changed are:

- `worker.js`
- `public/app.js`
- `README.md`

## Default area

Alpena / KAPN, 100 NM.

## Safety

This is a home/office/hangar enthusiast display only.
