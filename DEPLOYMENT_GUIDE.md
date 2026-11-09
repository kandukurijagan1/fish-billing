# 🌐 Complete Cloud Deployment Guide — Aaryan Aqua Needs

This guide explains how to deploy **Aaryan Aqua Needs GST Billing & WhatsApp Companion** completely to the cloud.

---

## 🏛️ Cloud Architecture Overview

```
                      +---------------------------------------+
                      |       USER SMARTPHONES & BROWSER      |
                      |   (Accessible from anywhere worldwide)|
                      +---------------------------------------+
                                          |
                                    HTTPS Port 443
                                          |
                                          v
                      +---------------------------------------+
                      |         CLOUD WEB SERVER (PORT)       |
                      |    (Render / Railway / Docker / VPS)  |
                      |                                       |
                      |  • Serves Web Billing App & POS UI    |
                      |  • Reverse-Proxies WhatsApp API       |
                      |  • Health Check: /health              |
                      +---------------------------------------+
                           /                             \
     PostgreSQL REST (<50ms)                      Internal Port 3001
                         /                                 \
                        v                                   v
+-------------------------------+         +-------------------------------+
|      SUPABASE POSTGRESQL      |         |     WHATSAPP COMPANION BOT    |
|   (Cloud Database Master)     |         |    (Headless Chromium Web)    |
|                               |         |                               |
| • Invoices Table              |         | • Multi-Device Session Token  |
| • Products & Live Inventory   |         | • Dynamic QR Code Stream      |
| • Client & Party Directory    |         | • PDF Dispatch to Customers   |
| • Multi-User Settings         |         | • Cloud Persistent Volume     |
+-------------------------------+         +-------------------------------+
```

---

## Option 1: 1-Click Render Deployment (Recommended)

Render offers free/low-cost Docker hosting with persistent disk storage so your WhatsApp login session is never wiped.

### Steps:
1. Push your repository to GitHub:
   ```bash
   git add .
   git commit -m "feat: complete cloud deployment configuration"
   git push origin main
   ```
2. Log in to [Render.com](https://render.com).
3. Click **New +** -> **Blueprint**.
4. Connect your GitHub repository (`kandukurijagan7-star/billing` or `fish-billing`).
5. Render will automatically detect [`render.yaml`](file:///c:/Users/ADMIN/Documents/fish%20billing/render.yaml) and configure:
   - **Environment**: Docker (with headless Chromium pre-installed).
   - **Health Check Path**: `/health`.
   - **Persistent Disk**: 1 GB mounted at `/app/data` to save WhatsApp auth tokens across restarts.
   - **Supabase Credentials**: Automatically injected.
6. Click **Apply**.
7. Once deployed, Render will provide your public URL (e.g., `https://aaryan-aqua-billing.onrender.com`).
8. Open the URL in your browser or mobile phone:
   - Go to **WhatsApp Bot** tab.
   - Scan the QR code with WhatsApp on your phone.
   - **Done!** The billing app and WhatsApp bot now run 24/7 in the cloud.

---

## Option 2: Railway Deployment

Railway supports 1-click Dockerfile deployments with instant zero-configuration builds.

### Steps:
1. Log in to [Railway.app](https://railway.app).
2. Click **New Project** -> **Deploy from GitHub repo**.
3. Select your repository.
4. Railway automatically detects [`Dockerfile`](file:///c:/Users/ADMIN/Documents/fish%20billing/Dockerfile) and [`railway.toml`](file:///c:/Users/ADMIN/Documents/fish%20billing/railway.toml).
5. In project settings, add a **Volume** mounted at `/app/data` to persist your WhatsApp session.
6. Add Environment Variables:
   - `SUPABASE_URL`: `https://tfncblvaaemkbtvqnpdn.supabase.co`
   - `SUPABASE_ANON_KEY`: `sb_publishable_D7LL7bdXwN1kEUeV3JEygQ_AdM_366s`
7. Click **Generate Domain** to get your live HTTPS URL.

---

## Option 3: Docker on any Linux VPS (Ubuntu / Debian / AWS / DigitalOcean)

To run on your own Virtual Private Server (VPS):

```bash
# 1. Clone repository
git clone https://github.com/kandukurijagan7-star/billing.git
cd billing

# 2. Build Docker container
docker build -t aaryan-aqua-billing .

# 3. Run container with persistent storage and port forwarding
docker run -d \
  --name aaryan-billing \
  --restart always \
  -p 5000:5000 \
  -v $(pwd)/data:/app/data \
  aaryan-aqua-billing
```
Open `http://your-server-ip:5000` in your browser.

---

## 🗄️ Supabase PostgreSQL Cloud Setup

Your Supabase project is already configured and operational at:
- **Project URL:** `https://tfncblvaaemkbtvqnpdn.supabase.co`
- **Schema File:** [`supabase_schema.sql`](file:///c:/Users/ADMIN/Documents/fish%20billing/supabase_schema.sql)

If you ever create a new Supabase project:
1. Open the Supabase SQL Editor.
2. Paste the contents of [`supabase_schema.sql`](file:///c:/Users/ADMIN/Documents/fish%20billing/supabase_schema.sql) and click **Run**.
3. Update `SUPABASE_URL` and `SUPABASE_ANON_KEY` in [`supabase-adapter.js`](file:///c:/Users/ADMIN/Documents/fish%20billing/supabase-adapter.js) or your cloud environment variables.

---

## 📱 How Remote WhatsApp Integration Works in Cloud Mode

1. When you access your cloud URL from your mobile phone or PC:
   - The browser connects to the cloud server via secure HTTPS.
   - Requests to `/api/whatsapp/status`, `/api/whatsapp/connect`, and `/api/whatsapp/send-invoice` are reverse-proxied internally to the WhatsApp companion process.
   - The QR code appears directly in the web UI.
2. Scan the QR code once using your phone's WhatsApp linked devices.
3. The session is permanently saved to `/app/data/.wwebjs_auth` on the cloud volume.
4. Any staff member or customer using the billing app can now click **Share on WhatsApp**, and invoices are sent automatically via your cloud bot!
