/**
 * ============================================================================
 * DriveService.gs - Secure Google Drive Document & PDF Storage Engine
 * ============================================================================
 */

var ROOT_FOLDER_NAME = "Aaryan_Aqua_Billing_Data";
var INVOICES_FOLDER_NAME = "Aaryan_Aqua_Invoices";
var MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024; // 15MB max

function getRootFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("ROOT_FOLDER_ID");
  if (folderId) {
    try {
      var existing = DriveApp.getFolderById(folderId);
      if (existing && !existing.isTrashed()) return existing;
    } catch (e) {}
  }

  var folders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (folders.hasNext()) {
    var f = folders.next();
    try { props.setProperty("ROOT_FOLDER_ID", f.getId()); } catch (e) {}
    return f;
  }

  var newFolder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  try { props.setProperty("ROOT_FOLDER_ID", newFolder.getId()); } catch (e) {}
  return newFolder;
}

function getInvoicesFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("INVOICES_FOLDER_ID");
  if (folderId) {
    try {
      var existing = DriveApp.getFolderById(folderId);
      if (existing && !existing.isTrashed()) return existing;
    } catch (e) {}
  }

  var root = getRootFolder();
  var folders = root.getFoldersByName(INVOICES_FOLDER_NAME);
  var invFolder = null;
  if (folders.hasNext()) {
    invFolder = folders.next();
  } else {
    invFolder = root.createFolder(INVOICES_FOLDER_NAME);
  }

  // Enforce Privacy: Ensure folder is NOT public
  try {
    invFolder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  } catch (e) {}

  try { props.setProperty("INVOICES_FOLDER_ID", invFolder.getId()); } catch (e) {}
  return invFolder;
}

function saveInvoicePdfSecure(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: "Upload failed: Missing payload" };
  }

  var pdfBase64 = data.pdfBase64;
  if (!pdfBase64) {
    return { ok: false, error: "Upload failed: Missing pdfBase64 payload" };
  }

  // 1. Sanitize Filename
  var invNo = String(data.invoiceNo || "").trim();
  var rawFilename = String(data.filename || ("Invoice_" + (invNo || Date.now()) + ".pdf")).trim();
  var safeFilename = rawFilename.replace(/[^a-zA-Z0-9_\.-]/g, "_");
  if (!safeFilename.toLowerCase().endsWith(".pdf")) safeFilename += ".pdf";

  // 2. Validate Base64 Payload & PDF Header
  var cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, "").replace(/\s/g, '');
  if (cleanBase64.length > (MAX_PDF_SIZE_BYTES * 1.37)) {
    return { ok: false, error: "Upload rejected: File size exceeds 15MB limit" };
  }

  var decodedBytes = null;
  try {
    decodedBytes = Utilities.base64Decode(cleanBase64);
  } catch (e) {
    return { ok: false, error: "Upload rejected: Invalid base64 encoding" };
  }

  if (!decodedBytes || decodedBytes.length === 0) {
    return { ok: false, error: "Upload rejected: Empty PDF content" };
  }

  // 3. Verify PDF Magic Bytes (%PDF)
  var isPdf = false;
  if (decodedBytes.length >= 4) {
    // 0x25 = %, 0x50 = P, 0x44 = D, 0x46 = F
    if (decodedBytes[0] === 37 && decodedBytes[1] === 80 && decodedBytes[2] === 68 && decodedBytes[3] === 70) {
      isPdf = true;
    }
  }

  if (!isPdf && !pdfBase64.startsWith("data:application/pdf")) {
    return { ok: false, error: "Upload rejected: File is not a valid PDF document" };
  }

  var blob = Utilities.newBlob(decodedBytes, "application/pdf", safeFilename);
  var invFolder = getInvoicesFolder();

  // Trash existing file with exact same name to keep archive clean
  var existingFiles = invFolder.getFilesByName(safeFilename);
  while (existingFiles.hasNext()) {
    try { existingFiles.next().setTrashed(true); } catch (e) {}
  }

  var file = invFolder.createFile(blob);
  
  // File Access: Allow view access with link for customers and billing operators
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {}

  var fileId = file.getId();
  var viewUrl = "https://drive.google.com/file/d/" + fileId + "/view";

  return {
    ok: true,
    fileId: fileId,
    filename: safeFilename,
    url: viewUrl,
    pdfUrl: viewUrl,
    invoiceNo: invNo
  };
}
