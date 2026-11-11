/**
 * Customer Timeline & Payment Audit Extension (v5.14.3 Multi-Installment Architecture)
 * 1. Tracks every individual installment: exact timestamps, amounts, payment modes, UTR/ref, and remaining balances.
 * 2. Automatic upfront payment reconciliation (Installment #1 on-spot logging).
 * 3. Supports multiple partial installments (e.g. 4-5 installments per bill, up to 30+ installments across 10 bills).
 * 4. Dedicated "Record Installment" modal with live dynamic UPI QR code generator.
 * 5. Multi-invoice FIFO cascading settlement when customer makes a lump-sum payment.
 * 6. Interactive accordion breakdown per invoice in Customer Profile.
 * 7. Comprehensive 360-degree Customer Profile Modal with searchable chronological Payment Log & Audit.
 * 8. 1-Click WhatsApp Installment Receipt generator.
 */

(function () {
  function safeEscape(str) {
    if (typeof window !== 'undefined' && typeof window.escapeHtml === 'function') {
      return window.escapeHtml(str);
    }
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // Helper to format timestamps cleanly (e.g. "12 Oct 2026, 03:45 PM")
  function formatDateTime(isoOrDateStr) {
    if (!isoOrDateStr) return "—";
    try {
      const d = new Date(isoOrDateStr);
      if (isNaN(d.getTime())) return String(isoOrDateStr);
      return d.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      });
    } catch (e) {
      return String(isoOrDateStr);
    }
  }

  function formatMoney(amount) {
    const num = Number(amount || 0);
    return isNaN(num) ? "0.00" : num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // --- 1. CORE SELF-HEALING & INSTALLMENT RECONCILIATION ENGINE ---
  window.ensureInvoicePaymentHistory = function (inv) {
    if (!inv) return [];
    if (!Array.isArray(inv.paymentHistory)) {
      if (inv.details && Array.isArray(inv.details.paymentHistory)) {
        inv.paymentHistory = inv.details.paymentHistory;
      } else {
        inv.paymentHistory = [];
      }
    }
    
    const d = inv.details || {};
    const total = Number(
      inv.total !== undefined && inv.total !== null ? inv.total : 
      (inv.grandTotal !== undefined && inv.grandTotal !== null ? inv.grandTotal : 
      (inv.grand_total !== undefined && inv.grand_total !== null ? inv.grand_total : 
      (d.total !== undefined && d.total !== null ? d.total : 
      (d.grandTotal !== undefined && d.grandTotal !== null ? d.grandTotal : 
      (d.grand_total !== undefined && d.grand_total !== null ? d.grand_total : 0)))))
    );
    const paid = Number(inv.paidAmount !== undefined ? inv.paidAmount : (d.paidAmount || 0));
    inv.total = total;
    inv.grandTotal = total;
    if (inv.details) {
      inv.details.total = total;
      inv.details.grandTotal = total;
    }

    // Sort existing installments chronologically
    inv.paymentHistory.sort((a, b) => {
      const tA = new Date(a.date || a.timestamp || 0).getTime();
      const tB = new Date(b.date || b.timestamp || 0).getTime();
      return tA - tB;
    });

    const recordedSum = inv.paymentHistory.reduce((sum, p) => sum + (parseFloat(String(p.amount || 0).replace(/,/g, '')) || 0), 0);

    // Self-heal: If customer paid money upfront that wasn't logged into paymentHistory, prepend Installment #1
    if (paid - recordedSum > 0.01) {
      const missingAmt = Math.round((paid - recordedSum) * 100) / 100;
      const upfrontDate = inv.date || inv.invoiceDate || d.date || d.invoiceDate || (inv.paymentHistory[0] ? inv.paymentHistory[0].date : new Date().toISOString());
      const upfrontEntry = {
        id: "pay_upfront_" + (inv.id || inv.invoiceNo || Date.now()),
        installmentNo: 1,
        date: upfrontDate,
        amount: missingAmt,
        mode: inv.paymentMode || d.paymentMode || "Cash",
        reference: inv.paymentReference || d.paymentReference || "Upfront Bill Settlement",
        note: "Paid on the spot during billing",
        status: (total - missingAmt <= 0.01) ? "Paid" : "Partial"
      };
      inv.paymentHistory.unshift(upfrontEntry);
    }

    // Sequentially calculate running total paid and EXACT mathematical balanceAfter for every installment
    let runningPaid = 0;
    inv.paymentHistory.forEach((p, idx) => {
      p.installmentNo = idx + 1;
      if (!p.id) p.id = "pay_" + (idx + 1) + "_" + (inv.id || inv.invoiceNo || 'inv');
      const amt = parseFloat(String(p.amount || 0).replace(/,/g, '')) || 0;
      p.amount = amt;
      runningPaid = Math.round((runningPaid + amt) * 100) / 100;
      p.balanceAfter = Math.max(0, Math.round((total - runningPaid) * 100) / 100);
      p.status = (p.balanceAfter <= 0.01) ? "Paid" : "Partial";
    });

    // Synchronize root and details fields
    const finalBal = inv.paymentHistory.length > 0 ? inv.paymentHistory[inv.paymentHistory.length - 1].balanceAfter : Math.max(0, Math.round((total - runningPaid) * 100) / 100);
    inv.paidAmount = runningPaid;
    inv.balanceDue = finalBal;
    inv.paymentStatus = finalBal <= 0.01 ? "Paid" : (runningPaid > 0 ? "Partial" : "Unpaid");

    if (inv.details) {
      inv.details.paymentHistory = inv.paymentHistory;
      inv.details.paidAmount = inv.paidAmount;
      inv.details.balanceDue = inv.balanceDue;
      inv.details.paymentStatus = inv.paymentStatus;
    }

    return inv.paymentHistory;
  };

  // --- 2. CORE INSTALLMENT RECORDER FUNCTION ---
  window.recordPostInvoicePayment = function (invoiceId, paymentDetails) {
    const isDemo = (typeof window.isDemoMode === 'function') && window.isDemoMode();
    if (!isDemo && typeof window.isViewOnlyUser === 'function' && window.isViewOnlyUser()) {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("⛔ Access Denied: Payment recording is disabled in View-Only mode.", "error", 4000);
      }
      return { ok: false, error: "view_only_mode" };
    }
    if (!invoiceId) return { ok: false, error: "missing_id" };

    const inv = (typeof invoicesDb !== "undefined" ? invoicesDb : []).find(
      (i) => i.id === invoiceId || i.invoiceNo === invoiceId
    );
    if (!inv) return { ok: false, error: "not_found" };

    const amt = Number(paymentDetails.amount || 0);
    if (amt <= 0) return { ok: false, error: "invalid_amount" };

    const mode = paymentDetails.mode || "UPI / Online";
    const ref = paymentDetails.reference || paymentDetails.utr || "";
    const note = paymentDetails.note || "Post-invoice installment";
    const paidAt = paymentDetails.timestamp || paymentDetails.date || new Date().toISOString();

    const d = inv.details || inv;
    const currentTotal = Number(inv.total || d.total || d.grandTotal || 0);
    const existingPaid = Number(inv.paidAmount || d.paidAmount || 0);
    const newPaid = Math.min(currentTotal, existingPaid + amt);
    const newBalance = Math.max(0, currentTotal - newPaid);
    const newStatus = newBalance <= 0.01 ? "Paid" : "Partial";

    // Run self-healing to ensure prior payments are numbered
    window.ensureInvoicePaymentHistory(inv);

    const nextInstallmentNo = inv.paymentHistory.length + 1;
    const newEntry = {
      id: "pay_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      installmentNo: nextInstallmentNo,
      date: paidAt,
      amount: amt,
      mode: mode,
      reference: ref,
      note: note,
      balanceAfter: newBalance,
      status: newStatus
    };
    inv.paymentHistory.push(newEntry);

    // Re-run self-healing and sequential mathematical balance recalculation
    window.ensureInvoicePaymentHistory(inv);

    // Update root and details fields
    inv.paidAmount = newPaid;
    inv.balanceDue = newBalance;
    inv.balancePaid = (inv.balancePaid || 0) + amt;
    inv.paymentStatus = newStatus;
    inv.paymentMode = mode;
    inv.lastPaymentTime = paidAt;
    if (ref) inv.paymentReference = ref;

    if (inv.details) {
      inv.details.paidAmount = newPaid;
      inv.details.balanceDue = newBalance;
      inv.details.balancePaid = (inv.details.balancePaid || 0) + amt;
      inv.details.paymentStatus = newStatus;
      inv.details.paymentMode = mode;
      inv.details.lastPaymentTime = paidAt;
      if (ref) inv.details.paymentReference = ref;
      inv.details.paymentHistory = inv.paymentHistory;
    }

    if (isDemo) {
      try { sessionStorage.setItem("demo_invoices", JSON.stringify(invoicesDb)); } catch(e) {}
      if (typeof loadInvoicesHistoryTable === "function") loadInvoicesHistoryTable();
      if (typeof updateDashboardOverview === "function") updateDashboardOverview();
      if (typeof renderCustomerLedgerSummary === "function") renderCustomerLedgerSummary();
      if (typeof showFloatingToast === "function") {
        showFloatingToast(`✅ Demo Payment Simulated: Recorded Installment #${nextInstallmentNo} of ₹${formatMoney(amt)} on #${inv.invoiceNo || invoiceId} (Demo preview)`, "success", 4000);
      }
      return { ok: true, invoice: inv, installment: newEntry, simulated: true };
    }

    // Save to LocalStorage, IndexedDB, Supabase & Cloud
    try {
      localStorage.setItem("invoices", JSON.stringify(invoicesDb));
    } catch (e) {}

    if (window.AaryanDB && typeof window.AaryanDB.saveInvoice === "function") {
      try { window.AaryanDB.saveInvoice(inv); } catch (e) {}
    }
    if (window.SupabaseDB && window.SupabaseDB.isConfigured()) {
      try { window.SupabaseDB.upsertInvoice(inv); } catch (e) {}
    }
    if (typeof syncDatabaseToServer === "function") {
      try { syncDatabaseToServer("invoices", inv); } catch (e) {}
    }
    if (typeof window.broadcastDatabaseMutation === "function") {
      try { window.broadcastDatabaseMutation(); } catch (e) {}
    }

    // Refresh UI
    if (typeof loadInvoicesHistoryTable === "function") loadInvoicesHistoryTable();
    if (typeof updateDashboardOverview === "function") updateDashboardOverview();
    if (typeof renderRecentInvoicesTable === "function") renderRecentInvoicesTable();
    if (typeof renderCustomerLedgerSummary === "function") renderCustomerLedgerSummary();

    // If Customer Profile modal is currently active, re-render in real time
    if (currentActiveCustomerStatement && currentActiveCustomerStatement.name) {
      const modal = document.getElementById("customer-details-modal");
      if (modal && modal.style.display !== "none") {
        window.openCustomerDetailsModal(currentActiveCustomerStatement.name);
      }
    }

    return { ok: true, invoice: inv, installment: newEntry };
  };

  // --- 3. MULTI-INVOICE FIFO CASCADING SETTLEMENT ---
  window.recordCascadePayment = function (customerIdentifier, totalAmount, paymentDetails) {
    if (!customerIdentifier || Number(totalAmount || 0) <= 0) {
      return { ok: false, error: "invalid_input" };
    }

    const searchTarget = String(customerIdentifier).trim().toLowerCase();
    const allInvs = (window.invoicesDb || []).filter((inv) => {
      if (!inv) return false;
      const d = inv.details || {};
      const buyer = d.buyer || {};
      const consignee = d.consignee || {};
      const cName = String(inv.customerName || consignee.name || buyer.name || "").trim().toLowerCase();
      const phone = String(inv.customerPhone || buyer.phone || consignee.phone || "").replace(/[^0-9]/g, "");
      const cleanTargetPhone = searchTarget.replace(/[^0-9]/g, "");

      return (
        cName === searchTarget ||
        (cleanTargetPhone.length >= 7 && phone.includes(cleanTargetPhone)) ||
        (cName.length >= 3 && (cName.includes(searchTarget) || searchTarget.includes(cName)))
      );
    });

    // Filter pending invoices and sort oldest first (FIFO)
    const pendingInvs = allInvs.filter((i) => {
      const bal = Number(i.balanceDue !== undefined ? i.balanceDue : (i.details?.balanceDue || 0));
      return bal > 0.01;
    }).sort((a, b) => {
      const aDate = new Date(a.date || a.invoiceDate || 0).getTime();
      const bDate = new Date(b.date || b.invoiceDate || 0).getTime();
      return aDate - bDate;
    });

    if (pendingInvs.length === 0) {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("✅ Customer has no pending bills to apply payment to!", "info", 3500);
      }
      return { ok: false, error: "no_pending_bills" };
    }

    let remainingToApply = Number(totalAmount);
    const affected = [];

    for (const inv of pendingInvs) {
      if (remainingToApply <= 0.01) break;
      const invBal = Number(inv.balanceDue !== undefined ? inv.balanceDue : (inv.details?.balanceDue || 0));
      const payPortion = Math.min(remainingToApply, invBal);

      const res = window.recordPostInvoicePayment(inv.id || inv.invoiceNo, {
        ...paymentDetails,
        amount: payPortion,
        note: paymentDetails.note ? `${paymentDetails.note} (Cascade auto-allocated)` : `Cascade lump-sum (Part of ₹${formatMoney(totalAmount)})`
      });

      if (res && res.ok) {
        affected.push({ invoiceNo: inv.invoiceNo, amount: payPortion, balanceAfter: res.invoice.balanceDue });
        remainingToApply -= payPortion;
      }
    }

    return { ok: true, affected, remainingUnallocated: remainingToApply };
  };

  // --- 4. 360-DEGREE CUSTOMER DETAIL & ACCOUNT LEDGER MODAL ---
  let currentActiveCustomerStatement = null;
  window._currentCustDetailTab = "invoices";

  window.openCustomerDetailsModal = function (customerIdentifier) {
    if (!customerIdentifier) return;
    const isViewUser = (typeof window.isViewOnlyUser === 'function') && window.isViewOnlyUser();

    try {
      const searchTarget = String(customerIdentifier).trim().toLowerCase();
      const allInvoicesSource = Array.isArray(window.invoicesDb) ? window.invoicesDb : (typeof invoicesDb !== "undefined" && Array.isArray(invoicesDb) ? invoicesDb : []);

      // Find all invoices associated with this customer
      const allInvs = allInvoicesSource.filter((inv) => {
        if (!inv) return false;
        const d = inv.details || {};
        const buyer = d.buyer || {};
        const consignee = d.consignee || {};
        const cName = String(inv.customerName || consignee.name || buyer.name || "").trim().toLowerCase();
        const phone = String(inv.customerPhone || buyer.phone || consignee.phone || "").replace(/[^0-9]/g, "");
        const cleanTargetPhone = searchTarget.replace(/[^0-9]/g, "");

        return (
          cName === searchTarget ||
          (cleanTargetPhone.length >= 7 && phone.includes(cleanTargetPhone)) ||
          (cName.length >= 3 && (cName.includes(searchTarget) || searchTarget.includes(cName)))
        );
      });

      // Find customer fallback metadata from cache or parties if no invoices
      let primaryCustName = String(customerIdentifier).trim();
      let primaryPhone = "—";
      let primaryAddress = "—";
      let primaryGstin = "—";

      if (window._allCustomersDirectoryCache && Array.isArray(window._allCustomersDirectoryCache)) {
        const found = window._allCustomersDirectoryCache.find(c => c && (c.name || '').trim().toLowerCase() === searchTarget);
        if (found) {
          primaryCustName = found.name || primaryCustName;
          if (found.phone) primaryPhone = found.phone;
          if (found.address) primaryAddress = found.address;
        }
      }
      if (primaryPhone === "—" && window.partiesDb && Array.isArray(window.partiesDb)) {
        const pFound = window.partiesDb.find(p => p && (p.name || '').trim().toLowerCase() === searchTarget);
        if (pFound) {
          primaryCustName = pFound.name || primaryCustName;
          if (pFound.phone) primaryPhone = pFound.phone;
          if (pFound.address) primaryAddress = pFound.address;
          if (pFound.gstin) primaryGstin = pFound.gstin;
        }
      }

      // Calculate customer aggregated metrics
      let totalBilled = 0;
      let totalPaid = 0;
      let totalBalance = 0;
      const allPurchasedProducts = [];
      const allPaymentEntries = [];

      if (allInvs.length > 0) {
        // Sort invoices by date descending
        allInvs.sort((a, b) => {
          const aDate = new Date(a.date || a.invoiceDate || 0).getTime();
          const bDate = new Date(b.date || b.invoiceDate || 0).getTime();
          return bDate - aDate;
        });

        if (allInvs[0].customerName || allInvs[0].details?.buyer?.name || allInvs[0].details?.consignee?.name) {
          primaryCustName = allInvs[0].customerName || allInvs[0].details?.consignee?.name || allInvs[0].details?.buyer?.name;
        }
        if (allInvs[0].customerPhone || allInvs[0].details?.buyer?.phone || allInvs[0].details?.consignee?.phone) {
          primaryPhone = allInvs[0].customerPhone || allInvs[0].details?.buyer?.phone || allInvs[0].details?.consignee?.phone;
        }
        if (allInvs[0].details?.consignee?.address || allInvs[0].details?.buyer?.address) {
          primaryAddress = allInvs[0].details?.consignee?.address || allInvs[0].details?.buyer?.address;
        }
        if (allInvs[0].details?.buyer?.gstin || allInvs[0].details?.consignee?.gstin) {
          primaryGstin = allInvs[0].details?.buyer?.gstin || allInvs[0].details?.consignee?.gstin;
        }

        allInvs.forEach((inv) => {
          if (!inv) return;
          const d = inv.details || {};
          const invNo = inv.invoiceNo || d.invoiceNo || "—";
          const invDate = inv.date || inv.invoiceDate || d.date || d.invoiceDate;
          const invTotal = Number(inv.total || d.total || d.grandTotal || 0);
          const invPaid = Number(inv.paidAmount || d.paidAmount || 0);
          const invBal = Number(inv.balanceDue || d.balanceDue || 0);

          totalBilled += invTotal;
          totalPaid += invPaid;
          totalBalance += invBal;

          // Extract products safely
          const items = Array.isArray(inv.items) ? inv.items : (Array.isArray(d.items) ? d.items : []);
          items.forEach((item) => {
            if (!item) return;
            allPurchasedProducts.push({
              invoiceNo: invNo,
              invoiceId: inv.id,
              date: invDate,
              name: item.name || item.description || "Product",
              quantity: item.quantity || item.qty || 1,
              unit: item.unit || "NOS",
              rate: Number(item.rate || item.price || 0),
              total: Number(item.total || ((item.quantity || 1) * (item.rate || 0)))
            });
          });

          // Ensure full installment history with self-healing
          const history = window.ensureInvoicePaymentHistory(inv);
          history.forEach((p, idx) => {
            if (!p) return;
            allPaymentEntries.push({
              id: p.id || `pay_${inv.id}_${idx}`,
              installmentNo: p.installmentNo || (idx + 1),
              invoiceNo: invNo,
              invoiceId: inv.id,
              date: p.date,
              amount: Number(p.amount || 0),
              mode: p.mode || "Cash",
              reference: p.reference || p.utr || "—",
              note: p.note || (idx === 0 ? "Upfront on-spot billing settlement" : `Installment #${p.installmentNo || (idx + 1)}`),
              balanceAfter: Math.max(0, Math.round((invTotal - history.slice(0, idx + 1).reduce((s, x) => s + (parseFloat(String(x.amount || 0).replace(/,/g, '')) || 0), 0)) * 100) / 100)
            });
          });
        });

        // Sort payments by timestamp descending
        allPaymentEntries.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
      }

      currentActiveCustomerStatement = {
        name: primaryCustName,
        phone: primaryPhone,
        address: primaryAddress,
        gstin: primaryGstin,
        invoices: allInvs,
        products: allPurchasedProducts,
        payments: allPaymentEntries,
        totalBilled,
        totalPaid,
        totalBalance
      };

      // Populate or create modal DOM
      let modal = document.getElementById("customer-details-modal");
      if (!modal || !modal.querySelector(".cust-modal-header")) {
        if (modal) modal.remove();
        modal = createCustomerDetailsModalDOM();
      }
      if (!modal) return;

      const setElText = (id, txt) => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
      };

      // 1. Header Profile details
      setElText("cust-detail-name", primaryCustName);
      setElText("cust-detail-phone", primaryPhone);
      setElText("cust-detail-address", primaryAddress);
      setElText("cust-detail-gstin", (primaryGstin && primaryGstin !== "—") ? primaryGstin : "Unregistered / Retail");

      // Customer avatar initials
      const avatarEl = document.getElementById("cust-detail-avatar");
      if (avatarEl) {
        const words = primaryCustName.trim().split(/\s+/);
        const initials = words.length >= 2 ? (words[0][0] + words[1][0]).toUpperCase() : primaryCustName.slice(0, 2).toUpperCase();
        avatarEl.textContent = initials || "C";
      }

      // Phone link
      const phoneLink = document.getElementById("cust-detail-phone-link");
      if (phoneLink) {
        const cleanPh = primaryPhone.replace(/[^0-9]/g, "");
        if (cleanPh.length >= 10) {
          phoneLink.href = `https://wa.me/91${cleanPh}`;
          phoneLink.title = "Click to chat on WhatsApp";
        } else {
          phoneLink.removeAttribute("href");
        }
      }

      // Outstanding Due Header Badge & Reminder Buttons
      const dueBadge = document.getElementById("cust-header-due-badge");
      const waRemBtn = document.getElementById("cust-header-wa-btn");
      const kpiDueCard = document.getElementById("cust-kpi-card-due");
      const kpiDueLabel = document.getElementById("cust-kpi-label-due");
      const kpiSettleBtn = document.getElementById("cust-kpi-settle-btn");
      const footerSettleBtn = document.getElementById("cust-footer-settle-btn");
      const headerAddInstBtn = document.getElementById("cust-header-add-inst-btn");

      const isDue = totalBalance > 0.01;

      if (isDue) {
        if (dueBadge) {
          dueBadge.style.display = "inline-flex";
          dueBadge.innerHTML = `<span style="background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); padding: 5px 12px; border-radius: 8px; font-weight: 700; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;"><i class="fa-solid fa-triangle-exclamation"></i> Due: ₹ ${formatMoney(totalBalance)}</span>`;
        }
        if (waRemBtn && !isViewUser) waRemBtn.style.display = "inline-flex";
        if (kpiSettleBtn && !isViewUser) kpiSettleBtn.style.display = "inline-flex";
        if (footerSettleBtn && !isViewUser) footerSettleBtn.style.display = "inline-flex";
        if (headerAddInstBtn && !isViewUser) headerAddInstBtn.style.display = "inline-flex";
        if (kpiDueCard) {
          kpiDueCard.className = "cust-modal-kpi-card kpi-due";
          if (kpiDueLabel) {
            kpiDueLabel.style.color = "#dc2626";
            kpiDueLabel.textContent = "Outstanding Due";
          }
        }
      } else {
        if (dueBadge) {
          dueBadge.style.display = "inline-flex";
          dueBadge.innerHTML = `<span style="background: rgba(16, 185, 129, 0.2); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.4); padding: 5px 12px; border-radius: 8px; font-weight: 700; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;"><i class="fa-solid fa-circle-check"></i> Account Clear</span>`;
        }
        if (waRemBtn) waRemBtn.style.display = "none";
        if (kpiSettleBtn) kpiSettleBtn.style.display = "none";
        if (footerSettleBtn) footerSettleBtn.style.display = "none";
        if (headerAddInstBtn) headerAddInstBtn.style.display = "none";
        if (kpiDueCard) {
          kpiDueCard.className = "cust-modal-kpi-card kpi-due-zero";
          if (kpiDueLabel) {
            kpiDueLabel.style.color = "#16a34a";
            kpiDueLabel.textContent = "Balance Status";
          }
        }
      }

      // KPI Numbers
      setElText("cust-detail-total-invoices", allInvs.length);
      setElText("cust-detail-total-billed", "₹ " + formatMoney(totalBilled));
      setElText("cust-detail-total-paid", "₹ " + formatMoney(totalPaid));
      setElText("cust-detail-total-balance", isDue ? "₹ " + formatMoney(totalBalance) : "₹ 0.00 (Clear)");

      // Tab Count Badges
      setElText("cust-tab-badge-invoices", allInvs.length);
      setElText("cust-tab-badge-products", allPurchasedProducts.length);
      setElText("cust-tab-badge-payments", allPaymentEntries.length);

      // Reset search box
      const searchBox = document.getElementById("cust-modal-search");
      if (searchBox) searchBox.value = "";

      // 1. Populate Invoices Table with Installment Accordions
      const invTbody = document.getElementById("cust-detail-invoices-tbody");
      if (invTbody) {
        if (allInvs.length === 0) {
          invTbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted" style="padding: 32px; color: #64748b;"><i class="fa-solid fa-file-invoice" style="font-size: 28px; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>No invoices or bills recorded yet for this customer.</td></tr>`;
        } else {
          invTbody.innerHTML = allInvs
            .map((inv) => {
              if (!inv) return "";
              const d = inv.details || {};
              const invNo = inv.invoiceNo || d.invoiceNo || "—";
              const invDate = inv.date || inv.invoiceDate || d.date || d.invoiceDate || "—";
              const invTotal = Number(inv.total || d.total || d.grandTotal || 0);
              const invPaid = Number(inv.paidAmount || d.paidAmount || 0);
              const invBal = Number(inv.balanceDue || d.balanceDue || 0);
              const status = invBal <= 0.01 ? "PAID" : (invPaid > 0 ? "PARTIAL" : "UNPAID");
              const statusBadge =
                status === "PAID"
                  ? '<span class="badge-status badge-paid" style="background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; font-weight: 800;">PAID</span>'
                  : (status === "PARTIAL"
                      ? '<span class="badge-status badge-partial" style="background: #fffbeb; color: #d97706; border: 1px solid #fde68a; font-weight: 800;">PARTIAL</span>'
                      : '<span class="badge-status badge-unpaid" style="background: #fff1f2; color: #e11d48; border: 1px solid #fecdd3; font-weight: 800;">UNPAID</span>');

              const items = Array.isArray(inv.items) ? inv.items : (Array.isArray(d.items) ? d.items : []);
              const itemsListBrief = items.map(it => it.name || it.description).filter(Boolean);
              const itemsPreview = itemsListBrief.slice(0, 2).join(", ") + (itemsListBrief.length > 2 ? ` (+${itemsListBrief.length - 2} more)` : "");

              const safeInvId = String(inv.id || invNo).replace(/'/g, "\\'");
              const encCustName = encodeURIComponent(primaryCustName);
              const history = window.ensureInvoicePaymentHistory(inv);
              const installmentCount = history.length;

              return `
                <tr class="cust-inv-main-row">
                  <td>
                    <div style="font-weight: 800; color: #0284c7; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;" ${isViewUser ? (invBal > 0.01 ? `onclick="window.openInvoiceVerificationModal('${safeInvId}')" title="Click to Settle Bill #${invNo}"` : `onclick="if(typeof showFloatingToast==='function') showFloatingToast('🔒 Detailed invoice preview is restricted in Demo mode.', 'info', 4000);" title="Bill #${invNo} (Paid)"`) : `onclick="openInvoicePrintPreview('${safeInvId}', 'a4')" title="Open A4 Tax Invoice #${invNo}"`}>
                      <i class="fa-solid fa-file-invoice"></i> #${invNo}
                    </div>
                  </td>
                  <td>
                    <div style="font-weight: 600; color: #334155;">${formatDateTime(invDate)}</div>
                  </td>
                  <td>
                    <div style="font-size: 11.5px; color: #475569;" title="${itemsListBrief.join(', ')}">
                      <strong>${items.length} ${items.length === 1 ? 'item' : 'items'}</strong>
                      ${itemsPreview ? `<div style="color: #64748b; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;">${itemsPreview}</div>` : ''}
                    </div>
                  </td>
                  <td style="text-align: right; font-weight: 800; color: #0f172a;">₹ ${formatMoney(invTotal)}</td>
                  <td style="text-align: right; color: #16a34a; font-weight: 800;">
                    <div>₹ ${formatMoney(invPaid)}</div>
                    ${installmentCount > 0 ? `
                      <button type="button" class="cust-inst-pill-btn" onclick="window.toggleInvoiceInstallments('${safeInvId}')" title="Click to view all ${installmentCount} payment installments">
                        <i class="fa-solid fa-list-ol"></i> ${installmentCount} ${installmentCount === 1 ? 'Inst' : 'Insts'} <i class="fa-solid fa-chevron-down" id="chevron-${safeInvId}"></i>
                      </button>
                    ` : ''}
                  </td>
                  <td style="text-align: right; color: ${invBal > 0.01 ? '#dc2626' : '#64748b'}; font-weight: 800;">₹ ${formatMoney(invBal)}</td>
                  <td style="text-align: center;">${statusBadge}</td>
                  <td style="text-align: center;">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 5px;">
                      ${isViewUser
                        ? (invBal > 0.01
                            ? `<button class="btn btn-xs" onclick="window.openInvoiceVerificationModal('${safeInvId}')" title="Settle Bill #${invNo}" style="background: linear-gradient(135deg, #0284c7, #0369a1); color: #ffffff; border: none; padding: 4px 10px; font-size: 11.5px; font-weight: 700; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(2, 132, 199, 0.35);"><i class="fa-solid fa-bolt" style="color: #38bdf8;"></i> Settle</button>`
                            : `<span class="badge-status badge-paid" style="font-size: 11px; padding: 3px 8px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-circle-check"></i> Paid</span>`
                          )
                        : `
                          ${invBal > 0.01 ? `<button class="btn btn-xs" onclick="window.openRecordInstallmentModal('${safeInvId}', decodeURIComponent('${encCustName}'))" title="Record Next Installment for #${invNo}" style="padding: 4px 8px; font-size: 11px; font-weight: 800; border-radius: 6px; background: #0284c7; color: white; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-plus"></i> Installment</button>` : ''}
                          <button class="action-btn" onclick="openInvoicePrintPreview('${safeInvId}', 'a4')" title="Preview & Print A4 Invoice" style="padding: 5px 8px; border-radius: 6px; border: 1px solid #cbd5e1; background: #ffffff; color: #0284c7; cursor: pointer;"><i class="fa-solid fa-print"></i></button>
                          <button class="action-btn" onclick="if(window.shareInvoiceToWhatsApp) window.shareInvoiceToWhatsApp('${safeInvId}', this)" title="Share Bill on WhatsApp" style="padding: 5px 8px; border-radius: 6px; border: 1px solid rgba(22, 163, 74, 0.3); background: #f0fdf4; color: #16a34a; cursor: pointer;"><i class="fa-brands fa-whatsapp"></i></button>
                        `
                      }
                    </div>
                  </td>
                </tr>

                <!-- Accordion Sub-row: Installment Breakdown -->
                <tr id="inst-accordion-${safeInvId}" class="cust-installment-subrow" style="display: none;">
                  <td colspan="8" style="padding: 0; background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                    <div style="padding: 12px 18px;">
                      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-size: 11.5px; font-weight: 800; color: #0284c7; text-transform: uppercase; letter-spacing: 0.5px;">
                          <i class="fa-solid fa-clock-rotate-left"></i> Payment Installments Breakdown for Bill #${invNo} (${installmentCount} ${installmentCount === 1 ? 'installment' : 'installments'})
                        </span>
                        ${invBal > 0.01 && !isViewUser ? `
                          <button type="button" class="btn btn-xs" onclick="window.openRecordInstallmentModal('${safeInvId}', decodeURIComponent('${encCustName}'))" style="padding: 4px 10px; font-size: 11px; font-weight: 800; background: #0284c7; color: white; border: none; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
                            <i class="fa-solid fa-plus"></i> Add Next Installment
                          </button>
                        ` : ''}
                      </div>
                      ${installmentCount === 0 ? '<div style="color: #64748b; font-size: 11px; padding: 8px 0;">No installments recorded yet for this invoice.</div>' : `
                        <table class="cust-installment-table" style="width: 100%; border-collapse: collapse; font-size: 11.5px; background: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0;">
                          <thead>
                            <tr style="background: #f1f5f9; color: #475569; font-weight: 700; text-align: left;">
                              <th style="padding: 6px 10px; width: 110px;">INSTALLMENT</th>
                              <th style="padding: 6px 10px; width: 160px;">DATE &amp; TIME</th>
                              <th style="padding: 6px 10px; text-align: right; width: 110px;">AMOUNT PAID</th>
                              <th style="padding: 6px 10px; width: 130px;">PAYMENT MODE</th>
                              <th style="padding: 6px 10px;">REFERENCE / UTR / NOTE</th>
                              <th style="padding: 6px 10px; text-align: right; width: 110px;">BALANCE AFTER</th>
                              <th style="padding: 6px 10px; text-align: center; width: 100px;">RECEIPT</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${history.map((inst, idx) => `
                              <tr style="border-bottom: 1px solid #f1f5f9;">
                                <td style="padding: 6px 10px; font-weight: 800; color: #0284c7;">
                                  <span style="background: #e0f2fe; padding: 2px 6px; border-radius: 4px;">#${inst.installmentNo || (idx + 1)}</span>
                                  ${idx === 0 && (inst.note || '').includes('spot') ? '<span style="font-size: 10px; color: #64748b; margin-left: 3px;">(Upfront)</span>' : ''}
                                </td>
                                <td style="padding: 6px 10px; color: #334155; font-weight: 600;">${formatDateTime(inst.date)}</td>
                                <td style="padding: 6px 10px; text-align: right; font-weight: 800; color: #16a34a;">₹ ${formatMoney(inst.amount)}</td>
                                <td style="padding: 6px 10px;">
                                  <span style="background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; padding: 2px 6px; border-radius: 4px; font-weight: 700;">${inst.mode || 'Cash'}</span>
                                </td>
                                <td style="padding: 6px 10px; color: #475569;">
                                  ${inst.reference && inst.reference !== '—' ? `<strong>Ref:</strong> <span style="font-family: monospace;">${inst.reference}</span> ` : ''}
                                  ${inst.note && inst.note !== '—' ? `<span style="color: #64748b;">(${inst.note})</span>` : ''}
                                </td>
                                <td style="padding: 6px 10px; text-align: right; font-weight: 700; color: ${(function(){
                                  const exact = Math.max(0, Math.round((invTotal - history.slice(0, idx + 1).reduce((s, x) => s + (parseFloat(String(x.amount || 0).replace(/,/g, '')) || 0), 0)) * 100) / 100);
                                  inst.balanceAfter = exact;
                                  return exact > 0.01 ? '#dc2626' : '#16a34a';
                                })()};">
                                  ₹ ${formatMoney(inst.balanceAfter)}
                                </td>
                                <td style="padding: 6px 10px; text-align: center;">
                                  <button type="button" class="btn btn-xs" onclick="window.shareInstallmentReceiptWhatsApp('${safeInvId}', '${inst.id || idx}')" title="Send Installment Receipt to Customer via WhatsApp" style="background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;">
                                    <i class="fa-brands fa-whatsapp"></i> Receipt
                                  </button>
                                </td>
                              </tr>
                            `).join('')}
                          </tbody>
                        </table>
                      `}
                    </div>
                  </td>
                </tr>
              `;
            })
            .join("");
        }
      }

      // 2. Populate Products Purchased Table
      const prodTbody = document.getElementById("cust-detail-products-tbody");
      const prodSummary = document.getElementById("cust-products-summary-strip");
      if (prodTbody) {
        if (allPurchasedProducts.length === 0) {
          prodTbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding: 32px; color: #64748b;"><i class="fa-solid fa-boxes-stacked" style="font-size: 28px; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>No item purchase history available.</td></tr>';
          if (prodSummary) prodSummary.textContent = "No products purchased yet.";
        } else {
          prodTbody.innerHTML = allPurchasedProducts
            .map((p) => {
              const safeInvRef = String(p.invoiceId || p.invoiceNo).replace(/'/g, "\\'");
              return `
                <tr>
                  <td style="font-weight: 700; color: #0f172a;">${p.name}</td>
                  <td>
                    <span style="color: #0284c7; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="openInvoicePrintPreview('${safeInvRef}', 'a4')" title="Open Bill #${p.invoiceNo}">
                      <i class="fa-solid fa-file-invoice"></i> #${p.invoiceNo}
                    </span>
                  </td>
                  <td style="color: #475569;">${formatDateTime(p.date)}</td>
                  <td style="text-align: center;">
                    <span style="background: #f1f5f9; padding: 3px 8px; border-radius: 6px; font-weight: 700; color: #334155;">${p.quantity} ${p.unit}</span>
                  </td>
                  <td style="text-align: right; color: #475569;">₹ ${formatMoney(p.rate)}</td>
                  <td style="text-align: right; font-weight: 800; color: #0f172a;">₹ ${formatMoney(p.total)}</td>
                </tr>
              `;
            })
            .join("");

          const totalProdSum = allPurchasedProducts.reduce((sum, p) => sum + (p.total || 0), 0);
          if (prodSummary) {
            prodSummary.innerHTML = `
              <span>Total Line Items: <strong>${allPurchasedProducts.length}</strong></span>
              <span>Cumulative Product Value: <strong style="color: #0284c7;">₹ ${formatMoney(totalProdSum)}</strong></span>
            `;
          }
        }
      }

      // 3. Populate Payments Timeline Log Table (All installments across all bills)
      const payTbody = document.getElementById("cust-detail-payments-tbody");
      const paySummary = document.getElementById("cust-payments-summary-strip");
      if (payTbody) {
        if (allPaymentEntries.length === 0) {
          payTbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding: 32px; color: #64748b;"><i class="fa-solid fa-receipt" style="font-size: 28px; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>No recorded payment entries yet.</td></tr>';
          if (paySummary) paySummary.textContent = "No payments logged yet.";
        } else {
          payTbody.innerHTML = allPaymentEntries
            .map((pay) => {
              const safeInvRef = String(pay.invoiceId || pay.invoiceNo).replace(/'/g, "\\'");
              const safePayId = String(pay.id || pay.installmentNo).replace(/'/g, "\\'");
              return `
                <tr>
                  <td style="font-weight: 800; color: #0284c7;">
                    <span style="background: #e0f2fe; padding: 3px 8px; border-radius: 6px; border: 1px solid #bae6fd; font-size: 11.5px;">
                      Inst #${pay.installmentNo || 1}
                    </span>
                  </td>
                  <td style="font-weight: 700; color: #334155;">${formatDateTime(pay.date)}</td>
                  <td>
                    <span style="color: #0284c7; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="openInvoicePrintPreview('${safeInvRef}', 'a4')" title="Open Bill #${pay.invoiceNo}">
                      <i class="fa-solid fa-file-invoice"></i> #${pay.invoiceNo}
                    </span>
                  </td>
                  <td style="text-align: right; font-weight: 800; color: #16a34a; font-size: 13.5px;">₹ ${formatMoney(pay.amount)}</td>
                  <td style="text-align: right; font-weight: 700; color: ${(pay.balanceAfter || 0) > 0.01 ? '#dc2626' : '#16a34a'}; font-size: 13px;">₹ ${formatMoney(pay.balanceAfter || 0)}</td>
                  <td>
                    <span class="badge-status badge-paid" style="background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd; font-weight: 700; padding: 3px 8px; border-radius: 6px;">
                      <i class="fa-solid fa-money-bill-wave"></i> ${pay.mode}
                    </span>
                  </td>
                  <td style="font-size: 12px; color: #475569;">
                    ${pay.reference !== '—' ? `<strong>Ref:</strong> <span style="font-family: monospace; color: #0f172a; font-weight: 700;">${pay.reference}</span> ` : ''}
                    ${pay.note !== '—' ? `<span style="color: #64748b;">(${pay.note})</span>` : ''}
                  </td>
                  <td style="text-align: center;">
                    <button type="button" class="btn btn-xs" onclick="window.shareInstallmentReceiptWhatsApp('${safeInvRef}', '${safePayId}')" title="Share WhatsApp Receipt" style="background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 11.5px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">
                      <i class="fa-brands fa-whatsapp"></i> Receipt
                    </button>
                  </td>
                </tr>
              `;
            })
            .join("");

          if (paySummary) {
            paySummary.innerHTML = `
              <span>Total Installment Receipts: <strong>${allPaymentEntries.length}</strong></span>
              <span>Total Received &amp; Reconciled: <strong style="color: #059669;">₹ ${formatMoney(totalPaid)}</strong></span>
            `;
          }
        }
      }

      // Reset active tab to Invoices
      if (typeof window.switchCustDetailTab === "function") {
        window.switchCustDetailTab("invoices");
      }

      // Update statement buttons visibility based on view-only status
      const stmtActions = document.getElementById("cust-modal-statement-actions");
      if (stmtActions) {
        stmtActions.style.display = isViewUser ? "none" : "flex";
      }

      // Show modal
      modal.classList.remove("hidden");
      modal.style.setProperty("display", "flex", "important");
      modal.style.setProperty("visibility", "visible", "important");
      modal.style.setProperty("opacity", "1", "important");
      modal.style.setProperty("pointer-events", "auto", "important");
      modal.style.setProperty("z-index", "2147483645", "important");
    } catch (err) {
      console.error("[CustomerTimeline] Error opening customer modal:", err);
      if (typeof showFloatingToast === "function") {
        showFloatingToast("⚠️ Could not open customer details: " + (err.message || "Unknown error"), "warning", 3500);
      }
    }
  };

  // Toggle accordion sub-row in customer profile
  window.toggleInvoiceInstallments = function (invId) {
    const row = document.getElementById(`inst-accordion-${invId}`);
    const chevron = document.getElementById(`chevron-${invId}`);
    if (!row) return;
    const isHidden = row.style.display === "none";
    row.style.display = isHidden ? "table-row" : "none";
    if (chevron) {
      chevron.className = isHidden ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
    }
  };

  window.filterCustModalRows = function (query) {
    const q = String(query || '').toLowerCase().trim();
    const currentTab = window._currentCustDetailTab || 'invoices';
    const pane = document.getElementById(`pane-cust-tab-${currentTab}`);
    if (!pane) return;
    const rows = pane.querySelectorAll('tbody tr.cust-inv-main-row, tbody tr:not(.cust-installment-subrow)');
    rows.forEach(row => {
      if (row.querySelector('td[colspan]')) return;
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  };

  window.settleCustomerTopDueBill = function () {
    if (!currentActiveCustomerStatement || !Array.isArray(currentActiveCustomerStatement.invoices)) return;
    const dueInv = currentActiveCustomerStatement.invoices.find(i => {
      const bal = Number(i.balanceDue !== undefined ? i.balanceDue : (i.details?.balanceDue || 0));
      return bal > 0.01;
    });
    if (dueInv) {
      window.openRecordInstallmentModal(dueInv.id || dueInv.invoiceNo, currentActiveCustomerStatement.name);
    } else {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("✅ Customer has no pending balance to settle!", "success");
      }
    }
  };

  // --- 5. DEDICATED RECORD INSTALLMENT MODAL CONTROLLER ---
  let activeInstallmentModalTarget = null;

  window.openRecordInstallmentModal = function (targetInvoiceId, targetCustomerName) {
    const isDemo = (typeof window.isDemoMode === 'function') && window.isDemoMode();
    if (!isDemo && typeof window.isViewOnlyUser === 'function' && window.isViewOnlyUser()) {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("⛔ Access Denied: Payment recording is disabled in View-Only mode.", "error", 4000);
      }
      return;
    }

    let modal = document.getElementById("record-installment-modal");
    if (!modal) {
      modal = createRecordInstallmentModalDOM();
    }
    if (!modal) return;

    const allInvs = Array.isArray(window.invoicesDb) ? window.invoicesDb : [];
    let targetInv = null;
    if (targetInvoiceId) {
      targetInv = allInvs.find(i => i && (i.id === targetInvoiceId || i.invoiceNo === targetInvoiceId));
      if (targetInv && !targetCustomerName) {
        targetCustomerName = targetInv.customerName || targetInv.details?.consignee?.name || targetInv.details?.buyer?.name;
      }
    }

    if (!targetCustomerName && currentActiveCustomerStatement && currentActiveCustomerStatement.name) {
      targetCustomerName = currentActiveCustomerStatement.name;
    }

    // Filter pending invoices for this customer
    const searchTarget = String(targetCustomerName || '').trim().toLowerCase();
    const custPendingInvs = allInvs.filter(i => {
      if (!i) return false;
      const d = i.details || {};
      const cName = String(i.customerName || d.consignee?.name || d.buyer?.name || "").trim().toLowerCase();
      const bal = Number(i.balanceDue !== undefined ? i.balanceDue : (d.balanceDue || 0));
      if (searchTarget) {
        return cName === searchTarget && bal > 0.01;
      }
      return bal > 0.01;
    });

    const totalCustDue = custPendingInvs.reduce((sum, i) => {
      const b = Number(i.balanceDue !== undefined ? i.balanceDue : (i.details?.balanceDue || 0));
      return sum + b;
    }, 0);

    activeInstallmentModalTarget = {
      customerName: targetCustomerName || (targetInv ? targetInv.customerName : "Customer"),
      targetInvoiceId: targetInvoiceId,
      pendingInvoices: custPendingInvs,
      totalDue: totalCustDue
    };

    // Update Header Labels
    const nameEl = document.getElementById("inst-modal-cust-name");
    const dueEl = document.getElementById("inst-modal-cust-due");
    if (nameEl) nameEl.textContent = activeInstallmentModalTarget.customerName || "Customer";
    if (dueEl) dueEl.textContent = `₹ ${formatMoney(totalCustDue)}`;

    // Populate Invoices Dropdown
    const selectEl = document.getElementById("inst-modal-invoice-select");
    if (selectEl) {
      let opts = '';
      if (custPendingInvs.length > 1) {
        opts += `<option value="__CASCADE__">✨ Auto-Distribute across oldest pending bills (Cascade Settlement)</option>`;
      }
      if (custPendingInvs.length > 0) {
        opts += custPendingInvs.map(inv => {
          const bal = Number(inv.balanceDue !== undefined ? inv.balanceDue : (inv.details?.balanceDue || 0));
          const tot = Number(inv.total || inv.details?.total || inv.details?.grandTotal || 0);
          const invNo = inv.invoiceNo || inv.details?.invoiceNo || '—';
          const isSelected = targetInv && (targetInv.id === inv.id || targetInv.invoiceNo === inv.invoiceNo);
          return `<option value="${inv.id || invNo}" ${isSelected ? 'selected' : ''}>Invoice #${invNo} — Balance: ₹${formatMoney(bal)} (Total: ₹${formatMoney(tot)})</option>`;
        }).join('');
      } else if (targetInv) {
        opts = `<option value="${targetInv.id}" selected>Invoice #${targetInv.invoiceNo} — Settled / Balance: ₹${formatMoney(targetInv.balanceDue || 0)}</option>`;
      } else {
        opts = `<option value="">No pending invoices found for this customer</option>`;
      }
      selectEl.innerHTML = opts;
    }

    // Set default amount
    window.updateInstallmentModalFieldsFromSelect();

    // Set payment datetime to current local timestamp
    const dtInput = document.getElementById("inst-modal-datetime");
    if (dtInput) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      dtInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    // Clear reference and notes
    const refInput = document.getElementById("inst-modal-ref");
    if (refInput) refInput.value = "";
    const noteInput = document.getElementById("inst-modal-note");
    if (noteInput) noteInput.value = "";

    // Reset Dynamic QR code
    const qrBox = document.getElementById("inst-modal-qr-preview-box");
    if (qrBox) qrBox.style.display = "none";
    const qrToggleLabel = document.getElementById("inst-modal-qr-toggle-label");
    if (qrToggleLabel) qrToggleLabel.textContent = "Show Instant UPI QR Code";

    // Show modal
    modal.classList.remove("hidden");
    modal.style.setProperty("display", "flex", "important");
    modal.style.setProperty("visibility", "visible", "important");
    modal.style.setProperty("opacity", "1", "important");
    modal.style.setProperty("pointer-events", "auto", "important");
    modal.style.setProperty("z-index", "2147483646", "important");
  };

  window.closeRecordInstallmentModal = function () {
    const modal = document.getElementById("record-installment-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.style.setProperty("display", "none", "important");
      modal.style.setProperty("visibility", "hidden", "important");
      modal.style.setProperty("pointer-events", "none", "important");
    }
  };

  window.updateInstallmentModalFieldsFromSelect = function () {
    const selectEl = document.getElementById("inst-modal-invoice-select");
    const amtInput = document.getElementById("inst-modal-amount");
    const hintEl = document.getElementById("inst-modal-pending-hint");
    if (!selectEl || !amtInput) return;

    const val = selectEl.value;
    if (val === "__CASCADE__") {
      const totDue = activeInstallmentModalTarget?.totalDue || 0;
      amtInput.value = totDue.toFixed(2);
      if (hintEl) hintEl.textContent = `Total Due Across All Bills: ₹ ${formatMoney(totDue)}`;
    } else if (val) {
      const inv = (window.invoicesDb || []).find(i => i && (i.id === val || i.invoiceNo === val));
      if (inv) {
        const bal = Number(inv.balanceDue !== undefined ? inv.balanceDue : (inv.details?.balanceDue || 0));
        amtInput.value = bal.toFixed(2);
        if (hintEl) hintEl.textContent = `Pending on Bill #${inv.invoiceNo}: ₹ ${formatMoney(bal)}`;
      }
    }
  };

  window.setInstallmentQuickAmt = function (preset) {
    const selectEl = document.getElementById("inst-modal-invoice-select");
    const amtInput = document.getElementById("inst-modal-amount");
    if (!amtInput) return;

    let targetBal = 0;
    if (selectEl && selectEl.value === "__CASCADE__") {
      targetBal = activeInstallmentModalTarget?.totalDue || 0;
    } else if (selectEl && selectEl.value) {
      const inv = (window.invoicesDb || []).find(i => i && (i.id === selectEl.value || i.invoiceNo === selectEl.value));
      if (inv) targetBal = Number(inv.balanceDue !== undefined ? inv.balanceDue : (inv.details?.balanceDue || 0));
    }

    if (preset === 'full') {
      amtInput.value = targetBal.toFixed(2);
    } else if (preset === 'half') {
      amtInput.value = (targetBal / 2).toFixed(2);
    } else if (typeof preset === 'number') {
      amtInput.value = Math.min(preset, targetBal > 0 ? targetBal : preset).toFixed(2);
    }
    amtInput.focus();
  };

  window.toggleInstallmentDynamicQr = function () {
    const qrBox = document.getElementById("inst-modal-qr-preview-box");
    const qrToggleLabel = document.getElementById("inst-modal-qr-toggle-label");
    const amtInput = document.getElementById("inst-modal-amount");
    const selectEl = document.getElementById("inst-modal-invoice-select");
    if (!qrBox) return;

    const isHidden = qrBox.style.display === "none";
    if (isHidden) {
      const amt = parseFloat(amtInput?.value) || 0;
      if (amt <= 0) {
        if (typeof showFloatingToast === 'function') showFloatingToast("⚠️ Please enter a valid payment amount first.", "warning");
        return;
      }

      const realUpi = (window.globalSettings?.upiId || window.globalSettings?.bank?.upi || "7386262139@upi").trim();
      const compName = encodeURIComponent((window.globalSettings?.company?.name || "Aaryan Aqua Needs").replace(/[^a-zA-Z0-9 ]/g, '').trim());
      const invNote = selectEl?.value === "__CASCADE__" ? "AccountSettlement" : `Bill${String(selectEl?.value || 'Settlement').slice(-8)}`;
      const upiUri = `upi://pay?pa=${realUpi}&pn=${compName}&am=${amt.toFixed(2)}&cu=INR&tn=${invNote}`;

      const canvas = document.getElementById("inst-modal-qr-canvas");
      const imgEl = document.getElementById("inst-modal-qr-img");
      const amtLabel = document.getElementById("inst-modal-qr-amt-label");
      if (amtLabel) amtLabel.textContent = `Pay ₹ ${formatMoney(amt)} via UPI`;

      let rendered = false;
      if (canvas && typeof QRious !== "undefined") {
        try {
          new QRious({
            element: canvas,
            value: upiUri,
            size: 260,
            level: 'H'
          });
          canvas.style.display = "block";
          if (imgEl) imgEl.style.display = "none";
          rendered = true;
        } catch (e) {}
      }
      if (!rendered && imgEl) {
        if (canvas) canvas.style.display = "none";
        imgEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(upiUri)}`;
        imgEl.style.display = "block";
      }

      qrBox.style.display = "block";
      if (qrToggleLabel) qrToggleLabel.textContent = "Hide UPI QR Code";
    } else {
      qrBox.style.display = "none";
      if (qrToggleLabel) qrToggleLabel.textContent = "Show Instant UPI QR Code";
    }
  };

  window.submitRecordInstallment = function (shareWhatsApp) {
    if (typeof window.isViewOnlyUser === 'function' && window.isViewOnlyUser()) {
      if (typeof showFloatingToast === 'function') showFloatingToast("⛔ Access Denied: View-Only mode.", "error");
      return;
    }

    const selectEl = document.getElementById("inst-modal-invoice-select");
    const amtInput = document.getElementById("inst-modal-amount");
    const modeSelect = document.getElementById("inst-modal-mode");
    const refInput = document.getElementById("inst-modal-ref");
    const dtInput = document.getElementById("inst-modal-datetime");
    const noteInput = document.getElementById("inst-modal-note");

    const amt = parseFloat(amtInput?.value) || 0;
    if (amt <= 0) {
      if (typeof showFloatingToast === 'function') showFloatingToast("⚠️ Please enter a valid payment amount greater than zero.", "warning");
      return;
    }

    const selectedInvId = selectEl?.value;
    if (!selectedInvId) {
      if (typeof showFloatingToast === 'function') showFloatingToast("⚠️ Please select an invoice.", "warning");
      return;
    }

    const mode = modeSelect?.value || "UPI / QR Code";
    const ref = refInput?.value?.trim() || "";
    const note = noteInput?.value?.trim() || "";
    const timestamp = dtInput?.value ? new Date(dtInput.value).toISOString() : new Date().toISOString();

    let result = null;
    let targetInvIdForReceipt = selectedInvId;

    if (selectedInvId === "__CASCADE__") {
      result = window.recordCascadePayment(activeInstallmentModalTarget?.customerName, amt, {
        mode,
        reference: ref,
        note,
        timestamp
      });
      if (!result.ok) {
        if (typeof showFloatingToast === 'function') showFloatingToast("⚠️ Could not process cascade settlement.", "warning");
        return;
      }
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`✅ Cascade Payment Recorded: ₹ ${formatMoney(amt)} distributed across ${result.affected.length} bills!`, "success", 4500);
      }
      if (result.affected && result.affected.length > 0) {
        targetInvIdForReceipt = result.affected[0].invoiceNo;
      }
    } else {
      result = window.recordPostInvoicePayment(selectedInvId, {
        amount: amt,
        mode,
        reference: ref,
        note,
        timestamp
      });
      if (!result.ok) {
        if (typeof showFloatingToast === 'function') showFloatingToast("⚠️ Failed to record installment.", "error");
        return;
      }
      const invNo = result.invoice?.invoiceNo || selectedInvId;
      if (typeof showFloatingToast === 'function') {
        showFloatingToast(`✅ Installment #${result.installment?.installmentNo || ''} (₹ ${formatMoney(amt)}) recorded for Bill #${invNo}!`, "success", 4500);
      }
    }

    // Close installment modal
    window.closeRecordInstallmentModal();

    // Refresh Customer Statement & Overview tables immediately so subsequent actions work without reloading
    const activeCustName = activeInstallmentModalTarget?.customerName || currentActiveCustomerStatement?.name;
    if (activeCustName && typeof window.openCustomerDetailsModal === 'function') {
      try { window.openCustomerDetailsModal(activeCustName); } catch(e){}
    }
    if (typeof renderCustomerLedgerSummary === 'function') renderCustomerLedgerSummary();
    if (typeof window.renderCustomersDirectoryView === 'function') window.renderCustomersDirectoryView();
    if (typeof updateDashboardOverview === 'function') updateDashboardOverview();
    if (typeof loadInvoicesHistoryTable === 'function') loadInvoicesHistoryTable();
    if (typeof renderRecentInvoicesTable === 'function') renderRecentInvoicesTable();

    // Trigger WhatsApp receipt if requested
    if (shareWhatsApp && targetInvIdForReceipt) {
      const instId = result?.installment?.id;
      setTimeout(() => {
        window.shareInstallmentReceiptWhatsApp(targetInvIdForReceipt, instId);
      }, 300);
    }
  };

  // --- 6. 1-CLICK WHATSAPP INSTALLMENT RECEIPT ---
  window.shareInstallmentReceiptWhatsApp = function (invId, instIdOrIdx) {
    const inv = (typeof invoicesDb !== "undefined" ? invoicesDb : []).find(i => i && (i.id === invId || i.invoiceNo === invId));
    if (!inv) return;
    const history = window.ensureInvoicePaymentHistory(inv);
    let inst = history.find(p => p && (p.id === instIdOrIdx || p.installmentNo === Number(instIdOrIdx)));
    if (!inst && !isNaN(Number(instIdOrIdx))) {
      inst = history[Number(instIdOrIdx)];
    }
    if (!inst) inst = history[history.length - 1]; // fallback to latest
    if (!inst) return;

    const d = inv.details || {};
    const buyer = d.buyer || {};
    const consignee = d.consignee || {};
    const custName = inv.customerName || consignee.name || buyer.name || "Customer";
    const phone = (inv.customerPhone || buyer.phone || consignee.phone || "").replace(/[^0-9]/g, "");

    const invNo = inv.invoiceNo || d.invoiceNo || "—";
    const invTotal = Number(inv.total || d.total || d.grandTotal || 0);
    const invPaid = Number(inv.paidAmount || d.paidAmount || 0);
    const invBal = Number(inv.balanceDue || d.balanceDue || 0);

    const realUpi = (window.globalSettings?.upiId || window.globalSettings?.bank?.upi || "7386262139@upi").trim();

    let text = `🙏 *Payment Installment Receipt - Aaryan Aqua Needs* 🌊\n` +
      `-----------------------------------\n` +
      `👤 *Customer:* *${custName}*\n` +
      `📄 *Invoice No:* *#${invNo}*\n` +
      `🔢 *Installment:* *Installment #${inst.installmentNo || 1}*` + (inst.note ? ` (${inst.note})` : '') + `\n` +
      `💵 *Amount Received:* *₹ ${formatMoney(inst.amount)}*\n` +
      `💳 *Payment Mode:* *${inst.mode || 'Cash'}*\n` +
      `${inst.reference && inst.reference !== '—' ? `🔗 *UTR / Reference:* ${inst.reference}\n` : ''}` +
      `🕒 *Payment Date:* ${formatDateTime(inst.date)}\n` +
      `-----------------------------------\n` +
      `📊 *Total Invoice Value:* ₹ ${formatMoney(invTotal)}\n` +
      `✅ *Total Paid So Far:* ₹ ${formatMoney(invPaid)} (${history.length} ${history.length === 1 ? 'installment' : 'installments'})\n` +
      `${invBal > 0.01 
        ? `🔴 *Remaining Balance on this Bill:* *₹ ${formatMoney(invBal)}*\n\n⚡ *Instant UPI Settlement Link:*\nupi://pay?pa=${realUpi}&pn=AaryanAquaNeeds&am=${invBal.toFixed(2)}&cu=INR&tn=Bill${invNo}` 
        : `🎉 *Status:* FULLY SETTLED & PAID IN FULL ✅`}\n` +
      `-----------------------------------\n` +
      `Thank you for your valued business! 🙏✨`;

    if (phone && phone.length >= 10) {
      window.open(`https://wa.me/91${phone}?text=${encodeURIComponent(text)}`, "_blank");
    } else {
      const customPhone = prompt("Enter customer WhatsApp phone number:", "");
      if (customPhone) {
        const clean = customPhone.replace(/[^0-9]/g, "");
        if (clean) window.open(`https://wa.me/91${clean}?text=${encodeURIComponent(text)}`, "_blank");
      }
    }

    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`📲 Installment receipt prepared for ${custName}!`, "success", 4000);
    }
  };

  // --- 7. PRINTABLE A4 CUSTOMER STATEMENT ---
  window.printCustomerStatement = function () {
    if (!currentActiveCustomerStatement) return;
    const s = currentActiveCustomerStatement;
    const comp = (window.globalSettings && window.globalSettings.company) || {};
    const bank = (window.globalSettings && window.globalSettings.bank) || {};
    const upiId = (window.globalSettings && window.globalSettings.upiId) || "7386262139@upi";

    const printWin = window.open("", "_blank", "width=900,height=950");
    if (!printWin) {
      window.print();
      return;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Customer Account Statement - ${s.name}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; padding: 28px; color: #0f172a; margin: 0; }
          .header-box { border-bottom: 2.5px solid #0284c7; padding-bottom: 14px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
          .company-name { font-size: 22px; font-weight: 800; color: #0284c7; letter-spacing: -0.5px; }
          .company-sub { font-size: 11.5px; color: #475569; margin-top: 3px; max-width: 450px; line-height: 1.4; }
          .statement-badge { font-size: 12px; font-weight: 700; background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 6px; display: inline-block; margin-bottom: 6px; }
          .cust-info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 16px; margin-bottom: 20px; display: flex; justify-content: space-between; gap: 16px; font-size: 12px; }
          .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }
          .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; background: #ffffff; }
          .kpi-label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #64748b; }
          .kpi-val { font-size: 16px; font-weight: 800; margin-top: 3px; color: #0f172a; }
          .section-title { font-size: 14px; font-weight: 800; color: #1e293b; margin: 18px 0 8px 0; display: flex; justify-content: space-between; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 11.5px; }
          th, td { border: 1px solid #e2e8f0; padding: 7px 9px; text-align: left; }
          th { background: #f1f5f9; font-weight: 700; color: #475569; text-transform: uppercase; font-size: 10px; }
          .text-right { text-align: right; }
          .text-center { text-align: center; }
          .bank-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 14px; font-size: 11.5px; margin-top: 20px; display: flex; justify-content: space-between; align-items: center; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="header-box">
          <div>
            <div class="company-name">${comp.name || "AARYAN AQUA NEEDS"}</div>
            <div class="company-sub">
              ${comp.tagline ? `<strong>${comp.tagline}</strong><br>` : ''}
              ${(comp.address || "").replace(/\n/g, ', ')}<br>
              Phone: ${comp.phones || "+91 74166 05652"} • Email: ${comp.email || "aaryanaquaneeds@gmail.com"}<br>
              GSTIN: <strong>${comp.gstin || "37ACNFA4687Q1ZC"}</strong>
            </div>
          </div>
          <div style="text-align: right;">
            <div class="statement-badge">CUSTOMER ACCOUNT STATEMENT</div>
            <div style="font-size: 12px; color: #475569; margin-top: 4px;">
              <strong>Statement Date:</strong> ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}<br>
              <strong>Statement Time:</strong> ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
            </div>
          </div>
        </div>

        <div class="cust-info-box">
          <div>
            <div style="font-size: 14px; font-weight: 800; color: #0f172a;">${s.name}</div>
            <div style="color: #64748b; margin-top: 3px;">
              Phone: <strong>${s.phone || '—'}</strong><br>
              Address: ${s.address || '—'}
            </div>
          </div>
          <div style="text-align: right;">
            <div>GSTIN: <strong>${s.gstin || 'Unregistered'}</strong></div>
            <div style="margin-top: 3px;">Total Bills: <strong>${s.invoices.length}</strong></div>
          </div>
        </div>

        <div class="kpi-row">
          <div class="kpi">
            <div class="kpi-label">Total Invoices</div>
            <div class="kpi-val">${s.invoices.length}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Total Purchases</div>
            <div class="kpi-val" style="color: #0284c7;">₹ ${formatMoney(s.totalBilled)}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Cleared / Received</div>
            <div class="kpi-val" style="color: #16a34a;">₹ ${formatMoney(s.totalPaid)}</div>
          </div>
          <div class="kpi" style="${s.totalBalance > 0.01 ? 'border-color: #fca5a5; background: #fff5f5;' : 'border-color: #a7f3d0; background: #f0fdf4;'}">
            <div class="kpi-label" style="color: ${s.totalBalance > 0.01 ? '#dc2626' : '#16a34a'};">Current Balance Due</div>
            <div class="kpi-val" style="color: ${s.totalBalance > 0.01 ? '#dc2626' : '#16a34a'};">₹ ${formatMoney(s.totalBalance)}</div>
          </div>
        </div>

        <div class="section-title">
          <span>Invoices &amp; Billing History</span>
          <span style="font-size: 11.5px; font-weight: normal; color: #64748b;">${s.invoices.length} bill(s)</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Bill Date &amp; Time</th>
              <th class="text-right">Grand Total</th>
              <th class="text-right">Paid Amount</th>
              <th class="text-right">Balance Due</th>
              <th class="text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            ${s.invoices.length === 0 ? '<tr><td colspan="6" class="text-center">No invoices recorded.</td></tr>' : s.invoices.map(inv => `
              <tr>
                <td style="font-weight: bold; color: #0284c7;">#${inv.invoiceNo || '—'}</td>
                <td>${formatDateTime(inv.date || inv.invoiceDate)}</td>
                <td class="text-right">₹ ${formatMoney(inv.total || inv.grandTotal)}</td>
                <td class="text-right" style="color: #16a34a; font-weight: bold;">₹ ${formatMoney(inv.paidAmount)}</td>
                <td class="text-right" style="color: ${(inv.balanceDue || 0) > 0.01 ? '#dc2626' : '#475569'}; font-weight: bold;">₹ ${formatMoney(inv.balanceDue)}</td>
                <td class="text-center">${(inv.balanceDue || 0) <= 0.01 ? '<strong style="color: #16a34a;">PAID</strong>' : '<strong style="color: #dc2626;">PENDING</strong>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="section-title">
          <span>Payment Receipts &amp; Installments Log</span>
          <span style="font-size: 11.5px; font-weight: normal; color: #64748b;">${s.payments.length} installment receipt(s)</span>
        </div>
        <table>
          <thead>
            <tr>
              <th style="width: 70px;">Inst #</th>
              <th>Payment Timestamp</th>
              <th>Bill #</th>
              <th class="text-right">Amount Received</th>
              <th class="text-right">Balance After</th>
              <th>Payment Mode</th>
              <th>UTR / Reference / Note</th>
            </tr>
          </thead>
          <tbody>
            ${s.payments.length === 0 ? '<tr><td colspan="6" class="text-center">No recorded payment receipts.</td></tr>' : s.payments.map(p => `
              <tr>
                <td style="font-weight: bold; color: #0284c7;">#${p.installmentNo || 1}</td>
                <td>${formatDateTime(p.date)}</td>
                <td style="font-weight: bold; color: #0284c7;">#${p.invoiceNo}</td>
                <td class="text-right" style="color: #16a34a; font-weight: bold;">₹ ${formatMoney(p.amount)}</td>
                <td class="text-right" style="color: ${(p.balanceAfter || 0) > 0.01 ? '#dc2626' : '#16a34a'}; font-weight: bold;">₹ ${formatMoney(p.balanceAfter || 0)}</td>
                <td><strong>${p.mode}</strong></td>
                <td>${p.reference || '—'} ${p.note && p.note !== '—' ? `(${p.note})` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        ${s.totalBalance > 0.01 ? `
          <div class="bank-box">
            <div>
              <strong>Bank Details for Settlement:</strong><br>
              Bank: ${bank.name || 'State Bank of India'} • A/C No: ${bank.accountNo || '45413424177'} • IFSC: ${bank.ifsc || 'SBIN0000911'} (${bank.branch || 'Repalle'})<br>
              Instant UPI ID: <strong>${upiId}</strong>
            </div>
            <div style="text-align: right;">
              <span style="font-size: 13px; font-weight: 800; color: #dc2626;">Amount Payable: ₹ ${formatMoney(s.totalBalance)}</span>
            </div>
          </div>
        ` : ''}

        <div style="margin-top: 40px; display: flex; justify-content: space-between; font-size: 11px; color: #64748b;">
          <div>Generated electronically by Aaryan Aqua Needs Billing System.</div>
          <div style="text-align: right; border-top: 1px solid #cbd5e1; padding-top: 6px; width: 200px;">
            Authorized Signatory
          </div>
        </div>
        <script>window.onload = function() { window.print(); }</script>
      </body>
      </html>
    `;

    printWin.document.open();
    printWin.document.write(html);
    printWin.document.close();
  };

  // --- 8. WHATSAPP STATEMENT GENERATOR ---
  window.sendWhatsAppCustomerStatement = function () {
    if (!currentActiveCustomerStatement) return;
    const s = currentActiveCustomerStatement;
    const cleanPhone = (s.phone || "").replace(/[^0-9]/g, "");
    if (!cleanPhone) {
      if (typeof showFloatingToast === "function") showFloatingToast("⚠️ Customer has no registered phone number.", "warning");
      return;
    }

    const isDue = s.totalBalance > 0.01;
    const realUpi = (window.globalSettings?.upiId || window.globalSettings?.bank?.upi || "7386262139@upi").trim();
    const upiLink = `upi://pay?pa=${realUpi}&pn=AaryanAquaNeeds&am=${s.totalBalance.toFixed(2)}&cu=INR&tn=AccountSettlement`;

    let text = `🙏 *Greetings from Aaryan Aqua Needs!* 🌊\n` +
      `-----------------------------------\n` +
      `*OFFICIAL ACCOUNT STATEMENT*\n\n` +
      `👤 *Customer:* *${s.name}*\n` +
      `📋 *Total Bills Taken:* ${s.invoices.length}\n` +
      `💰 *Total Purchases:* ₹ ${formatMoney(s.totalBilled)}\n` +
      `💵 *Total Paid / Received:* ₹ ${formatMoney(s.totalPaid)} (${s.payments.length} installments)\n` +
      `${isDue ? `🔴 *Current Outstanding Balance: ₹ ${formatMoney(s.totalBalance)}*\n` : `✅ *Current Balance:* CLEAR (₹ 0.00)\n`}`;

    if (isDue) {
      text += `-----------------------------------\n` +
        `⚡ *1-Click Instant UPI Payment Link:*\n${upiLink}\n\n` +
        `🏦 *UPI ID:* ${realUpi}\n`;
    }
    text += `-----------------------------------\n` +
      `Thank you for your valued partnership with us! 🙏✨`;

    const url = `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`📲 Opened WhatsApp statement with prefilled bill & payment link for ${s.name}!`, "success", 4500);
    }
  };

  // --- OFFICIAL PRINTABLE CUSTOMER STATEMENT OF ACCOUNT ---
  window.printCustomerStatement = function (targetCustName) {
    let s = currentActiveCustomerStatement;
    if (targetCustName && (!s || s.name.toLowerCase() !== String(targetCustName).toLowerCase())) {
      if (window._allCustomersDirectoryCache) {
        const found = window._allCustomersDirectoryCache.find(c => c && c.name.toLowerCase() === String(targetCustName).toLowerCase());
        if (found) {
          window.openCustomerDetailsModal(found.name);
          s = currentActiveCustomerStatement;
        }
      }
    }
    if (!s) {
      if (typeof showFloatingToast === 'function') showFloatingToast("⚠️ No customer selected to print statement.", "warning");
      return;
    }

    const company = window.globalSettings?.company || {};
    const bank = window.globalSettings?.bank || {};
    const compName = company.name || "AARYAN AQUA NEEDS";
    const compTagline = company.tagline || "QUALITY PRODUCTS FOR BETTER AQUACULTURE";
    const compAddr = company.address || "Door No: 10-13-94/42A REVENUE WARD 7, AP HOUSING BOARD COLONY, REPALLE";
    const compPhone = company.phone || "7386262139 | 7403727272";
    const compEmail = company.email || "aaryanaquaneeds@gmail.com";
    const bankName = bank.name || "State Bank of India";
    const bankAcc = bank.accountNo || "45413424177";
    const bankIfsc = bank.ifsc || "SBIN0000911";
    const bankBranch = bank.branch || "Repalle";
    const upiId = (window.globalSettings?.upiId || bank.upi || "7386262139@upi").trim();
    const todayStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    let printContainer = document.getElementById("customer-statement-print-container");
    if (!printContainer) {
      printContainer = document.createElement("div");
      printContainer.id = "customer-statement-print-container";
      document.body.appendChild(printContainer);
    }

    const invRows = (s.invoices || []).map((inv, idx) => {
      const invDate = inv.invoiceDate || inv.date || "-";
      const invNo = inv.invoiceNo || "-";
      const total = Number(inv.total || 0);
      const paid = Number(inv.paidAmount || 0);
      const bal = Number(inv.balanceDue || 0);
      return `
        <tr>
          <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: center;">${idx + 1}</td>
          <td style="padding: 8px 10px; border: 1px solid #cbd5e1; font-weight: 700; color: #0284c7;">#${invNo}</td>
          <td style="padding: 8px 10px; border: 1px solid #cbd5e1;">${invDate}</td>
          <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: right; font-weight: 600;">₹ ${formatMoney(total)}</td>
          <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: right; color: #16a34a; font-weight: 600;">₹ ${formatMoney(paid)}</td>
          <td style="padding: 8px 10px; border: 1px solid #cbd5e1; text-align: right; font-weight: 700; color: ${bal > 0.01 ? '#dc2626' : '#16a34a'};">₹ ${formatMoney(bal)}</td>
        </tr>
      `;
    }).join("");

    const payRows = (s.payments || []).map((p, idx) => {
      return `
        <tr>
          <td style="padding: 6px 10px; border: 1px solid #cbd5e1; text-align: center;">${idx + 1}</td>
          <td style="padding: 6px 10px; border: 1px solid #cbd5e1;">${formatDateTime(p.date || p.timestamp)}</td>
          <td style="padding: 6px 10px; border: 1px solid #cbd5e1; font-weight: 600;">#${p.invoiceNo || "-"}</td>
          <td style="padding: 6px 10px; border: 1px solid #cbd5e1; text-transform: uppercase;">${p.mode || "CASH"}</td>
          <td style="padding: 6px 10px; border: 1px solid #cbd5e1; text-align: right; font-weight: 700; color: #16a34a;">₹ ${formatMoney(p.amount)}</td>
        </tr>
      `;
    }).join("");

    printContainer.innerHTML = `
      <style>
        @media screen {
          #customer-statement-print-container { display: none; }
        }
        @media print {
          body * { visibility: hidden !important; }
          #customer-statement-print-container, #customer-statement-print-container * { visibility: visible !important; }
          #customer-statement-print-container {
            display: block !important;
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            background: white !important;
            color: #0f172a !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif !important;
            padding: 24px !important;
            box-sizing: border-box !important;
          }
        }
      </style>
      <div style="max-width: 800px; margin: 0 auto; font-size: 13px; line-height: 1.4; color: #0f172a;">
        <div style="border-bottom: 2.5px solid #0284c7; padding-bottom: 14px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <h1 style="margin: 0; font-size: 22px; font-weight: 900; color: #0369a1; text-transform: uppercase; letter-spacing: 0.5px;">${compName}</h1>
            <div style="font-size: 11px; font-weight: 700; color: #0284c7; text-transform: uppercase; margin-top: 2px;">${compTagline}</div>
            <div style="font-size: 12px; color: #475569; margin-top: 4px; max-width: 440px;">${compAddr}</div>
            <div style="font-size: 12px; color: #475569; margin-top: 2px;">📞 Phone: <strong>${compPhone}</strong> | ✉️ ${compEmail}</div>
          </div>
          <div style="text-align: right;">
            <div style="display: inline-block; background: #0284c7; color: white; padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">Customer Statement</div>
            <div style="font-size: 12px; color: #64748b; margin-top: 6px;">Date: <strong>${todayStr}</strong></div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; gap: 16px; margin-bottom: 20px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px;">
          <div>
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Statement For</div>
            <div style="font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 2px;">${s.name}</div>
            <div style="font-size: 12px; color: #475569; margin-top: 3px;">📞 ${s.phone || "—"}</div>
            <div style="font-size: 12px; color: #475569;">📍 ${s.address || "—"}</div>
            ${s.gstin ? `<div style="font-size: 12px; color: #475569;">GSTIN: <strong>${s.gstin}</strong></div>` : ''}
          </div>
          <div style="display: flex; gap: 16px; text-align: right;">
            <div>
              <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Billed</div>
              <div style="font-size: 17px; font-weight: 800; color: #0284c7; margin-top: 3px;">₹ ${formatMoney(s.totalBilled)}</div>
              <div style="font-size: 11px; color: #64748b;">${(s.invoices || []).length} Invoices</div>
            </div>
            <div>
              <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Paid</div>
              <div style="font-size: 17px; font-weight: 800; color: #16a34a; margin-top: 3px;">₹ ${formatMoney(s.totalPaid)}</div>
              <div style="font-size: 11px; color: #16a34a;">Received</div>
            </div>
            <div style="background: ${s.totalBalance > 0.01 ? '#fef2f2' : '#f0fdf4'}; border: 1px solid ${s.totalBalance > 0.01 ? '#fecaca' : '#bbf7d0'}; border-radius: 8px; padding: 6px 14px;">
              <div style="font-size: 11px; font-weight: 700; color: ${s.totalBalance > 0.01 ? '#991b1b' : '#166534'}; text-transform: uppercase;">Balance Due</div>
              <div style="font-size: 18px; font-weight: 900; color: ${s.totalBalance > 0.01 ? '#dc2626' : '#16a34a'}; margin-top: 2px;">₹ ${formatMoney(s.totalBalance)}</div>
              <div style="font-size: 11px; font-weight: 700; color: ${s.totalBalance > 0.01 ? '#dc2626' : '#16a34a'};">${s.totalBalance > 0.01 ? 'PENDING' : 'CLEARED'}</div>
            </div>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <h3 style="margin: 0 0 8px 0; font-size: 13px; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px;">1. Invoices & Billing Ledger</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead>
              <tr style="background: #0284c7; color: white;">
                <th style="padding: 8px 10px; width: 35px; text-align: center;">#</th>
                <th style="padding: 8px 10px; text-align: left;">Invoice #</th>
                <th style="padding: 8px 10px; text-align: left;">Date</th>
                <th style="padding: 8px 10px; text-align: right;">Billed Amount</th>
                <th style="padding: 8px 10px; text-align: right;">Paid Amount</th>
                <th style="padding: 8px 10px; text-align: right;">Balance Due</th>
              </tr>
            </thead>
            <tbody>
              ${invRows || '<tr><td colspan="6" style="padding: 12px; text-align: center; color: #64748b;">No invoices on record.</td></tr>'}
            </tbody>
            <tfoot>
              <tr style="background: #f1f5f9; font-weight: 800;">
                <td colspan="3" style="padding: 8px 10px; text-align: right;">TOTALS:</td>
                <td style="padding: 8px 10px; text-align: right; color: #0284c7;">₹ ${formatMoney(s.totalBilled)}</td>
                <td style="padding: 8px 10px; text-align: right; color: #16a34a;">₹ ${formatMoney(s.totalPaid)}</td>
                <td style="padding: 8px 10px; text-align: right; color: ${s.totalBalance > 0.01 ? '#dc2626' : '#16a34a'};">₹ ${formatMoney(s.totalBalance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        ${payRows ? `
        <div style="margin-bottom: 20px;">
          <h3 style="margin: 0 0 8px 0; font-size: 13px; font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px;">2. Payment Settlement Receipts</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead>
              <tr style="background: #059669; color: white;">
                <th style="padding: 7px 10px; width: 35px; text-align: center;">#</th>
                <th style="padding: 7px 10px; text-align: left;">Date & Time</th>
                <th style="padding: 7px 10px; text-align: left;">Applied Against</th>
                <th style="padding: 7px 10px; text-align: left;">Payment Mode</th>
                <th style="padding: 7px 10px; text-align: right;">Amount Paid</th>
              </tr>
            </thead>
            <tbody>
              ${payRows}
            </tbody>
          </table>
        </div>
        ` : ''}

        <div style="border-top: 2px dashed #cbd5e1; padding-top: 14px; margin-top: 24px; display: flex; justify-content: space-between; align-items: flex-end; font-size: 11.5px; color: #475569;">
          <div>
            <div style="font-weight: 800; color: #0f172a; text-transform: uppercase; margin-bottom: 4px;">Bank Settlement Details:</div>
            <div>Bank: <strong>${bankName}</strong> | Branch: <strong>${bankBranch}</strong></div>
            <div>Account Name: <strong>${compName}</strong></div>
            <div>Account No: <strong>${bankAcc}</strong> | IFSC: <strong>${bankIfsc}</strong></div>
            <div>UPI ID: <strong>${upiId}</strong></div>
          </div>
          <div style="text-align: right;">
            <div style="margin-bottom: 30px; font-weight: 700; color: #64748b;">For ${compName}</div>
            <div style="border-top: 1px solid #94a3b8; padding-top: 4px; font-weight: 800; color: #0f172a;">Authorized Signatory</div>
          </div>
        </div>
      </div>
    `;

    setTimeout(() => {
      window.print();
    }, 150);
  };

  window.closeCustomerDetailsModal = function () {
    const modal = document.getElementById("customer-details-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.style.setProperty("display", "none", "important");
      modal.style.setProperty("visibility", "hidden", "important");
      modal.style.setProperty("pointer-events", "none", "important");
    }
  };

  window.promptCustomerPaymentForInvoice = function (invId) {
    const isDemo = (typeof window.isDemoMode === 'function') && window.isDemoMode();
    if (!isDemo && typeof window.isViewOnlyUser === 'function' && window.isViewOnlyUser()) {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("⛔ Access Denied: Payment settlement is disabled in View-Only mode.", "error", 4000);
      }
      return;
    }
    window.openRecordInstallmentModal(invId);
  };

  window.switchCustDetailTab = function (tabName) {
    const tabs = ["invoices", "products", "payments"];
    window._currentCustDetailTab = tabName;
    tabs.forEach((t) => {
      const btn = document.getElementById(`btn-cust-tab-${t}`);
      const pane = document.getElementById(`pane-cust-tab-${t}`);
      if (btn) btn.classList.toggle("active", t === tabName);
      if (pane) pane.style.display = t === tabName ? "block" : "none";
    });
    const searchInput = document.getElementById("cust-modal-search");
    if (searchInput && searchInput.value) {
      window.filterCustModalRows(searchInput.value);
    }
  };

  // --- 9. MODAL DOM BUILDERS ---
  function createCustomerDetailsModalDOM() {
    const existing = document.getElementById("customer-details-modal");
    if (existing) {
      if (existing.querySelector(".cust-modal-header")) return existing;
      existing.remove();
    }
    const div = document.createElement("div");
    div.id = "customer-details-modal";
    div.className = "modal-overlay hidden no-print";
    div.style.cssText =
      "position: fixed; inset: 0; background: rgba(15, 23, 42, 0.78); backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; z-index: 2147483645; padding: 16px;";
    div.onclick = function (e) {
      if (e.target === div) closeCustomerDetailsModal();
    };

    div.innerHTML = `
      <div class="modal-box" style="background: #ffffff; width: 100%; max-width: min(96vw, 1120px); max-height: min(92vh, 880px); border-radius: 16px; box-shadow: 0 25px 60px -15px rgba(15, 23, 42, 0.45); display: flex; flex-direction: column; overflow: hidden; font-family: inherit;">
        
        <!-- Modern Profile Header -->
        <div class="cust-modal-header">
          <div style="display: flex; align-items: center; gap: 14px; min-width: 0;">
            <div class="cust-modal-avatar" id="cust-detail-avatar">MB</div>
            <div style="min-width: 0;">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span class="cust-modal-title" id="cust-detail-name">Customer Name</span>
                <span id="cust-header-role-badge" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(14, 165, 233, 0.3);">Client Farm</span>
              </div>
              <div class="cust-modal-meta-row">
                <span id="cust-detail-phone-wrap" class="cust-modal-meta-chip">
                  <i class="fa-solid fa-phone text-emerald"></i>
                  <a id="cust-detail-phone-link" href="#" target="_blank"><span id="cust-detail-phone">—</span></a>
                </span>
                <span id="cust-detail-address-wrap" class="cust-modal-meta-chip">
                  <i class="fa-solid fa-location-dot text-rose"></i>
                  <span id="cust-detail-address">—</span>
                </span>
                <span id="cust-detail-gstin-wrap" class="cust-modal-meta-chip">
                  <i class="fa-solid fa-receipt text-cyan"></i>
                  <span>GSTIN: <strong id="cust-detail-gstin" style="color: #ffffff;">—</strong></span>
                </span>
              </div>
            </div>
          </div>
          
          <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0;">
            <div id="cust-header-due-badge"></div>
            <button id="cust-header-stmt-btn" type="button" class="btn btn-xs btn-secondary" onclick="window.printCustomerStatement()" title="Print or Download Complete Account Statement (PDF)" style="display: inline-flex; align-items: center; gap: 6px; background: rgba(255, 255, 255, 0.12); color: white; border: 1px solid rgba(255, 255, 255, 0.25); padding: 7px 13px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer;">
              <i class="fa-solid fa-print"></i> Statement
            </button>
            <button id="cust-header-add-inst-btn" type="button" class="btn btn-xs btn-primary" onclick="window.settleCustomerTopDueBill()" title="Record Payment Installment" style="display: none; align-items: center; gap: 6px; background: #0284c7; color: white; border: none; padding: 7px 13px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer;">
              <i class="fa-solid fa-plus"></i> Record Installment
            </button>
            <button id="cust-header-wa-btn" type="button" class="btn btn-xs btn-whatsapp" onclick="window.sendWhatsAppCustomerStatement()" title="Send WhatsApp Account Statement with 1-Click UPI Payment Link" style="display: none; align-items: center; gap: 6px; background: #16a34a; color: white; border: none; padding: 7px 13px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer;">
              <i class="fa-brands fa-whatsapp" style="font-size: 14px;"></i> WhatsApp Reminder
            </button>
            <button type="button" onclick="closeCustomerDetailsModal()" title="Close Profile (Esc)" style="background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.15); color: #cbd5e1; font-size: 16px; cursor: pointer; width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease;">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>

        <!-- Symmetrical 4-Card Financial Metric Strip -->
        <div class="cust-modal-kpi-grid">
          <div class="cust-modal-kpi-card kpi-invoices">
            <div class="cust-modal-kpi-icon"><i class="fa-solid fa-file-invoice"></i></div>
            <div>
              <div class="cust-modal-kpi-label">Total Invoices</div>
              <div class="cust-modal-kpi-val" id="cust-detail-total-invoices">0</div>
            </div>
          </div>
          <div class="cust-modal-kpi-card kpi-billed">
            <div class="cust-modal-kpi-icon"><i class="fa-solid fa-chart-line"></i></div>
            <div>
              <div class="cust-modal-kpi-label">Total Purchases</div>
              <div class="cust-modal-kpi-val" style="color: #0284c7;" id="cust-detail-total-billed">₹ 0.00</div>
            </div>
          </div>
          <div class="cust-modal-kpi-card kpi-paid">
            <div class="cust-modal-kpi-icon"><i class="fa-solid fa-circle-check"></i></div>
            <div>
              <div class="cust-modal-kpi-label">Cleared / Received</div>
              <div class="cust-modal-kpi-val" style="color: #059669;" id="cust-detail-total-paid">₹ 0.00</div>
            </div>
          </div>
          <div class="cust-modal-kpi-card kpi-due" id="cust-kpi-card-due">
            <div class="cust-modal-kpi-icon" id="cust-kpi-icon-due"><i class="fa-solid fa-wallet"></i></div>
            <div style="flex: 1; min-width: 0;">
              <div class="cust-modal-kpi-label" id="cust-kpi-label-due" style="color: #dc2626;">Outstanding Due</div>
              <div class="cust-modal-kpi-val" style="color: #dc2626;" id="cust-detail-total-balance">₹ 0.00</div>
            </div>
            <button id="cust-kpi-settle-btn" type="button" onclick="window.settleCustomerTopDueBill()" title="Record Next Installment" style="display: none; padding: 5px 10px; font-size: 11px; font-weight: 800; background: #dc2626; color: #ffffff; border: none; border-radius: 6px; cursor: pointer; flex-shrink: 0;">
              <i class="fa-solid fa-plus"></i> Installment
            </button>
          </div>
        </div>

        <!-- Tabs Navigation & Realtime Filter Strip -->
        <div class="cust-modal-tabs-bar">
          <div class="cust-modal-tabs-group">
            <button type="button" id="btn-cust-tab-invoices" class="cust-modal-tab-btn active" onclick="switchCustDetailTab('invoices')">
              <i class="fa-solid fa-file-invoice"></i> Invoices Taken
              <span id="cust-tab-badge-invoices" class="cust-modal-tab-count">0</span>
            </button>
            <button type="button" id="btn-cust-tab-products" class="cust-modal-tab-btn" onclick="switchCustDetailTab('products')">
              <i class="fa-solid fa-boxes-stacked"></i> Products Purchased
              <span id="cust-tab-badge-products" class="cust-modal-tab-count">0</span>
            </button>
            <button type="button" id="btn-cust-tab-payments" class="cust-modal-tab-btn" onclick="switchCustDetailTab('payments')">
              <i class="fa-solid fa-clock-rotate-left"></i> Payment Log &amp; Audit
              <span id="cust-tab-badge-payments" class="cust-modal-tab-count">0</span>
            </button>
          </div>
          <div class="cust-modal-search-box">
            <i class="fa-solid fa-magnifying-glass" style="color: #94a3b8; font-size: 12px;"></i>
            <input type="text" id="cust-modal-search" placeholder="Search bill #, item, date..." oninput="window.filterCustModalRows(this.value)">
          </div>
        </div>

        <!-- Body Content Panes -->
        <div class="cust-modal-body">
          
          <!-- Pane 1: Invoices Taken -->
          <div id="pane-cust-tab-invoices" style="overflow-x: auto;">
            <table class="cust-modal-table">
              <thead>
                <tr>
                  <th style="width: 130px;">INVOICE #</th>
                  <th style="width: 170px;">BILL DATE &amp; TIME</th>
                  <th style="width: 180px;">ITEMS PURCHASED</th>
                  <th style="text-align: right; width: 120px;">GRAND TOTAL</th>
                  <th style="text-align: right; width: 130px;">PAID / INSTS</th>
                  <th style="text-align: right; width: 120px;">BALANCE</th>
                  <th style="text-align: center; width: 100px;">STATUS</th>
                  <th style="text-align: center; width: 160px;">ACTIONS</th>
                </tr>
              </thead>
              <tbody id="cust-detail-invoices-tbody"></tbody>
            </table>
          </div>

          <!-- Pane 2: Products Purchased -->
          <div id="pane-cust-tab-products" style="display: none; overflow-x: auto;">
            <table class="cust-modal-table">
              <thead>
                <tr>
                  <th>PRODUCT NAME</th>
                  <th style="width: 120px;">INVOICE #</th>
                  <th style="width: 170px;">PURCHASE DATE &amp; TIME</th>
                  <th style="text-align: center; width: 110px;">QUANTITY</th>
                  <th style="text-align: right; width: 120px;">RATE (₹)</th>
                  <th style="text-align: right; width: 130px;">TOTAL VALUE (₹)</th>
                </tr>
              </thead>
              <tbody id="cust-detail-products-tbody"></tbody>
            </table>
            <div id="cust-products-summary-strip" style="margin-top: 12px; padding: 10px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 12px; font-weight: 700; color: #475569; display: flex; justify-content: space-between;"></div>
          </div>

          <!-- Pane 3: Payments Timeline Audit Log -->
          <div id="pane-cust-tab-payments" style="display: none; overflow-x: auto;">
            <table class="cust-modal-table">
              <thead>
                <tr>
                  <th style="width: 85px;">INST #</th>
                  <th style="width: 160px;">PAYMENT DATE &amp; TIME</th>
                  <th style="width: 110px;">FOR BILL #</th>
                  <th style="text-align: right; width: 125px;">AMOUNT RECEIVED</th>
                  <th style="text-align: right; width: 125px;">BALANCE AFTER</th>
                  <th style="width: 130px;">PAYMENT MODE</th>
                  <th>UTR / TRANSACTION REFERENCE / NOTE</th>
                  <th style="text-align: center; width: 95px;">RECEIPT</th>
                </tr>
              </thead>
              <tbody id="cust-detail-payments-tbody"></tbody>
            </table>
            <div id="cust-payments-summary-strip" style="margin-top: 12px; padding: 10px 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 12px; font-weight: 700; color: #475569; display: flex; justify-content: space-between;"></div>
          </div>

        </div>

        <!-- Modern Modal Footer -->
        <div class="cust-modal-footer">
          <div id="cust-modal-statement-actions" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <button type="button" class="btn btn-sm btn-secondary" onclick="window.printCustomerStatement()" style="display: flex; align-items: center; gap: 6px; font-weight: 700; padding: 8px 14px; border-radius: 8px;">
              <i class="fa-solid fa-print"></i> Print Account Statement
            </button>
            <button type="button" class="btn btn-sm btn-whatsapp" onclick="window.sendWhatsAppCustomerStatement()" style="display: flex; align-items: center; gap: 6px; font-weight: 700; padding: 8px 14px; border-radius: 8px; background: #16a34a; color: white; border: none;">
              <i class="fa-brands fa-whatsapp"></i> Share Statement (WhatsApp)
            </button>
            <button id="cust-footer-settle-btn" type="button" class="btn btn-sm btn-primary" onclick="window.settleCustomerTopDueBill()" style="display: none; align-items: center; gap: 6px; font-weight: 800; padding: 8px 14px; border-radius: 8px; background: #0284c7; color: white; border: none;">
              <i class="fa-solid fa-plus"></i> Record Installment
            </button>
          </div>
          <button type="button" class="btn btn-secondary" onclick="closeCustomerDetailsModal()" style="padding: 8px 20px; font-weight: 700; border-radius: 8px;">Close</button>
        </div>

      </div>
    `;

    document.body.appendChild(div);
    return div;
  }

  function createRecordInstallmentModalDOM() {
    const existing = document.getElementById("record-installment-modal");
    if (existing) return existing;

    const div = document.createElement("div");
    div.id = "record-installment-modal";
    div.className = "modal-overlay hidden no-print";
    div.style.cssText =
      "position: fixed; inset: 0; background: rgba(15, 23, 42, 0.78); backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; z-index: 2147483646; padding: 16px;";
    div.onclick = function (e) {
      if (e.target === div) window.closeRecordInstallmentModal();
    };

    div.innerHTML = `
      <div class="modal-box" style="background: #ffffff; width: 100%; max-width: 560px; border-radius: 16px; box-shadow: 0 25px 60px -15px rgba(15, 23, 42, 0.45); display: flex; flex-direction: column; overflow: hidden; font-family: inherit;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff; padding: 18px 24px; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #ffffff; display: flex; align-items: center; justify-content: center; font-size: 18px;">
              <i class="fa-solid fa-hand-holding-dollar"></i>
            </div>
            <div>
              <div style="font-size: 17px; font-weight: 800; color: #ffffff;">Record Payment Installment</div>
              <div style="font-size: 11.5px; color: #94a3b8;">Log on-spot / installment payments into invoice &amp; customer database</div>
            </div>
          </div>
          <button type="button" onclick="window.closeRecordInstallmentModal()" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15); color: #cbd5e1; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center;">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <!-- Body Form -->
        <div style="padding: 20px 24px; overflow-y: auto; max-height: calc(85vh - 140px);">
          
          <!-- Customer Info Strip -->
          <div style="margin-bottom: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <span style="font-size: 10.5px; text-transform: uppercase; font-weight: 700; color: #64748b;">Customer</span>
              <div id="inst-modal-cust-name" style="font-size: 14.5px; font-weight: 800; color: #0f172a;">—</div>
            </div>
            <div style="text-align: right;">
              <span style="font-size: 10.5px; text-transform: uppercase; font-weight: 700; color: #dc2626;">Total Outstanding</span>
              <div id="inst-modal-cust-due" style="font-size: 14.5px; font-weight: 800; color: #dc2626;">₹ 0.00</div>
            </div>
          </div>

          <!-- Target Invoice Selection -->
          <div style="margin-bottom: 16px;">
            <label style="display: block; font-size: 11.5px; font-weight: 700; text-transform: uppercase; color: #475569; margin-bottom: 6px;">
              Apply Payment To Invoice <span style="color: #dc2626;">*</span>
            </label>
            <select id="inst-modal-invoice-select" class="form-control" onchange="window.updateInstallmentModalFieldsFromSelect()" style="width: 100%; padding: 9px 12px; font-size: 13px; font-weight: 600; border: 1.5px solid #cbd5e1; border-radius: 8px;">
            </select>
          </div>

          <!-- Amount Input with Quick Preset Chips -->
          <div style="margin-bottom: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <label style="font-size: 11.5px; font-weight: 700; text-transform: uppercase; color: #475569;">
                Installment Amount Received (₹) <span style="color: #dc2626;">*</span>
              </label>
              <span id="inst-modal-pending-hint" style="font-size: 11px; font-weight: 700; color: #0284c7;"></span>
            </div>
            <div style="position: relative;">
              <span style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); font-size: 18px; font-weight: 800; color: #0284c7;">₹</span>
              <input type="number" step="0.01" min="1" id="inst-modal-amount" placeholder="0.00" style="width: 100%; padding: 10px 14px 10px 34px; font-size: 18px; font-weight: 800; color: #0f172a; border: 2px solid #0284c7; border-radius: 8px; box-sizing: border-box; outline: none;">
            </div>
            
            <!-- Quick Preset Chips -->
            <div style="display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;">
              <button type="button" class="btn btn-xs" onclick="window.setInstallmentQuickAmt('full')" style="background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer;">Full Balance</button>
              <button type="button" class="btn btn-xs" onclick="window.setInstallmentQuickAmt('half')" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer;">50% Half</button>
              <button type="button" class="btn btn-xs" onclick="window.setInstallmentQuickAmt(1000)" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer;">₹ 1,000</button>
              <button type="button" class="btn btn-xs" onclick="window.setInstallmentQuickAmt(2000)" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer;">₹ 2,000</button>
              <button type="button" class="btn btn-xs" onclick="window.setInstallmentQuickAmt(5000)" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer;">₹ 5,000</button>
              <button type="button" class="btn btn-xs" onclick="window.setInstallmentQuickAmt(10000)" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; font-weight: 700; border-radius: 6px; padding: 4px 10px; cursor: pointer;">₹ 10,000</button>
            </div>
          </div>

          <!-- Mode & Reference in 2 Columns -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <div>
              <label style="display: block; font-size: 11.5px; font-weight: 700; text-transform: uppercase; color: #475569; margin-bottom: 6px;">
                Payment Mode <span style="color: #dc2626;">*</span>
              </label>
              <select id="inst-modal-mode" class="form-control" style="width: 100%; padding: 8px 10px; font-size: 12.5px; border: 1.5px solid #cbd5e1; border-radius: 8px;">
                <option value="UPI / QR Code" selected>UPI / QR Code</option>
                <option value="Cash">Cash</option>
                <option value="Bank Transfer">Bank Transfer (NEFT/RTGS/IMPS)</option>
                <option value="Cheque">Cheque / Demand Draft</option>
              </select>
            </div>
            <div>
              <label style="display: block; font-size: 11.5px; font-weight: 700; text-transform: uppercase; color: #475569; margin-bottom: 6px;">
                UTR / Ref / Cheque No.
              </label>
              <input type="text" id="inst-modal-ref" placeholder="e.g. 423984729182" style="width: 100%; padding: 8px 10px; font-size: 12.5px; border: 1.5px solid #cbd5e1; border-radius: 8px; box-sizing: border-box;">
            </div>
          </div>

          <!-- Date-Time & Notes in 2 Columns -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <div>
              <label style="display: block; font-size: 11.5px; font-weight: 700; text-transform: uppercase; color: #475569; margin-bottom: 6px;">
                Payment Date &amp; Time <span style="color: #dc2626;">*</span>
              </label>
              <input type="datetime-local" id="inst-modal-datetime" style="width: 100%; padding: 8px 10px; font-size: 12px; border: 1.5px solid #cbd5e1; border-radius: 8px; box-sizing: border-box;">
            </div>
            <div>
              <label style="display: block; font-size: 11.5px; font-weight: 700; text-transform: uppercase; color: #475569; margin-bottom: 6px;">
                Notes / Depositor Remarks
              </label>
              <input type="text" id="inst-modal-note" placeholder="e.g. Paid by manager Suresh" style="width: 100%; padding: 8px 10px; font-size: 12.5px; border: 1.5px solid #cbd5e1; border-radius: 8px; box-sizing: border-box;">
            </div>
          </div>

          <!-- Dynamic UPI QR Toggle & Canvas Container -->
          <div style="margin-bottom: 10px;">
            <button type="button" class="btn btn-xs" onclick="window.toggleInstallmentDynamicQr()" style="display: inline-flex; align-items: center; gap: 6px; background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; padding: 6px 12px; border-radius: 6px; font-weight: 700; cursor: pointer;">
              <i class="fa-solid fa-qrcode"></i> <span id="inst-modal-qr-toggle-label">Show Instant UPI QR Code</span>
            </button>
            <div id="inst-modal-qr-preview-box" style="display: none; margin-top: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; text-align: center;">
              <div style="font-size: 11.5px; font-weight: 700; color: #475569; margin-bottom: 8px;">Scan with Google Pay, PhonePe, Paytm, or BHIM:</div>
              <div style="display: inline-block; background: #ffffff; padding: 10px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border: 1px solid #cbd5e1;">
                <canvas id="inst-modal-qr-canvas" style="display: block; width: 180px; height: 180px;"></canvas>
                <img id="inst-modal-qr-img" style="display: none; width: 180px; height: 180px; margin: 0 auto;">
              </div>
              <div id="inst-modal-qr-amt-label" style="font-size: 14px; font-weight: 800; color: #0284c7; margin-top: 8px;"></div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div style="background: #f8fafc; padding: 14px 24px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
          <button type="button" class="btn btn-secondary" onclick="window.closeRecordInstallmentModal()" style="padding: 8px 16px; font-weight: 700; border-radius: 8px; border: 1px solid #cbd5e1; background: #ffffff; cursor: pointer;">Cancel</button>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-whatsapp" onclick="window.submitRecordInstallment(true)" style="display: flex; align-items: center; gap: 6px; font-weight: 700; padding: 8px 14px; border-radius: 8px; background: #16a34a; color: white; border: none; cursor: pointer;">
              <i class="fa-brands fa-whatsapp"></i> Save &amp; WhatsApp Receipt
            </button>
            <button type="button" class="btn btn-primary" onclick="window.submitRecordInstallment(false)" style="display: flex; align-items: center; gap: 6px; font-weight: 800; padding: 8px 18px; border-radius: 8px; background: #0284c7; color: white; border: none; cursor: pointer;">
              <i class="fa-solid fa-check"></i> Confirm Installment
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(div);
    return div;
  }

  // --- 10. DEDICATED CUSTOMERS DIRECTORY SECTION VIEW ---
  let currentDirectoryLayout = "cards";
  try {
    const savedLayout = localStorage.getItem("preferred_cust_layout");
    if (savedLayout === "table" || savedLayout === "cards") {
      currentDirectoryLayout = savedLayout;
    }
  } catch (e) {}

  window.switchCustomerDirectoryLayout = function (layout) {
    currentDirectoryLayout = layout || "cards";
    try { localStorage.setItem("preferred_cust_layout", currentDirectoryLayout); } catch(e) {}
    const tableWrap = document.getElementById("customers-directory-table-wrap");
    const grid = document.getElementById("customers-directory-grid");
    const btnTable = document.getElementById("btn-cust-view-table");
    const btnCards = document.getElementById("btn-cust-view-cards");

    if (layout === "table") {
      if (tableWrap) tableWrap.style.display = "block";
      if (grid) grid.style.display = "none";
      if (btnTable) {
        btnTable.style.background = "#ffffff";
        btnTable.style.color = "#0284c7";
        btnTable.style.boxShadow = "0 1px 3px rgba(0,0,0,0.1)";
      }
      if (btnCards) {
        btnCards.style.background = "transparent";
        btnCards.style.color = "#64748b";
        btnCards.style.boxShadow = "none";
      }
    } else {
      if (tableWrap) tableWrap.style.display = "none";
      if (grid) grid.style.display = "grid";
      if (btnCards) {
        btnCards.style.background = "#ffffff";
        btnCards.style.color = "#0284c7";
        btnCards.style.boxShadow = "0 1px 3px rgba(0,0,0,0.1)";
      }
      if (btnTable) {
        btnTable.style.background = "transparent";
        btnTable.style.color = "#64748b";
        btnTable.style.boxShadow = "none";
      }
    }
  };

  window.renderCustomersDirectoryView = function () {
    const custMap = new Map();

    (window.invoicesDb || []).forEach((inv) => {
      if (!inv) return;
      const d = inv.details || {};
      const buyer = d.buyer || {};
      const name = String(inv.customerName || buyer.name || "").trim();
      if (!name) return;

      const norm = name.toLowerCase();
      let c = custMap.get(norm);
      if (!c) {
        c = {
          name: name,
          phone: String(inv.customerPhone || buyer.phone || "").trim(),
          address: String(buyer.address || "").trim(),
          invoiceCount: 0,
          totalBilled: 0,
          totalPaid: 0,
          totalBalance: 0,
          lastDate: ""
        };
        custMap.set(norm, c);
      }

      if (!c.phone && buyer.phone) c.phone = String(buyer.phone).trim();
      if (!c.address && buyer.address) c.address = String(buyer.address).trim();

      const invTotal = Number(inv.total || d.total || d.grandTotal || 0);
      const invPaid = Number(inv.paidAmount || d.paidAmount || 0);
      const invBal = Number(inv.balanceDue || d.balanceDue || 0);
      const invDate = inv.date || inv.invoiceDate || d.date || "";

      c.invoiceCount += 1;
      c.totalBilled += invTotal;
      c.totalPaid += invPaid;
      c.totalBalance += invBal;
      if (invDate && (!c.lastDate || new Date(invDate) > new Date(c.lastDate))) {
        c.lastDate = invDate;
      }
    });

    (window.partiesDb || []).forEach((p) => {
      if (!p || !p.name) return;
      const name = String(p.name).trim();
      const norm = name.toLowerCase();
      let c = custMap.get(norm);
      if (!c) {
        c = {
          name: name,
          phone: String(p.phone || "").trim(),
          address: String(p.address || "").trim(),
          invoiceCount: 0,
          totalBilled: 0,
          totalPaid: 0,
          totalBalance: 0,
          lastDate: ""
        };
        custMap.set(norm, c);
      } else {
        if (!c.phone && p.phone) c.phone = String(p.phone).trim();
        if (!c.address && p.address) c.address = String(p.address).trim();
      }
    });

    const customersList = Array.from(custMap.values());
    customersList.sort((a, b) => a.name.localeCompare(b.name));

    // Update Top KPIs
    let totalRev = 0;
    let totalReceived = 0;
    let totalDues = 0;
    customersList.forEach(c => {
      totalRev += c.totalBilled;
      totalReceived += c.totalPaid;
      totalDues += c.totalBalance;
    });

    const kpiCount = document.getElementById("cust-sec-kpi-count");
    const kpiRev = document.getElementById("cust-sec-kpi-revenue");
    const kpiPaid = document.getElementById("cust-sec-kpi-paid");
    const kpiDues = document.getElementById("cust-sec-kpi-dues");
    if (kpiCount) kpiCount.textContent = customersList.length;
    if (kpiRev) kpiRev.textContent = `₹ ${formatMoney(totalRev)}`;
    if (kpiPaid) kpiPaid.textContent = `₹ ${formatMoney(totalReceived)}`;
    if (kpiDues) kpiDues.textContent = `₹ ${formatMoney(totalDues)}`;

    window._allCustomersDirectoryCache = customersList;
    renderCustomerDirectoryViews(customersList);
  };

  function renderCustomerDirectoryViews(list) {
    renderCustomerTable(list);
    renderCustomerCards(list);
    if (typeof window.switchCustomerDirectoryLayout === "function") {
      window.switchCustomerDirectoryLayout(currentDirectoryLayout);
    }
  }

  function renderCustomerTable(list) {
    const tbody = document.getElementById("customers-directory-tbody");
    if (!tbody) return;

    if (!list || list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted" style="padding: 36px;">
            <i class="fa-solid fa-users-slash" style="font-size: 24px; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>
            <div style="font-size: 14px; font-weight: 700; color: #475569; margin-bottom: 4px;">No customers found matching your search</div>
            <div style="font-size: 12px; color: #94a3b8; margin-bottom: 14px;">Register customers directly to start tracking invoices, transactions, and payments.</div>
            <button type="button" class="btn btn-primary btn-sm" onclick="window.openPartyModal('receiver')" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px;">
              <i class="fa-solid fa-user-plus"></i> + Add First Customer
            </button>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = list
      .map((c) => {
        const hasDue = c.totalBalance > 0.01;
        const safeName = c.name.replace(/'/g, "\\'");
        const cleanPhone = c.phone ? c.phone.replace(/[^0-9]/g, "") : "";
        const encName = encodeURIComponent(c.name || "");

        return `
        <tr style="border-bottom: 1px solid #f1f5f9; transition: background 0.15s ease;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
          <td style="padding: 12px; font-weight: 700; color: #0f172a; cursor: pointer;" onclick="window.openCustomerDetailsModal(decodeURIComponent('${encName}'))" title="Click to view complete purchase and payment history for ${c.name}">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); color: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; flex-shrink: 0;">
                ${c.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <span style="color: #0284c7; text-decoration: underline; text-underline-offset: 2px;">${safeEscape(c.name)}</span>
                ${c.address ? `<div style="font-size: 11px; color: #94a3b8; font-weight: 400;">${safeEscape(c.address)}</div>` : ''}
              </div>
            </div>
          </td>
          <td style="padding: 12px; font-size: 12.5px; color: #475569;">
            ${c.phone ? `<i class="fa-brands fa-whatsapp text-emerald" style="font-size: 13px;"></i> ${c.phone}` : '<span class="text-muted">—</span>'}
          </td>
          <td style="padding: 12px; text-align: center; font-weight: 800; color: #0284c7; cursor: pointer;" onclick="window.openCustomerDetailsModal(decodeURIComponent('${encName}'))" title="View bills">
            <span style="background: #f1f5f9; padding: 3px 8px; border-radius: 6px;">${c.invoiceCount}</span>
          </td>
          <td style="padding: 12px; text-align: right; font-weight: 700; color: #0f172a;">
            ₹ ${formatMoney(c.totalBilled)}
          </td>
          <td style="padding: 12px; text-align: right; font-weight: 700; color: #16a34a;">
            ₹ ${formatMoney(c.totalPaid)}
          </td>
          <td style="padding: 12px; text-align: right; font-weight: 800;">
            ${hasDue ? `<span style="color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; padding: 3px 8px; border-radius: 6px;">₹ ${formatMoney(c.totalBalance)}</span>` : '<span style="color: #16a34a; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 3px 8px; border-radius: 6px;">Cleared</span>'}
          </td>
          <td style="padding: 12px; text-align: center;">
            <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
              <button class="btn btn-xs" onclick="window.openCustomerDetailsModal(decodeURIComponent('${encName}'))" title="Open Full Details &amp; History" style="padding: 5px 10px; font-size: 11.5px; font-weight: 700; background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd; border-radius: 6px; cursor: pointer;">
                <i class="fa-solid fa-eye"></i> Details
              </button>
              ${hasDue ? `
                <button class="btn btn-xs" onclick="window.openRecordInstallmentModal(null, decodeURIComponent('${encName}'))" title="Record Payment Installment" style="padding: 5px 10px; font-size: 11.5px; font-weight: 700; background: #0284c7; color: white; border: none; border-radius: 6px; cursor: pointer;">
                  <i class="fa-solid fa-plus"></i> Settle
                </button>
              ` : ''}
              ${cleanPhone ? `
                <a href="https://wa.me/91${cleanPhone}?text=${encodeURIComponent(
  `🙏 *Greetings from Aaryan Aqua Needs!* 🌊\n\n` +
  `Dear *${c.name}*,\n` +
  `Your current billing summary with us:\n` +
  `💰 Total Billed: ₹ ${formatMoney(c.totalBilled)}\n` +
  `💵 Total Paid: ₹ ${formatMoney(c.totalPaid)}\n` +
  `${c.totalBalance > 0.01 
    ? `🔴 *Outstanding Balance Due: ₹ ${formatMoney(c.totalBalance)}*\n\n⚡ *Pay Instantly via UPI:*\nupi://pay?pa=7386262139@upi&pn=AaryanAquaNeeds&am=${c.totalBalance.toFixed(2)}&cu=INR&tn=Balance\n🏦 UPI ID: 7386262139@upi\n` 
    : `✅ *Account Status: Fully Settled & Cleared*\n`}\n` +
  `Thank you for your valued business! 🙏✨`
)}" target="_blank" title="Send WhatsApp Bill &amp; Payment Link" style="width: 28px; height: 28px; border-radius: 6px; background: #16a34a; color: white; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; text-decoration: none;">
                  <i class="fa-brands fa-whatsapp"></i>
                </a>
              ` : ''}
            </div>
          </td>
        </tr>
        `;
      })
      .join("");
  }

  function renderCustomerCards(list) {
    const grid = document.getElementById("customers-directory-grid");
    if (!grid) return;

    if (!list || list.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 48px; color: #64748b;">
          <i class="fa-solid fa-users-slash" style="font-size: 32px; color: #cbd5e1; display: block; margin-bottom: 12px;"></i>
          <div style="font-size: 15px; font-weight: 700; color: #334155;">No customers found</div>
          <div style="font-size: 13px; color: #94a3b8; margin-top: 4px; margin-bottom: 14px;">Try searching with a different name or phone number, or register a customer now.</div>
          <button type="button" class="btn btn-primary btn-sm" onclick="window.openPartyModal('receiver')" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px;">
            <i class="fa-solid fa-user-plus"></i> + Add First Customer
          </button>
        </div>
      `;
      return;
    }

    grid.innerHTML = list
      .map((c) => {
        const hasDue = c.totalBalance > 0.01;
        const safeName = c.name.replace(/'/g, "\\'");
        const cleanPhone = c.phone ? c.phone.replace(/[^0-9]/g, "") : "";
        const encName = encodeURIComponent(c.name || "");

        return `
        <div class="customer-card-box" onclick="window.openCustomerDetailsModal(decodeURIComponent('${encName}'))" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 2px 6px rgba(0,0,0,0.03); display: flex; flex-direction: column; justify-content: space-between;" onmouseover="this.style.borderColor='#0ea5e9'; this.style.transform='translateY(-2px)'; this.style.boxShadow='0 8px 18px rgba(14, 165, 233, 0.12)';" onmouseout="this.style.borderColor='#e2e8f0'; this.style.transform='none'; this.style.boxShadow='0 2px 6px rgba(0,0,0,0.03)';">
          
          <div>
            <!-- Top Card Header: Avatar & Customer Name -->
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
              <div style="width: 44px; height: 44px; border-radius: 10px; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); color: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; flex-shrink: 0;">
                ${c.name.charAt(0).toUpperCase()}
              </div>
              <div style="overflow: hidden;">
                <div style="font-size: 15px; font-weight: 800; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${c.name}">${c.name}</div>
                <div style="font-size: 12px; color: #64748b; margin-top: 2px;">
                  ${c.phone ? `<i class="fa-solid fa-phone" style="font-size: 11px; color: #10b981;"></i> ${c.phone}` : 'No phone registered'}
                </div>
              </div>
            </div>

            <!-- Stats Mini Badges -->
            <div style="display: flex; gap: 8px; margin-bottom: 12px; font-size: 11.5px;">
              <span style="background: #f1f5f9; color: #475569; padding: 3px 8px; border-radius: 6px; font-weight: 700;">
                <i class="fa-solid fa-file-invoice text-cyan"></i> ${c.invoiceCount} Bills
              </span>
              <span style="background: ${hasDue ? '#fef2f2' : '#f0fdf4'}; color: ${hasDue ? '#dc2626' : '#16a34a'}; border: 1px solid ${hasDue ? '#fecaca' : '#bbf7d0'}; padding: 3px 8px; border-radius: 6px; font-weight: 700;">
                ${hasDue ? `Due: ₹${formatMoney(c.totalBalance)}` : 'Cleared'}
              </span>
            </div>

            <!-- Financial Metrics -->
            <div style="background: #f8fafc; border-radius: 8px; padding: 10px; font-size: 12px; margin-bottom: 12px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #64748b;">Total Billed:</span>
                <strong style="color: #0f172a;">₹ ${formatMoney(c.totalBilled)}</strong>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #64748b;">Total Received:</span>
                <strong style="color: #16a34a;">₹ ${formatMoney(c.totalPaid)}</strong>
              </div>
            </div>
          </div>

          <!-- Bottom Action Hint -->
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f1f5f9; padding-top: 10px; font-size: 11.5px;">
            <span style="color: #0284c7; font-weight: 700; display: flex; align-items: center; gap: 4px;">
              <i class="fa-solid fa-circle-info"></i> View Full Timeline &rarr;
            </span>
            <div style="display: flex; gap: 6px; align-items: center;" onclick="event.stopPropagation();">
              ${hasDue ? `
                <button class="btn btn-xs" onclick="window.openRecordInstallmentModal(null, decodeURIComponent('${encName}'))" title="Record Installment" style="background: #0284c7; color: white; border: none; border-radius: 6px; padding: 3px 8px; font-size: 11px; font-weight: 700; cursor: pointer;">
                  + Installment
                </button>
              ` : ''}
              ${cleanPhone ? `
                <a href="https://wa.me/91${cleanPhone}?text=${encodeURIComponent(
    `🙏 *Greetings from Aaryan Aqua Needs!* 🌊\n\n` +
    `Dear *${c.name}*,\n` +
    `Your current billing summary with us:\n` +
    `💰 Total Billed: ₹ ${formatMoney(c.totalBilled)}\n` +
    `💵 Total Paid: ₹ ${formatMoney(c.totalPaid)}\n` +
    `${c.totalBalance > 0.01 
      ? `🔴 *Outstanding Balance Due: ₹ ${formatMoney(c.totalBalance)}*\n\n⚡ *Pay Instantly via UPI:*\nupi://pay?pa=7386262139@upi&pn=AaryanAquaNeeds&am=${c.totalBalance.toFixed(2)}&cu=INR&tn=Balance\n🏦 UPI ID: 7386262139@upi\n` 
      : `✅ *Account Status: Fully Settled & Cleared*\n`}\n` +
    `Thank you for your valued business! 🙏✨`
  )}" target="_blank" title="Send WhatsApp Bill &amp; Payment Link" style="color: #16a34a; font-size: 16px; padding: 3px 6px; text-decoration: none; display: inline-flex; align-items: center;">
                  <i class="fa-brands fa-whatsapp"></i>
                </a>
              ` : ''}
            </div>
          </div>

        </div>
      `;
      })
      .join("");
  }

  window.filterCustomersDirectory = function () {
    const searchInput = document.getElementById("search-customers-directory");
    const query = searchInput ? searchInput.value.toLowerCase().trim() : "";
    const statusSelect = document.getElementById("filter-customers-status");
    const statusFilter = statusSelect ? statusSelect.value : "all";
    const list = window._allCustomersDirectoryCache || [];

    let filtered = list;

    if (query) {
      filtered = filtered.filter((c) => {
        const name = c.name.toLowerCase();
        const phone = (c.phone || "").replace(/[^0-9]/g, "");
        const cleanQ = query.replace(/[^0-9]/g, "");
        return name.includes(query) || (cleanQ && phone.includes(cleanQ));
      });
    }

    if (statusFilter === "due") {
      filtered = filtered.filter((c) => c.totalBalance > 0.01);
    } else if (statusFilter === "cleared") {
      filtered = filtered.filter((c) => c.totalBalance <= 0.01);
    }

    renderCustomerDirectoryViews(filtered);
  };

  // --- 11. ADVANCED EXPORT & BULK REMINDERS ---
  window.exportCustomersDirectoryCSV = function () {
    const list = window._allCustomersDirectoryCache || [];
    if (!list || list.length === 0) {
      if (typeof showFloatingToast === 'function') showFloatingToast("No customer records to export.", "warning");
      return;
    }

    const headers = [
      "Customer Name",
      "Phone Number",
      "Address",
      "Total Invoices",
      "Total Billed (INR)",
      "Total Collected (INR)",
      "Balance Due (INR)",
      "Status",
      "Last Transaction Date"
    ];

    const rows = list.map((c) => {
      const status = c.totalBalance > 0.01 ? "Pending Due" : "Cleared";
      return [
        `"${(c.name || '').replace(/"/g, '""')}"`,
        `"${(c.phone || '').replace(/"/g, '""')}"`,
        `"${(c.address || '').replace(/"/g, '""')}"`,
        c.invoiceCount || 0,
        (c.totalBilled || 0).toFixed(2),
        (c.totalPaid || 0).toFixed(2),
        (c.totalBalance || 0).toFixed(2),
        status,
        `"${c.lastDate || '—'}"`
      ].join(",");
    });

    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Customer_Directory_Ledger_${new Date().toISOString().split("T")[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    if (typeof showFloatingToast === 'function') {
      showFloatingToast("📊 Customer Directory CSV exported successfully!", "success", 3000);
    }
  };

  window.openBulkDueReminderPrompt = function () {
    const list = (window._allCustomersDirectoryCache || []).filter((c) => c.totalBalance > 0.01 && c.phone);
    if (list.length === 0) {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("🎉 All customer accounts are cleared! No pending dues to remind.", "success", 4000);
      }
      return;
    }

    const totalDueSum = list.reduce((sum, c) => sum + c.totalBalance, 0);
    const confirmed = confirm(
      `Found ${list.length} customers with outstanding balances totaling ₹ ${formatMoney(totalDueSum)}.\n\n` +
      `Click OK to review and dispatch personalized WhatsApp payment statements.`
    );

    if (!confirmed) return;

    const prioritized = list.slice().sort((a, b) => b.totalBalance - a.totalBalance);
    const target = prioritized[0];
    const cleanPhone = target.phone.replace(/[^0-9]/g, "");

    const realUpi = (window.globalSettings?.upiId || window.globalSettings?.bank?.upi || "7386262139@upi").trim();
    const upiLink = `upi://pay?pa=${realUpi}&pn=AaryanAquaNeeds&am=${target.totalBalance.toFixed(2)}&cu=INR&tn=BalanceSettlement`;

    const msg = `🙏 *Greetings from Aaryan Aqua Needs!* 🌊\n` +
      `-----------------------------------\n` +
      `*PAYMENT STATEMENT & REMINDER*\n\n` +
      `Dear *${target.name}*,\n` +
      `Here is your current account balance:\n\n` +
      `💰 *Total Purchases:* ₹ ${formatMoney(target.totalBilled)}\n` +
      `💵 *Total Received:* ₹ ${formatMoney(target.totalPaid)}\n` +
      `🔴 *Outstanding Balance Due: ₹ ${formatMoney(target.totalBalance)}*\n\n` +
      `⚡ *1-Click Instant UPI Payment Link:*\n${upiLink}\n\n` +
      `🏦 *UPI ID:* ${realUpi}\n` +
      `-----------------------------------\n` +
      `Kindly settle the balance at your earliest convenience.\n` +
      `Thank you for your valued business! 🙏✨`;

    window.open(`https://wa.me/91${cleanPhone}?text=${encodeURIComponent(msg)}`, "_blank");
    if (typeof showFloatingToast === 'function') {
      showFloatingToast(`📱 Opened WhatsApp statement for ${target.name} (Due: ₹${formatMoney(target.totalBalance)})`, "info", 4500);
    }
  };
})();
