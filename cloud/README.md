# Cloud station on Railway

Runs the station on an always-on server with a password login in front, so the crew keeps working when your computer is off.

## How it's put together

- **Station (sidecar)** runs inside the container on `127.0.0.1:8787` only. It's never exposed directly.
- **Gateway** (`cloud/gateway.js`) is the only public door. It asks for a password, then passes traffic through to the station. The station's own security checks still apply behind it.
- **Volume at `/data`** holds everything that must survive restarts and redeploys: crews, chats, routines, deliverables, and the Claude Code sign-in.
- **Scheduled routines are on** (`STARNET_CRON_ENABLED=1`), so routines run while you're away.
- **The browser runs headless**, because a server has no screen.

## One-time setup

1. **Fork** `androoAGI/starnet` to your GitHub account, then add this `cloud/` folder, `railway.json` and `.dockerignore` to the fork.
2. **In Railway**, choose New Project, then Deploy from GitHub repo, then your fork. Railway reads `railway.json` and builds `cloud/Dockerfile`.
3. **Add a volume** to the service, mounted at `/data`.
4. **Set variables** on the service:
   - `GATEWAY_PASSWORD`: a long password, at least 12 characters (required)
   - optional: `STARNET_NIGHTSHIFT_ENABLED=1` to let agents do small jobs on their own while you're away
5. **Generate a domain** under the service's Settings, then Networking. Open it and sign in with the password.
6. **Connect the brain:** in the station's settings, choose Providers, then Claude Code, then Sign in. Open the sign-in page it shows, approve it, and paste the code back. The sign-in is saved on the volume.

## Day to day

- Sign out: visit `/__gateway/logout`.
- Health check: `/__gateway/health`.
- Changing `GATEWAY_PASSWORD` signs out every device.
- Failed logins are limited to 8 per IP per 15 minutes.

## Known limits

- **Sign-ins inside the browser:** in the cloud the browser is headless, so you can't take over the agents' browser (the step-in sign-in) to log into websites for them. Prefer connectors (Gmail, Calendar, and so on) or API keys.
- **Windows-only features:** desktop computer control isn't available on a Linux server.
- **Name and artwork:** the MIT license covers the code only. The StarNet name, logo and art must be replaced before the station is offered to anyone else. Keep `LICENSE` and `NOTICE.md` in place.
