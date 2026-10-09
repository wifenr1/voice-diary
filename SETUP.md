# Setting up your Voice Diary, step by step

Work through the sections in order. It takes about 20 minutes. Menu names below are from the current versions of each app and may differ slightly in yours.

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
   - **Ports Exposes:** `80`
7. Click **Save**, then **Deploy** at the top right.
8. Wait until the deployment log shows it finished, then open `https://diary.yourdomain.de` in a browser. You should see the diary.

Coolify gets the HTTPS certificate automatically. With the GitHub App connected, every push to `main` redeploys the diary.

---

## 4. Claude Console: get your API key

1. Go to **console.anthropic.com** (it may forward you to platform.claude.com) and sign up or log in.
2. Open **Settings → Billing** and add credit, for example **$5**. This is separate from your Claude subscription.
3. Open **API keys** and click **Create key**. Name it `Voice diary`, then **Create**.
4. **Copy the key now.** It is only shown once. Don't paste it into a chat; you'll paste it into the app in step 5.

---

## 5. iPhone: install the app and add your key

1. Open **Safari** (it must be Safari) and go to `https://diary.yourdomain.de`.
2. Tap the **Share** button (the square with an arrow) at the bottom.
3. Scroll down, tap **Add to Home Screen**, then **Add**.
4. Close Safari and open **Diary** from your home screen.
5. Tap **Week** at the bottom, scroll to **Backup & settings**, paste your key into **Your Claude API key**, and tap **Save**.
6. **Test it:** tap **Speak**, type "Today I went bouldering. Remind me to call Tom tomorrow at 6pm.", and tap **Save & sort into chapters**. It should land in Hobbies with a reminder below it. If it says "Sorted with simple rules", the key isn't working; check it in step 5.
7. Tap **Add to Calendar** on the reminder. iPhone should show its "Add to Calendar" screen. Tell me if it doesn't.

The first time you tap the microphone, allow microphone access.

---

## 6. Move your entries over from the Claude version

1. In the Claude app, open your **Anna's Voice Diary** artifact.
2. Tap **Week**, scroll to **Backup**, tap **Export my diary**, and confirm. Choose **Save to Files**.
3. Open **Diary** from your home screen, tap **Week → Import a backup**, and pick that file from **Files**.
4. Your days, chapters and reviews appear in the new app.

---

## Good to know

- Your entries live only on your phone. Use **Export my diary** now and then as a backup, because removing the app from your home screen also deletes its data.
- You can switch the GitHub repository back to **private**. Coolify still reads it through its GitHub App.
