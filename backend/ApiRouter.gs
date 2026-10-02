/**
 * ============================================================================
 * ApiRouter.gs - Action Allowlist, Security Filter & HTTP Dispatcher
 * ============================================================================
 */

var ALLOWED_ACTIONS = [
  "status",
  "ping",
  "sync",
  "pull",
  "save_invoice",
  "delete_record",
  "save_products",
  "save_parties",
  "save_settings",
  "upload_pdf",
  "send_login_otp"
];

function handleApiGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action).trim() : "status";

  // Check allowlist
  if (ALLOWED_ACTIONS.indexOf(action) === -1) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Unknown or unauthorized action: " + action
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 0. Ultra-Fast Ping — keeps V8 container warm, zero sheet access (<50ms)
  if (action === "ping") {
    return ContentService.createTextOutput(JSON.stringify({
      ok: true, pong: true, t: Date.now()
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 1. Status Health Check
  if (action === "status") {
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      status: "healthy",
      serverTime: Date.now(),
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // 2. Authoritative Sync / Pull — ALWAYS fresh from Google Sheets (NO cache)
  if (action === "sync" || action === "pull") {
    var auth = authenticateRequest(e, null);
    if (!auth.ok) {
      return ContentService.createTextOutput(JSON.stringify(auth)).setMimeType(ContentService.MimeType.JSON);
    }

    // Read Authoritative Data DIRECTLY from Google Sheets — no cache
    var ssMaster = getMasterSpreadsheet();
    var invs = readInvoicesFromSheet(ssMaster);
    var prods = readInventoryFromSheet(ssMaster);
    var parts = readCustomersFromSheet(ssMaster);

    var fullBundle = {
      ok: true,
      invoices: invs,
      products: prods,
      parties: parts,
      settings: {},
      globalSettings: {},
      serverTime: Date.now(),
      timestamp: new Date().toISOString()
    };

    return ContentService.createTextOutput(JSON.stringify(fullBundle)).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleApiPost(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Missing POST request payload"
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var rawBody = e.postData.contents;
    var data = JSON.parse(rawBody || "{}");
    var action = String(data.action || "").trim();

    // 1. Action Allowlist Enforcement
    if (!action || ALLOWED_ACTIONS.indexOf(action) === -1) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        error: "Unknown or forbidden action: '" + action + "'. Request rejected."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Authentication Enforcement
    var auth = authenticateRequest(e, data);
    if (!auth.ok) {
      return ContentService.createTextOutput(JSON.stringify(auth)).setMimeType(ContentService.MimeType.JSON);
    }

    var user = auth.user;
    var ss = getMasterSpreadsheet();

    // 3. Dispatch to Specialized Service Handlers
    if (action === "sync" || action === "pull") {
      var invs = readInvoicesFromSheet(ss);
      var prods = readInventoryFromSheet(ss);
      var parts = readCustomersFromSheet(ss);
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        invoices: invs,
        products: prods,
        parties: parts,
        serverTime: Date.now(),
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_invoice") {
      var invoicePayload = data.invoice || data.data || data;
      var saveRes = processSaveInvoice(invoicePayload, user, ss);
      return ContentService.createTextOutput(JSON.stringify(saveRes)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "delete_record") {
      var delType = data.type || data.recordType;
      var delId = data.id || data.recordId;
      var delNo = data.invoiceNo || data.no;
      if (delNo && delType === "invoice") {
        deleteInvoiceFromSheet(delNo, ss);
        deleteInvoiceFromSheet(String(delNo).replace(/^#/, ''), ss);
      }
      var delRes = processDeleteRecord(delType, delId, user, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (ce) {}
      return ContentService.createTextOutput(JSON.stringify(delRes)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_products") {
      var prodList = data.products || [];
      if (!Array.isArray(prodList)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Products must be an array" })).setMimeType(ContentService.MimeType.JSON);
      }
      writeInventoryToSheet(prodList, ss);
      /* [CLOUD-ONLY] No server-side cache to invalidate */
      appendAuditLog("SAVE_PRODUCTS", user, "—", "SUCCESS", "Saved " + prodList.length + " products", ss);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: prodList.length })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_parties") {
      var partyList = data.parties || [];
      if (!Array.isArray(partyList)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Parties must be an array" })).setMimeType(ContentService.MimeType.JSON);
      }
      writeCustomersToSheet(partyList, ss);
      /* [CLOUD-ONLY] No server-side cache to invalidate */
      appendAuditLog("SAVE_PARTIES", user, "—", "SUCCESS", "Saved " + partyList.length + " customers", ss);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: partyList.length })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "save_settings") {
      var settingsObj = data.settings || {};
      appendAuditLog("SAVE_SETTINGS", user, "—", "SUCCESS", "System settings updated", ss);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, settings: settingsObj })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "upload_pdf") {
      var uploadRes = saveInvoicePdfSecure(data);
      if (uploadRes && uploadRes.ok && uploadRes.invoiceNo) {
        var invSheet = ss.getSheetByName("Invoices");
        if (invSheet && invSheet.getLastRow() >= 2) {
          var idVals = invSheet.getRange(2, 1, invSheet.getLastRow() - 1, 1).getValues();
          for (var r = 0; r < idVals.length; r++) {
            if (String(idVals[r][0]).trim() === String(uploadRes.invoiceNo).trim()) {
              invSheet.getRange(r + 2, 13).setValue(uploadRes.pdfUrl);
              break;
            }
          }
        }
      }
      appendAuditLog("UPLOAD_PDF", user, uploadRes.invoiceNo || "—", uploadRes.ok ? "SUCCESS" : "FAILED", uploadRes.safeFilename || "Invoice PDF", ss);
      return ContentService.createTextOutput(JSON.stringify(uploadRes)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "send_login_otp") {
      var targetEmail = String(data.email || "").trim().toLowerCase();
      if (targetEmail !== "kandukurijagan99@gmail.com") {
        return ContentService.createTextOutput(JSON.stringify({
          ok: false,
          error: "Unauthorized email address. Only kandukurijagan99@gmail.com is permitted."
        })).setMimeType(ContentService.MimeType.JSON);
      }
      var otpCode = String(Math.floor(100000 + Math.random() * 900000));
      try {
        PropertiesService.getScriptProperties().setProperty("AUTH_OTP_" + targetEmail, otpCode);
        PropertiesService.getScriptProperties().setProperty("AUTH_OTP_EXP_" + targetEmail, String(Date.now() + 15 * 60 * 1000));
      } catch (pe) {}
        var directLoginLink = "https://kandukurijagan1.github.io/fish-billing/?auth_otp=" + otpCode + "&auth_email=" + encodeURIComponent(targetEmail);
        MailApp.sendEmail({
          to: targetEmail,
          subject: "🔐 Aaryan Aqua Needs - Direct Login Link & Security Code: " + otpCode,
          htmlBody: "<div style='font-family: Arial, sans-serif; padding: 24px; color: #1e293b; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px;'>" +
                    "<div style='text-align: center; margin-bottom: 20px;'>" +
                    "  <h2 style='color: #0284c7; margin: 0;'>Aaryan Aqua Needs</h2>" +
                    "  <p style='color: #64748b; font-size: 13px; margin: 4px 0 0 0;'>GST Billing & Aquaculture Management</p>" +
                    "</div>" +
                    "<p>Hello Jagan,</p>" +
                    "<p>You requested direct mail access. Click the button below to <strong>instantly open and unlock</strong> the billing system without entering a password:</p>" +
                    "<div style='text-align: center; margin: 24px 0;'>" +
                    "  <a href='" + directLoginLink + "' style='background: #0284c7; color: #ffffff; padding: 14px 28px; text-decoration: none; font-size: 15px; font-weight: bold; border-radius: 8px; display: inline-block; box-shadow: 0 4px 12px rgba(2,132,199,0.3);'>🔓 Open Billing System Directly</a>" +
                    "</div>" +
                    "<p style='font-size: 13px; color: #475569;'>Or use this 6-digit one-time code on the lock screen:</p>" +
                    "<div style='font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #0f172a; background: #f1f5f9; padding: 14px; border-radius: 8px; text-align: center; margin: 15px 0; border: 1px dashed #cbd5e1;'>" + otpCode + "</div>" +
                    "<p style='font-size: 11.5px; color: #94a3b8; margin-top: 20px; border-top: 1px solid #f1f5f9; padding-top: 12px;'>Authorized for <strong>kandukurijagan99@gmail.com</strong> only. Expires in 15 minutes.</p>" +
                    "</div>"
        });
        appendAuditLog("SEND_LOGIN_OTP", targetEmail, "—", "SUCCESS", "Security OTP & direct access email dispatched", ss);
        return ContentService.createTextOutput(JSON.stringify({ ok: true, message: "Code and direct access link sent to " + targetEmail })).setMimeType(ContentService.MimeType.JSON);
      } catch (me) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Failed to send email: " + me.message })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Unhandled action" })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("API Handler error: " + err.message);
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Server-side error: " + err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================================
// Global Web App Entry Points
// ============================================================================

function doGet(e) {
  return handleApiGet(e);
}

function doPost(e) {
  return handleApiPost(e);
}
