# Voice Diary

A voice diary that writes down what you say, sorts it into your own chapters, turns "remind me…" into calendar events, and writes a weekly review with challenges.

The same page, `index.html`, runs in two places:

- **Inside Claude**, as an artifact. Entries are stored privately in your Claude account.
- **As its own iPhone app** on your home screen, served from your own server with Coolify. Entries and your API key are stored only on your phone, and the app calls Claude directly.

## Setting up the home-screen app

### 1. Deploy with Coolify
1. **Pick an address.** For example `diary.yourdomain.de`. At your domain provider, add an **A record** for it that points to your netcup server's IP address. The app needs HTTPS to install on the home screen, and Coolify sets that up for this address.
2. **Add the app in Coolify.** Choose **+ New → Private Repository (with GitHub App)**, pick `wifenr1/voice-diary` and the `main` branch.
3. Set **Build Pack** to **Dockerfile** and **Ports Exposes** to `80`.
4. Under **Domains**, enter `https://diary.yourdomain.de`.
5. Choose **Deploy**. When it finishes, the diary is live at that address. Each push to `main` redeploys it automatically.

The repository can stay private, since Coolify reads it through its GitHub App.

### 2. Get a Claude API key
1. Go to console.anthropic.com and sign up.
2. Under **Billing**, add a small amount of credit, for example $5.
3. Under **API keys**, choose **Create key** and copy it. Don't paste it into a chat.

### 3. Add it to your home screen
1. Open your diary address (for example `https://diary.yourdomain.de`) in **Safari** on your iPhone.
2. Tap **Share → Add to Home Screen**.
3. Open the diary from the new icon, go to **Week**, paste your API key, and tap **Save**.

### 4. Bring your entries over
1. In the Claude version, open **Week → Export my diary**.
2. In the home-screen app, open **Week → Import a backup** and choose that file.

## Good to know
- **Backups:** your entries live on your phone. Export a backup from **Week** now and then, because deleting the app from your home screen also deletes its data.
- **Weekly review:** on Sundays the Speak page shows "Your weekly review is ready". Tap it to write the review.
- **Cost:** the app uses the `claude-opus-5-5` model, and you pay per use. A few entries a day should cost a few dollars a month at most.
- **Updates:** every change pushed to `main` is redeployed by Coolify.

## Files

| Path | What it does |
|---|---|
| `index.html` | The whole app. It works inside Claude and as the home-screen app. |
| `scripts/build.mjs` | Adds the home-screen app's head tags and writes `dist/`. |
| `public/` | App icon, manifest and the offline helper (`sw.js`). |
| `Dockerfile`, `nginx.conf` | Builds the app and serves it. Coolify uses these. |
