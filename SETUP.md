# Setting up your Voice Diary, step by step

Work through the sections in order. If you already deployed the diary, start at step 4. Menu names below are from the current versions of each app and may differ slightly in yours.

---

## 1. netcup: point a web address at your server

You need an address like `diary.yourdomain.de` so the iPhone can install the app over HTTPS.

1. Log in to the **netcup Customer Control Panel** (customercontrolpanel.de).
2. Find your server's **IP address**: open **Products**, choose your VPS, and copy the IPv4 address.
3. In the left menu, open **Domains**, then the **magnifier / DNS** icon next to your domain.
4. Under **DNS records**, add a new line:
   - **Host:** `diary`
   - **Type:** `A`
   - **Destination:** your server's IP address
5. Click **Save changes**. It can take from a few minutes up to an hour before the address works.

*If your domain is somewhere else (IONOS, Cloudflare, …), add the same A record there.*

---

## 2. Coolify: connect GitHub (only once)

Skip this if Coolify already shows your GitHub account under **Sources**.

1. Open your Coolify dashboard.
2. In the left menu, click **Sources**, then **+ Add** → **GitHub App**.
3. Give it a name, for example `anna-github`, and click **Continue**, then **Register now**.
4. GitHub opens. Confirm the app, then choose **Only select repositories**, pick **voice-diary**, and click **Install**.
5. You land back in Coolify, and the source shows as connected.

---

## 3. Coolify: deploy the diary

1. In the left menu, click **Projects**, open a project (or create one called `Diary`), and open the **production** environment.
2. Click **+ New** (Add a resource) → **Private Repository (with GitHub App)**.
3. Choose your server, then the GitHub App from step 2.
4. Pick the repository **wifenr1/voice-diary**, branch **main**.
5. Set **Build Pack** to **Dockerfile** and click **Continue**.
6. On the configuration page:
   - **Domains:** `https://diary.yourdomain.de`, using the address from step 1 and starting with **https://**
   - **Ports Exposes:** `3000`
7. Open **Environment Variables**, click **+ Add**, and add:
   - **Name:** `DIARY_PASSWORD`
   - **Value:** a long password you make up, for example four random words. Your diary on the server is locked with it.
8. Open **Persistent Storage** (also called **Storages**), click **+ Add** → **Volume**, and set:
   - **Name:** `diary-data`
   - **Destination Path:** `/data`

   This is where your diary is kept. Without it, a redeploy would wipe it.
9. Click **Save**, then **Deploy** at the top right.
10. Wait until the deployment log shows it finished, then open `https://diary.yourdomain.de` in a browser. You should see the diary.

Coolify gets the HTTPS certificate automatically. With the GitHub App connected, every push to `main` redeploys the diary.

---

## 4. Coolify: turn on the Claude connector

1. Make up a **connector secret**: at least 32 letters and digits, with no spaces or symbols. For example, let your password manager generate one with symbols switched off.
2. In Coolify, open the diary → **Environment Variables** → **+ Add**:
   - **Name:** `MCP_TOKEN`
   - **Value:** your connector secret
3. Click **Save**, then **Redeploy**.

Your connector address is now `https://diary.yourdomain.de/mcp/` followed by your secret, for example `https://diary.yourdomain.de/mcp/Xk29fLq…`. Treat that whole address like a password.

---

## 5. Claude: add your diary connector

Do this once, in a web browser. It then works in the Claude iPhone app too.

1. Go to **claude.ai** and open **Settings → Connectors**.
2. Click **Add custom connector**.
3. **Name:** `Voice Diary`. **Remote MCP server URL:** your connector address from step 4.
4. Click **Add**. Voice Diary now shows in your list of connectors.
5. In a new chat, open the **tools menu** (the sliders or **+** button) and check that **Voice Diary** is switched on.

---

## 6. iPhone: install the diary app

1. Open **Safari** (it must be Safari) and go to `https://diary.yourdomain.de`.
2. Tap the **Share** button (the square with an arrow), scroll down, tap **Add to Home Screen**, then **Add**.
3. Open **Diary** from your home screen.
4. Tap **Week**, scroll to **Backup & settings**, type your `DIARY_PASSWORD` into **Diary password for your server**, and tap **Save**. It should say **Saved on your server**.

You don't need an API key. Leave that field empty.

---

## 7. Try it

1. In the **Claude app**, start a chat (or use voice mode) and say:
   *"Diary: today I went bouldering with Tom. Remind me to book the dentist on Monday at 3pm."*
2. Claude saves it and tells you which chapters it used. The first time, it asks to use Voice Diary: tap **Allow**.
3. Open **Diary** on your home screen. You'll see today's page with the entry under **Hobbies** and the reminder below it.
4. Tap **Add to Calendar** on the reminder. iPhone should show its "Add to Calendar" screen. Tell me if it doesn't.
5. On Sunday, ask Claude: *"Write my weekly diary review."* It appears on the **Week** page.

---

## 8. Move your entries over from the Claude version

1. In the Claude app, open your **Anna's Voice Diary** artifact.
2. Tap **Week**, scroll to **Backup**, tap **Export my diary**, and confirm. Choose **Save to Files**.
3. Open **Diary** from your home screen, tap **Week → Import a backup**, and pick that file from **Files**.

---

## 9. Invite someone else

Other people can have their own private diary on your server. They can't see yours, and you can't see theirs.

1. In Coolify, open the diary → **Environment Variables** → **+ Add** (in the top section, not under Preview Deployments):
   - **Name:** `INVITE_CODE`
   - **Value:** a code you make up, for example `tulip-river-42`
2. Click **Save**, then **Redeploy**.
3. Send them your diary address (`https://diary.tom-schliemann.de`) and the invite code.
4. They open it in Safari, add it to their home screen, and tap **Create your diary**. The app then:
   - explains how the diary works,
   - asks which chapters they want,
   - and shows their **personal connector address** with the steps to add it in their own Claude.

They use their own Claude account, so it costs you nothing. To stop new sign-ups, delete `INVITE_CODE` and redeploy. People who already joined keep their diary.

**You** don't need to change anything: your phone keeps working as it is. If you ever sign in again, your username is `anna` and your password is your `DIARY_PASSWORD`.

---

## Good to know

- **Your diary is on your phone and on your server.** Every change is saved to the server within a second. If you lose your phone, install the app on the new one, enter the same password, and everything comes back.
- **The server keeps a daily copy** of the last 30 days in `/data/backups`, in case something goes wrong.
- If you're offline, entries are kept on the phone and sent to the server when you're back online.
- **No extra cost:** Claude sorts your entries and writes your review on your Claude subscription. You only need an API key if you want sorting inside the app itself.
- You can switch the GitHub repository back to **private**. Coolify still reads it through its GitHub App.
