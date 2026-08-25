# Aviation Live Traffic — Cloudflare Version

This version is designed so the computer displaying the app does **not** need Node.js or administrator rights.

## Architecture

Browser / iPad / TV
→ Cloudflare Worker
→ ADSB.lol
→ live aircraft data

Cloudflare also serves the HTML, CSS and JavaScript in the `public` folder.

## Recommended deployment method when you cannot install software

Use GitHub + Cloudflare's web dashboards:

1. Create a free GitHub repository.
2. Upload all files from this project to that repository using GitHub's browser upload.
3. In Cloudflare, create a Workers project connected to that GitHub repository.
4. Set the deploy command to:

       npx wrangler deploy

5. Cloudflare's build system installs Wrangler and deploys the project for you. Nothing needs to be installed on your work computer.
6. Cloudflare will give you a public `*.workers.dev` URL.
7. Open that URL on your iPad, TV browser, office computer, or hangar display.

## Files

- `worker.js` — serverless ADS-B proxy.
- `wrangler.jsonc` — Cloudflare Worker/static-assets configuration.
- `package.json` — tells Cloudflare's build environment which deployment tool to use.
- `public/` — the flight-tracker web interface.

## Default center

The current V1 center is Alpena / KAPN:

- 45.0781 N
- 83.5603 W

The center can be made user-configurable in the next version.

## No API key

ADSB.lol currently exposes the endpoint used by this prototype without an API key. This is a community service, so access policies can change.

## Safety

This is a home/office/hangar enthusiast display. It is not intended as an aviation safety, navigation, or collision-avoidance system.
