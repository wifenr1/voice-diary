# Voice Diary

A voice diary that writes down what you say, sorts it into your own chapters, turns "remind me…" into calendar events, and writes a weekly review with challenges.

The same page, `index.html`, runs in two places:

- **Inside Claude**, as an artifact. Entries are stored privately in your Claude account.
- **As its own iPhone app** on your home screen, served from your own server with Coolify. Your diary is kept on your phone and synced to your server behind a password.

The server is also a **Claude connector** (MCP). You tell Claude about your day, Claude sorts it into your chapters and saves it to your server, and it shows up in the app. Claude also writes your weekly review there. It all runs on your Claude subscription, with no API key.

## Setting up the home-screen app

The full click-by-click guide is in [SETUP.md](SETUP.md). In short:

### 1. Deploy with Coolify
1. **Pick an address.** For example `diary.yourdomain.de`. At your domain provider, add an **A record** for it that points to your netcup server's IP address. The app needs HTTPS to install on the home screen, and Coolify sets that up for this address.
2. **Add the app in Coolify.** Choose **+ New → Private Repository (with GitHub App)**, pick `wifenr1/voice-diary` and the `main` branch.
3. Set **Build Pack** to **Dockerfile** and **Ports Exposes** to `3000`.
4. Under **Domains**, enter `https://diary.yourdomain.de`.
5. Add the environment variable `DIARY_PASSWORD` (a long password you make up), and a persistent volume mounted at `/data`.
6. Choose **Deploy**. When it finishes, the diary is live at that address. Each push to `main` redeploys it automatically.

The repository can stay private, since Coolify reads it through its GitHub App.

### 2. Connect Claude
1. In Coolify, add the environment variable `MCP_TOKEN`, a long secret of letters and digits, and redeploy.
2. On claude.ai, open **Settings → Connectors → Add custom connector**, name it `Voice Diary`, and use `https://diary.yourdomain.de/mcp/<MCP_TOKEN>` as the URL.

### Other people
Set `INVITE_CODE` in Coolify and share it. Each person creates their own account with their chapters and gets their own private diary and Claude connector. See step 9 in [SETUP.md](SETUP.md).

### 3. Add it to your home screen
1. Open your diary address (for example `https://diary.yourdomain.de`) in **Safari** on your iPhone.
2. Tap **Share → Add to Home Screen**.
3. Open the diary from the new icon, go to **Week**, enter your diary password, and tap **Save**.

### 4. Bring your entries over
1. In the Claude version, open **Week → Export my diary**.
2. In the home-screen app, open **Week → Import a backup** and choose that file.

## Good to know
- **Backups:** your diary syncs to the server, which also keeps a daily copy of the last 30 days in `/data/backups`.
- **Using it:** tell Claude "diary: …" to add an entry, and "write my weekly diary review" on Sundays.
- **Cost:** none beyond your Claude subscription. An API key is optional; with one, the app can also sort and write reviews by itself (`claude-opus-5-5`, paid per use).
- **Updates:** every change pushed to `main` is redeployed by Coolify.

## Files

| Path | What it does |
|---|---|
| `index.html` | The whole app. It works inside Claude and as the home-screen app. |
| `scripts/build.mjs` | Adds the home-screen app's head tags and writes `dist/`. |
| `public/` | App icon, manifest and the offline helper (`sw.js`). |
| `server.mjs` | Serves the app, stores each person's diary in `/data` behind their password, and is each person's Claude connector at `/mcp/<secret>`. |
| `Dockerfile` | Builds the app and runs the server. Coolify uses this. |
