# Player Radar Cloud

This package adds an online account + live radar backend to the existing Player Radar mod.

## What it does
- Account registration/login.
- Pair one Minecraft installation to an account with a 6-digit code.
- Minecraft uploads the current radar snapshot about every 45 ms while you are in a world (actual Minecraft state changes are still tied to the ~20 TPS client tick).
- Logged-in phones/PCs receive updates over WebSocket.
- Account owners can share their radar with another account.
- The cloud website has the same north-up radar behavior and adjustable arrow size 1-10.
- Radar snapshots are held in memory on the server, not stored permanently.

## Deploy on Render (testing/hobby setup)
Render supports Node web services and inbound WebSockets. A public web service should listen on `0.0.0.0`; this server does that. See the official Render docs linked in the ChatGPT answer.

1. Put the contents of this package in a GitHub repository.
2. Keep `render.yaml` at the repository root.
3. In Render, choose **New -> Blueprint** and select the repository.
4. Render will create the Node web service and a Postgres database from `render.yaml`.
5. Wait for the web service to deploy. Copy its HTTPS URL, e.g. `https://player-radar-cloud-xxxx.onrender.com`.
6. Open that URL on your phone or PC and create an account.
7. Log in and click **Generate link code**.
8. On the Minecraft PC, create `%APPDATA%\\.minecraft\\config\\player-radar.json` with:

   {"serverUrl":"https://YOUR-SERVICE.onrender.com","deviceToken":""}

9. Start Minecraft with the new Player Radar JAR.
10. Open `http://127.0.0.1:8766` on the Minecraft PC. Enter the 6-digit code. You should get “Linked successfully”.
11. Return to the cloud website. Your Minecraft radar should appear.
12. To let a friend see it, your friend creates their own account and you enter their username in **Share your radar**.

### Important Render free-plan note
Render documents that free web services can be used for testing/hobby projects and that free Postgres databases expire after 30 days. If you want this to be a permanent service, use a paid database/service or substitute another persistent PostgreSQL provider.

## Security
- Passwords are bcrypt-hashed.
- Web sessions expire after 7 days.
- Minecraft pairing returns a random device token; only its SHA-256 hash is stored in Postgres.
- The device token is kept in the local Minecraft config and should not be shared.
- Use HTTPS/WSS in production.
- The 6-digit pairing code expires after 5 minutes.

## Local fallback
The JAR still provides the original local radar at `http://127.0.0.1:8765`. The cloud feature is separate and does not require opening port 8765 to the internet.
