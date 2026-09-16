/**
 * ============================================================================
 * InvoiceService.gs - Business Logic, Concurrency & Inventory Integration
 * ============================================================================
 */

function processSaveInvoice(invoiceData, user, ss) {
  if (!ss) ss = getMasterSpreadsheet();

  // 1. Concurrency Locking via LockService
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // Wait up to 30 seconds for lock
  } catch (lockErr) {
    return {
      ok: false,
      error: "Server busy: Could not acquire concurrency lock. Another transaction is in progress. Please retry."
    };
  }

  try {
    // 2. Read Authoritative State from Sheets
    var existingInvoices = readInvoicesFromSheet(ss);
    var inventory = readInventoryFromSheet(ss);

    // 3. Strict Server-Side Validation & Recalculation
    var valResult = validateAndComputeInvoice(invoiceData, existingInvoices);
    if (!valResult.valid) {
      return { ok: false, error: valResult.error };
    }

    var computed = valResult.computed;

    // 4. Concurrency Guard: Check if editing existing invoice strictly by ID
    var existingIdx = -1;
    if (computed.id) {
      for (var i = 0; i < existingInvoices.length; i++) {
        if (existingInvoices[i].id === computed.id) {
          existingIdx = i;
          break;
        }
      }
    }

    // Check if suggested invoiceNo is already occupied by a DIFFERENT invoice
    var isNumberCollision = false;
    if (computed.invoiceNo) {
      for (var k = 0; k < existingInvoices.length; k++) {
        if (String(existingInvoices[k].invoiceNo).trim() === String(computed.invoiceNo).trim()) {
          if (existingIdx === -1 || existingInvoices[k].id !== computed.id) {
            isNumberCollision = true;
            break;
          }
        }
      }
    }

    // Auto-Generate Next Sequential Invoice Number if empty OR if collided with concurrent user
    if (!computed.invoiceNo || (existingIdx === -1 && isNumberCollision)) {
      var maxNo = 0;
      for (var k = 0; k < existingInvoices.length; k++) {
        var n = parseInt(String(existingInvoices[k].invoiceNo).replace(/\D/g, ""), 10);
        if (!isNaN(n) && n > maxNo) maxNo = n;
      }
      computed.invoiceNo = String(maxNo + 1).padStart(4, "0");
    }

    // 5. Atomic Inventory Stock Adjustment
    // If editing existing invoice, first restore previous items

    if (existingIdx > -1) {
      var oldInv = existingInvoices[existingIdx];
      var oldItems = (oldInv.details && oldInv.details.items) || oldInv.items || [];
      for (var oi = 0; oi < oldItems.length; oi++) {
        var oldItm = oldItems[oi];
        var oldDesc = String(oldItm.description || oldItm.name || "").trim().toLowerCase();
        for (var p = 0; p < inventory.length; p++) {
          var prod = inventory[p];
          if ((prod.id && prod.id === oldItm.productId) || (prod.description && prod.description.trim().toLowerCase() === oldDesc)) {
            prod.stock = roundToTwo(Number(prod.stock || 0) + Number(oldItm.quantity || 0));
            break;
          }
        }
      }
    }

    // Deduct new items from inventory
    var updatedInventory = JSON.parse(JSON.stringify(inventory));
    for (var ni = 0; ni < computed.items.length; ni++) {
      var newItm = computed.items[ni];
      var newDesc = String(newItm.description || "").trim().toLowerCase();
      var foundProduct = null;

      for (var pi = 0; pi < updatedInventory.length; pi++) {
        var pr = updatedInventory[pi];
        if ((pr.id && pr.id === newItm.productId) || (pr.description && pr.description.trim().toLowerCase() === newDesc)) {
          foundProduct = pr;
          break;
        }
      }

      if (foundProduct) {
        var currentStock = Number(foundProduct.stock || 0);
        if (currentStock < newItm.quantity) {
          return {
            ok: false,
            error: "Insufficient stock for '" + foundProduct.description + "'. Available: " + currentStock + ", Requested: " + newItm.quantity
          };
        }
        foundProduct.stock = roundToTwo(currentStock - newItm.quantity);
        foundProduct.status = foundProduct.stock <= 0 ? "Out of Stock" : (foundProduct.stock <= 5 ? "Low Stock" : "In Stock");
      }
    }

    // 6. Build Consolidated Full Invoice Record
    var fullInvoice = Object.assign({}, invoiceData, {
      id: computed.id,
      invoiceNo: computed.invoiceNo,
      invoiceDate: computed.invoiceDate,
      customerName: computed.customerName,
      itemsCount: computed.items.length,
      total: computed.total,
      paidAmount: computed.paidAmount,
      balanceDue: computed.balanceDue,
      paymentStatus: computed.paymentStatus,
      items: computed.items,
      taxableSubtotal: computed.taxableSubtotal,
      cgst: computed.cgst,
      sgst: computed.sgst,
      igst: computed.igst,
      totalTax: computed.totalTax,
      roundOff: computed.roundOff,
      updatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss")
    });

    fullInvoice.details = Object.assign({}, fullInvoice);

    // 7. Write Authoritative Data to Sheets in Batches
    writeInvoiceToSheet(fullInvoice, ss);
    writeInventoryToSheet(updatedInventory, ss);

    // 8. Invalidate High-Speed Cache Bundle
    try {
      CacheService.getScriptCache().remove("cache_sync_bundle");
    } catch (e) {}

    // 9. Audit Logging
    appendAuditLog("SAVE_INVOICE", user || "Admin", computed.invoiceNo, "SUCCESS", "Total: ₹" + computed.total + " | Paid: ₹" + computed.paidAmount + " | Items: " + computed.items.length, ss);

    return {
      ok: true,
      invoice: fullInvoice,
      record: fullInvoice,
      serverTime: Date.now()
    };

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function processDeleteRecord(type, id, user, ss) {
  if (!ss) ss = getMasterSpreadsheet();

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return { ok: false, error: "Server busy: Could not acquire lock for deletion." };
  }

  try {
    if (type === "invoice") {
      var existingInvoices = readInvoicesFromSheet(ss);
      var targetInv = null;
      for (var i = 0; i < existingInvoices.length; i++) {
        if (existingInvoices[i].id === id || existingInvoices[i].invoiceNo === id) {
          targetInv = existingInvoices[i];
          break;
        }
      }

      // Restore inventory stock for deleted invoice
      if (targetInv) {
        var items = (targetInv.details && targetInv.details.items) || targetInv.items || [];
        var inventory = readInventoryFromSheet(ss);
        for (var j = 0; j < items.length; j++) {
          var itm = items[j];
          var desc = String(itm.description || itm.name || "").trim().toLowerCase();
          for (var p = 0; p < inventory.length; p++) {
            var prod = inventory[p];
            if ((prod.id && prod.id === itm.productId) || (prod.description && prod.description.trim().toLowerCase() === desc)) {
              prod.stock = roundToTwo(Number(prod.stock || 0) + Number(itm.quantity || 0));
              prod.status = prod.stock <= 0 ? "Out of Stock" : (prod.stock <= 5 ? "Low Stock" : "In Stock");
              break;
            }
          }
        }
        writeInventoryToSheet(inventory, ss);
      }

      var targetNo = targetInv ? (targetInv.invoiceNo || id) : id;
      deleteInvoiceFromSheet(targetNo, ss);
      deleteInvoiceFromSheet(id, ss);

      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (e) {}

      appendAuditLog("DELETE_INVOICE", user || "Admin", id, "SUCCESS", "Invoice deleted and inventory stock restored", ss);
      return { ok: true, deletedId: id, type: "invoice" };

    } else if (type === "product") {
      var inventory = readInventoryFromSheet(ss);
      var filtered = inventory.filter(function(p) { return p.id !== id; });
      writeInventoryToSheet(filtered, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (e) {}
      appendAuditLog("DELETE_PRODUCT", user || "Admin", id, "SUCCESS", "Product removed from inventory", ss);
      return { ok: true, deletedId: id, type: "product" };

    } else if (type === "party" || type === "customer") {
      var customers = readCustomersFromSheet(ss);
      var filteredC = customers.filter(function(c) { return c.id !== id; });
      writeCustomersToSheet(filteredC, ss);
      try { CacheService.getScriptCache().remove("cache_sync_bundle"); } catch (e) {}
      appendAuditLog("DELETE_CUSTOMER", user || "Admin", id, "SUCCESS", "Customer removed from parties database", ss);
      return { ok: true, deletedId: id, type: "party" };
    }

    return { ok: false, error: "Invalid record type: " + type };

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
