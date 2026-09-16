# 🌊 Aaryan Aqua Billing System

Lightweight, offline-capable GST billing and inventory management platform engineered exclusively with **Google Cloud Services** (Google Apps Script, Google Sheets, Google Drive) and a static web client.

---

## 🏛️ System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Client Browser                      │
│  (IndexedDB / LocalStorage / Offline Queue / UI Engine) │
└────────────────────────────┬────────────────────────────┘
                             │
          HTTPS POST (text/plain JSON to bypass CORS)
          + Token Authentication
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│            Google Apps Script Web App (API)             │
│        (Code.gs / backend/* / LockService 30s)          │
├────────────────────────────┬────────────────────────────┤
│                            │                            │
│  Authoritative Data Store  │   Private File Storage     │
│  ▼                         │   ▼                        │
│  Google Sheets             │   Google Drive             │
│  ID: 1BZnCqi9DPhJxh...    │   Folder: Aaryan_Aqua_...  │
│  - Invoices                │   - Access: PRIVATE        │
│  - Inventory               │   - Base64 PDF Validation  │
│  - Customers               │                            │
│  - Settings                │                            │
│  - Audit_Logs              │                            │
└────────────────────────────┴────────────────────────────┘
```

### Non-Negotiable Architecture Compliance
- **Backend**: 100% Google Cloud Services (Google Apps Script Web App, Google Sheets, Google Drive).
- **Primary Data Store**: Google Sheets Spreadsheet (`1BZnCqi9DPhJxhwUpux1HRfo_PDVn2QLDNDheR0Kf73Q`).
- **Frontend Hosting**: Pure static web hosting via Netlify (`netlify.toml` with zero serverless/lambda backend functions).
- **No External Databases**: No Node.js backend, Express, MongoDB, MySQL, PostgreSQL, Supabase, Firebase, AWS, or Azure.

---

## 📑 Google Sheets Authoritative Schema

The Google Sheets master workbook contains 5 dedicated worksheets:

| Sheet Name | Purpose | Key Columns & Data Structures |
| :--- | :--- | :--- |
| **`Invoices`** | Primary financial ledger | Columns 1–14: Summary data (`ID`, `InvoiceNo`, `Date`, `Customer`, `GSTIN`, `Taxable`, `CGST`, `SGST`, `IGST`, `TotalTax`, `RoundOff`, `GrandTotal`, `PaidAmount`, `BalanceDue`, `Status`).<br>Column 15: Full lossless JSON payload (`Invoice Data JSON`). |
| **`Inventory`** | Live product catalog & stock | `Product ID`, `Product Name`, `HSN/SAC`, `Pack Size`, `Unit`, `Rate/Price`, `GST %`, `Current Stock`, `Low Stock Threshold`, `Category`, `Last Updated`. |
| **`Customers`** | Client & distributor CRM | `Customer ID`, `Party Name`, `Phone`, `Email`, `GSTIN`, `State Code`, `Address`, `Total Invoiced`, `Outstanding Balance`, `Last Transaction Date`. |
| **`Settings`** | Company profile & configurations | Key-value settings store for Company Details, Bank Account/IFSC, UPI IDs, GSTIN, Print preferences. |
| **`Audit_Logs`** | Immutable security trail | `Timestamp`, `Action`, `User/Actor`, `Record ID`, `Details`, `IP/Context`. |

---

## 🔒 Security & Concurrency Design

1. **Atomic Concurrency Locks**:
   - All mutations in Google Apps Script are wrapped in `LockService.getScriptLock()`.
   - The script waits up to 30,000 ms (`lock.waitLock(30000)`) before executing reads/writes to prevent race conditions during simultaneous invoice creation or stock deductions.
2. **Server-Side Financial Recalculation**:
   - The client never dictates financial totals. The server recalculates line items:
     - `Line Gross = Quantity * Rate`
     - `Line Discount = Line Gross * (Discount % / 100)`
     - `Line Taxable = Line Gross - Line Discount`
     - `GST = Line Taxable * (Tax Rate % / 100)` (split into 50% CGST + 50% SGST for intra-state, or 100% IGST for inter-state)
     - `Round-Off = Math.round(Raw Total) - Raw Total`
     - `Balance Due = Max(0, Grand Total - Paid Amount)`
3. **Strict Server-Side Validation**:
   - Negative quantities, rates, or paid amounts are rejected.
   - Missing customer names or empty items arrays are rejected.
   - Duplicate invoice numbers with different record IDs are rejected.
4. **Secure Document Storage**:
   - Master folders in Google Drive are configured with `DriveApp.Access.PRIVATE` to secure company data.
   - Individual invoice PDFs are stored with `DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW` so customers receiving billing links (via WhatsApp or SMS) can seamlessly preview their bills without requiring Google sign-in.
   - Base64 PDF headers (`%PDF-`) and file sizes (max 15MB) are verified before writing to Drive.
5. **Token Authentication**:
   - Requests require a secret API token matching `API_SECRET_KEY` in Google Apps Script `ScriptProperties`.

---

## 🚀 Deployment Guide

### Step 1: Deploy Google Apps Script
1. Open your master Google Spreadsheet:
   [Aaryan Aqua Master Spreadsheet](https://docs.google.com/spreadsheets/d/1BZnCqi9DPhJxhwUpux1HRfo_PDVn2QLDNDheR0Kf73Q/edit)
2. In the top menu, go to **Extensions** → **Apps Script**.
3. Copy the consolidated code from [`Code.gs`](./Code.gs) (or the modular files from the [`backend/`](./backend) folder) into the Apps Script editor.
4. Set your private Script Properties:
   - Click **Project Settings** (gear icon) → **Script Properties**.
   - Add property: `MASTER_SPREADSHEET_ID` = `1BZnCqi9DPhJxhwUpux1HRfo_PDVn2QLDNDheR0Kf73Q` (your Google Sheet ID).
   - Add property: `API_SECRET_KEY` = `AARYAN_AQUA_SECURE_KEY_2026` (your private API authorization token).
5. Deploy Web App:
   - Click **Deploy** → **New deployment**.
   - Select type: **Web app**.
   - Description: `Aaryan Aqua Production API`.
   - Execute as: **Me** (`your-google-account@gmail.com`).
   - Who has access: **Anyone** (allows client browser requests authenticated by your `API_SECRET_KEY`).
   - Click **Deploy** and copy the **Web app URL** (e.g. `https://script.google.com/macros/s/AKfycb.../exec`).

### Step 2: Configure Frontend
1. In `index_v5.js` (or via `window.GOOGLE_SCRIPT_URL`):
   Ensure `GOOGLE_SCRIPT_URL` points to your deployed Web App URL and `API_SECRET_TOKEN` matches your `API_SECRET_KEY`.
2. Commit and push changes to GitHub:
   ```bash
   git add .
   git commit -m "Deploy pure Google Services backend and static frontend"
   git push origin main
   ```
3. Netlify will automatically build and publish the static assets from the root directory.

---

## 🧪 Automated Verification Suite

An extensive 23-point test suite is included in `scratch/test-suite-google-backend.js`:
- **Financial Calculation Tests**:
  - Intra-state GST (9% CGST + 9% SGST on ₹10,000 = ₹11,800).
  - Partial payments & balance calculation (₹10,000 - ₹7,000 = ₹3,000).
  - Inter-state IGST calculation.
  - Multi-tier line discounts.
  - Round-off calculations.
- **Input Validation & Security Rejections**:
  - Negative quantity / price rejection.
  - Empty items / missing customer rejection.
  - Duplicate invoice number rejection.
  - Edit-mode preservation with identical invoice ID.
- **Authentication & Security Constraints**:
  - `AuthService` token extraction and validation.
  - `DriveApp.Access.PRIVATE` enforcement.
  - `LockService` concurrency locking.
  - No client-exposed secrets.

To run the test suite locally:
```bash
node scratch/test-suite-google-backend.js
```

---

## ⚠️ Known Limitations & Operational Considerations

1. **Google Apps Script Quotas**:
   - Google Apps Script has a maximum single execution runtime of 6 minutes and daily URL Fetch quotas depending on your Google Workspace tier.
   - For high-volume transaction bursts, the client's IndexedDB offline queue automatically batches and throttles sync requests.
2. **Eventual Consistency under Network Latency**:
   - Because Google Apps Script Web Apps may experience cold-start latency (1–3 seconds), the application uses an optimistic UI pattern: operations complete instantly locally in IndexedDB, while the background outbox synchronizes with Google Sheets.
3. **Google Drive Storage & Links**:
   - The master invoice storage folder is kept `PRIVATE` to protect enterprise records, while generated invoice PDFs are viewable by link (`ANYONE_WITH_LINK, VIEW`) allowing customers and staff to view them across devices.