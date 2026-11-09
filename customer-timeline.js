/**
 * Customer Timeline & Payment Audit Extension
 * 1. Tracks exact timestamps, amounts, payment modes, and UTR/references for post-invoice payments.
 * 2. Comprehensive 360-degree Customer Profile Modal:
 *    - All invoices taken, invoice numbers, total purchases, outstanding dues.
 *    - Exact products purchased, quantities, rates, and purchase dates/times.
 *    - Complete payment logs: exact date and time paid, payment modes, and notes.
 */

(function () {
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

  // --- 1. CORE PAYMENT RECORDER FUNCTION ---
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
    const note = paymentDetails.note || "Post-invoice settlement";
    const paidAt = paymentDetails.timestamp || new Date().toISOString();

    const d = inv.details || inv;
    const currentTotal = Number(inv.total || d.total || d.grandTotal || 0);
    const existingPaid = Number(inv.paidAmount || d.paidAmount || 0);
    const newPaid = Math.min(currentTotal, existingPaid + amt);
    const newBalance = Math.max(0, currentTotal - newPaid);
    const newStatus = newBalance <= 0 ? "Paid" : "Partial";

    // Update root and details fields
    inv.paidAmount = newPaid;
    inv.balanceDue = newBalance;
    inv.paymentStatus = newStatus;
    inv.paymentMode = mode;
    inv.lastPaymentTime = paidAt;

    if (inv.details) {
      inv.details.paidAmount = newPaid;
      inv.details.balanceDue = newBalance;
      inv.details.paymentStatus = newStatus;
      inv.details.paymentMode = mode;
      inv.details.lastPaymentTime = paidAt;
    }

    // Append to payment history
    if (!inv.paymentHistory) inv.paymentHistory = [];
    inv.paymentHistory.push({
      date: paidAt,
      amount: amt,
      mode: mode,
      reference: ref,
      note: note,
      balanceAfter: newBalance,
      status: newStatus
    });

    if (isDemo) {
      try { sessionStorage.setItem("demo_invoices", JSON.stringify(invoicesDb)); } catch(e) {}
      if (typeof loadInvoicesHistoryTable === "function") loadInvoicesHistoryTable();
      if (typeof updateDashboardOverview === "function") updateDashboardOverview();
      if (typeof renderCustomerLedgerSummary === "function") renderCustomerLedgerSummary();
      if (typeof showFloatingToast === "function") {
        showFloatingToast(`✅ Demo Payment Simulated: Recorded ₹${formatMoney(amt)} on #${inv.invoiceNo || invoiceId} (Demo preview)`, "success", 4000);
      }
      return { ok: true, invoice: inv, simulated: true };
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

    // Refresh UI
    if (typeof loadInvoicesHistoryTable === "function") loadInvoicesHistoryTable();
    if (typeof updateDashboardOverview === "function") updateDashboardOverview();
    if (typeof renderCustomerLedgerSummary === "function") renderCustomerLedgerSummary();

    return { ok: true, invoice: inv };
  };

  // --- 2. 360-DEGREE CUSTOMER DETAIL MODAL ---
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
        const cName = String(inv.customerName || buyer.name || "").trim().toLowerCase();
        const phone = String(inv.customerPhone || buyer.phone || "").replace(/[^0-9]/g, "");
        const cleanTargetPhone = searchTarget.replace(/[^0-9]/g, "");

        return (
          cName === searchTarget ||
          cName.includes(searchTarget) ||
          (cleanTargetPhone && phone && phone.includes(cleanTargetPhone))
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

        if (allInvs[0].customerName || allInvs[0].details?.buyer?.name) {
          primaryCustName = allInvs[0].customerName || allInvs[0].details?.buyer?.name;
        }
        if (allInvs[0].customerPhone || allInvs[0].details?.buyer?.phone) {
          primaryPhone = allInvs[0].customerPhone || allInvs[0].details?.buyer?.phone;
        }
        if (allInvs[0].details?.buyer?.address) {
          primaryAddress = allInvs[0].details?.buyer?.address;
        }
        if (allInvs[0].details?.buyer?.gstin) {
          primaryGstin = allInvs[0].details?.buyer?.gstin;
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

          // Extract payment history safely
          if (Array.isArray(inv.paymentHistory) && inv.paymentHistory.length > 0) {
            inv.paymentHistory.forEach((p) => {
              if (!p) return;
              allPaymentEntries.push({
                invoiceNo: invNo,
                invoiceId: inv.id,
                date: p.date,
                amount: Number(p.amount || 0),
                mode: p.mode || "UPI / Online",
                reference: p.reference || p.utr || "—",
                note: p.note || p.source || "—"
              });
            });
          } else if (invPaid > 0) {
            allPaymentEntries.push({
              invoiceNo: invNo,
              invoiceId: inv.id,
              date: inv.lastPaymentTime || invDate,
              amount: invPaid,
              mode: inv.paymentMode || "Cash",
              reference: inv.paymentReference || "Upfront Bill Settlement",
              note: "Paid at time of billing"
            });
          }
        });

        // Sort payments by timestamp descending
        allPaymentEntries.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
      }

      currentActiveCustomerStatement = {
        name: primaryCustName,
        phone: primaryPhone,
        invoices: allInvs,
        products: allPurchasedProducts,
        payments: allPaymentEntries,
        totalBilled,
        totalPaid,
        totalBalance
      };

      // Populate modal DOM - ensure it exists
      let modal = document.getElementById("customer-details-modal");
      if (!modal) {
        modal = createCustomerDetailsModalDOM();
      }
      if (!modal) return;

      const setElText = (id, txt) => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
      };

      setElText("cust-detail-name", primaryCustName);
      setElText("cust-detail-phone", primaryPhone);
      setElText("cust-detail-address", primaryAddress);
      setElText("cust-detail-gstin", primaryGstin);

      setElText("cust-detail-total-invoices", allInvs.length);
      setElText("cust-detail-total-billed", "₹ " + formatMoney(totalBilled));
      setElText("cust-detail-total-paid", "₹ " + formatMoney(totalPaid));
      setElText("cust-detail-total-balance", "₹ " + formatMoney(totalBalance));

      // 1. Populate Invoices Table
      const invThead = document.querySelector("#pane-cust-tab-invoices table thead");
      if (invThead) {
        invThead.innerHTML = `
          <tr style="border-bottom: 2px solid #e2e8f0; color: #475569; text-align: left;">
            <th style="padding: 8px 10px;">INVOICE #</th>
            <th style="padding: 8px 10px;">BILL DATE &amp; TIME</th>
            <th style="padding: 8px 10px; text-align: right;">GRAND TOTAL</th>
            <th style="padding: 8px 10px; text-align: right;">PAID</th>
            <th style="padding: 8px 10px; text-align: right;">BALANCE</th>
            <th style="padding: 8px 10px; text-align: center;">STATUS</th>
            ${!isViewUser ? '<th style="padding: 8px 10px; text-align: center;">ACTION</th>' : ''}
          </tr>
        `;
      }
      const invTbody = document.getElementById("cust-detail-invoices-tbody");
      if (invTbody) {
        if (allInvs.length === 0) {
          invTbody.innerHTML = `<tr><td colspan="${!isViewUser ? '7' : '6'}" class="text-center text-muted" style="padding: 24px; color: #64748b;"><i class="fa-solid fa-file-invoice" style="font-size: 24px; color: #cbd5e1; display: block; margin-bottom: 8px;"></i>No invoices or bills recorded yet for this customer.</td></tr>`;
        } else {
          invTbody.innerHTML = allInvs
            .map((inv) => {
              if (!inv) return "";
              const invNo = inv.invoiceNo || inv.details?.invoiceNo || "—";
              const invDate = inv.date || inv.invoiceDate || inv.details?.date || "—";
              const invTotal = Number(inv.total || inv.details?.total || inv.details?.grandTotal || 0);
              const invPaid = Number(inv.paidAmount || inv.details?.paidAmount || 0);
              const invBal = Number(inv.balanceDue || inv.details?.balanceDue || 0);
              const status = invBal <= 0 ? "PAID" : (invPaid > 0 ? "PARTIAL" : "UNPAID");
              const statusBadge =
                status === "PAID"
                  ? '<span class="badge-status badge-paid">PAID</span>'
                  : (status === "PARTIAL"
                      ? '<span class="badge-status badge-partial">PARTIAL</span>'
                      : '<span class="badge-status badge-unpaid">UNPAID</span>');

              const safeInvId = String(inv.id || invNo).replace(/'/g, "\\'");
              return `
                <tr>
                  <td style="font-weight: 700; color: #0284c7; cursor: pointer;" onclick="openInvoicePrintPreview('${safeInvId}', 'a4')">
                    <i class="fa-solid fa-file-invoice"></i> #${invNo}
                  </td>
                  <td>${formatDateTime(invDate)}</td>
                  <td style="text-align: right; font-weight: 700;">₹ ${formatMoney(invTotal)}</td>
                  <td style="text-align: right; color: #16a34a; font-weight: 700;">₹ ${formatMoney(invPaid)}</td>
                  <td style="text-align: right; color: ${invBal > 0 ? '#b45309' : '#64748b'}; font-weight: 700;">₹ ${formatMoney(invBal)}</td>
                  <td class="text-center">${statusBadge}</td>
                  ${!isViewUser ? `
                  <td class="text-center">
                    ${invBal > 0
                      ? `<button class="btn btn-xs btn-primary" onclick="window.promptCustomerPaymentForInvoice('${safeInvId}')" style="padding: 4px 8px; font-size: 11px; font-weight: 700; border-radius: 4px;"><i class="fa-solid fa-hand-holding-dollar"></i> Settle</button>`
                      : '<span style="color: #10b981; font-weight: 700; font-size: 11px;">Settled</span>'
                    }
                  </td>` : ''}
                </tr>
              `;
            })
            .join("");
        }
      }

      // 2. Populate Products Purchased Table
      const prodTbody = document.getElementById("cust-detail-products-tbody");
      if (prodTbody) {
        prodTbody.innerHTML =
          allPurchasedProducts.length === 0
            ? '<tr><td colspan="6" class="text-center text-muted" style="padding: 24px; color: #64748b;">No item details available.</td></tr>'
            : allPurchasedProducts
                .map(
                  (p) => {
                    const safeInvRef = String(p.invoiceId || p.invoiceNo).replace(/'/g, "\\'");
                    return `
                      <tr>
                        <td style="font-weight: 600;">${p.name}</td>
                        <td><span style="color: #0284c7; font-weight: 600; cursor: pointer;" onclick="openInvoicePrintPreview('${safeInvRef}', 'a4')">#${p.invoiceNo}</span></td>
                        <td>${formatDateTime(p.date)}</td>
                        <td class="text-center" style="font-weight: 700;">${p.quantity} ${p.unit}</td>
                        <td style="text-align: right;">₹ ${formatMoney(p.rate)}</td>
                        <td style="text-align: right; font-weight: 700; color: #0f172a;">₹ ${formatMoney(p.total)}</td>
                      </tr>
                    `;
                  }
                )
                .join("");
      }

      // 3. Populate Payments Timeline Log Table
      const payTbody = document.getElementById("cust-detail-payments-tbody");
      if (payTbody) {
        payTbody.innerHTML =
          allPaymentEntries.length === 0
            ? '<tr><td colspan="5" class="text-center text-muted" style="padding: 24px; color: #64748b;">No recorded payment entries.</td></tr>'
            : allPaymentEntries
                .map(
                  (pay) => {
                    const safeInvRef = String(pay.invoiceId || pay.invoiceNo).replace(/'/g, "\\'");
                    return `
                      <tr>
                        <td style="font-weight: 600;">${formatDateTime(pay.date)}</td>
                        <td><span style="color: #0284c7; font-weight: 600; cursor: pointer;" onclick="openInvoicePrintPreview('${safeInvRef}', 'a4')">#${pay.invoiceNo}</span></td>
                        <td style="text-align: right; font-weight: 700; color: #16a34a; font-size: 13px;">₹ ${formatMoney(pay.amount)}</td>
                        <td><span class="badge-status badge-paid" style="background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd;">${pay.mode}</span></td>
                        <td style="font-size: 11.5px; color: #475569;">${pay.reference !== '—' ? `<strong>Ref:</strong> ${pay.reference} ` : ''}${pay.note !== '—' ? `(${pay.note})` : ''}</td>
                      </tr>
                    `;
                  }
                )
                .join("");
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

      // Show modal with robust styling to override any previous display:none
      modal.classList.remove("hidden");
      modal.style.removeProperty("display");
      modal.style.removeProperty("visibility");
      modal.style.removeProperty("pointer-events");
      modal.style.setProperty("display", "flex", "important");
      modal.style.setProperty("visibility", "visible", "important");
      modal.style.setProperty("opacity", "1", "important");
      modal.style.setProperty("pointer-events", "auto", "important");
      modal.style.setProperty("z-index", "99999", "important");
    } catch (err) {
      console.error("[CustomerTimeline] Error opening customer modal:", err);
      if (typeof showFloatingToast === "function") {
        showFloatingToast("⚠️ Could not open customer details: " + (err.message || "Unknown error"), "warning", 3500);
      }
    }
  };

  let currentActiveCustomerStatement = null;

  window.printCustomerStatement = function () {
    if (!currentActiveCustomerStatement) return;
    const s = currentActiveCustomerStatement;
    const printWin = window.open("", "_blank", "width=850,height=900");
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
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; padding: 24px; color: #1e293b; }
          .header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; }
          .title { font-size: 20px; font-weight: bold; color: #0284c7; }
          .kpi-row { display: flex; gap: 14px; margin-bottom: 24px; }
          .kpi { flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; }
          .kpi-val { font-size: 16px; font-weight: bold; margin-top: 4px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px; }
          th, td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
          th { background: #f8fafc; font-weight: bold; }
          .text-right { text-align: right; }
          .text-center { text-align: center; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="title">AARYAN AQUA NEEDS</div>
            <div style="font-size: 13px; color: #64748b;">Customer Account & Payment Statement</div>
          </div>
          <div style="text-align: right; font-size: 12px;">
            <strong>Statement Date:</strong> ${new Date().toLocaleDateString("en-IN")}<br>
            <strong>Customer:</strong> ${s.name} (${s.phone || 'No phone'})
          </div>
        </div>

        <div class="kpi-row">
          <div class="kpi"><div>Total Invoices</div><div class="kpi-val">${s.invoices.length}</div></div>
          <div class="kpi"><div>Total Billed</div><div class="kpi-val">₹ ${formatMoney(s.totalBilled)}</div></div>
          <div class="kpi"><div>Total Received</div><div class="kpi-val" style="color: #16a34a;">₹ ${formatMoney(s.totalPaid)}</div></div>
          <div class="kpi" style="border-color: #fca5a5; background: #fff5f5;"><div>Balance Due</div><div class="kpi-val" style="color: #dc2626;">₹ ${formatMoney(s.totalBalance)}</div></div>
        </div>

        <h3>Invoices Record</h3>
        <table>
          <thead>
            <tr><th>Invoice #</th><th>Date</th><th class="text-right">Grand Total</th><th class="text-right">Paid</th><th class="text-right">Balance</th><th class="text-center">Status</th></tr>
          </thead>
          <tbody>
            ${s.invoices.map(inv => `
              <tr>
                <td>#${inv.invoiceNo || '—'}</td>
                <td>${formatDateTime(inv.date || inv.invoiceDate)}</td>
                <td class="text-right">₹ ${formatMoney(inv.total || inv.grandTotal)}</td>
                <td class="text-right">₹ ${formatMoney(inv.paidAmount)}</td>
                <td class="text-right">₹ ${formatMoney(inv.balanceDue)}</td>
                <td class="text-center">${(inv.balanceDue || 0) <= 0 ? 'PAID' : 'PENDING'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <h3>Payment Receipts & Timeline Log</h3>
        <table>
          <thead>
            <tr><th>Exact Payment Date & Time</th><th>Invoice #</th><th class="text-right">Amount Received</th><th>Mode</th><th>Reference</th></tr>
          </thead>
          <tbody>
            ${s.payments.length === 0 ? '<tr><td colspan="5" class="text-center">No payment entries.</td></tr>' : s.payments.map(p => `
              <tr>
                <td>${formatDateTime(p.date)}</td>
                <td>#${p.invoiceNo}</td>
                <td class="text-right" style="color: #16a34a; font-weight: bold;">₹ ${formatMoney(p.amount)}</td>
                <td>${p.mode}</td>
                <td>${p.reference || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div style="margin-top: 30px; font-size: 11px; color: #94a3b8; text-align: center;">
          Generated electronically by Aaryan Aqua Needs Billing System.
        </div>
        <script>window.onload = function() { window.print(); }<\/script>
      </body>
      </html>
    `;

    printWin.document.open();
    printWin.document.write(html);
    printWin.document.close();
  };

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
      `📋 *Total Bills:* ${s.invoices.length}\n` +
      `💰 *Total Purchases:* ₹ ${formatMoney(s.totalBilled)}\n` +
      `💵 *Total Paid / Received:* ₹ ${formatMoney(s.totalPaid)}\n` +
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

  window.closeCustomerDetailsModal = function () {
    const modal = document.getElementById("customer-details-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.style.setProperty("display", "none", "important");
      modal.style.setProperty("visibility", "hidden", "important");
      modal.style.setProperty("pointer-events", "none", "important");
    }
  };

  // Helper dialog to settle a specific bill directly from customer timeline
  window.promptCustomerPaymentForInvoice = function (invId) {
    const isDemo = (typeof window.isDemoMode === 'function') && window.isDemoMode();
    if (!isDemo && typeof window.isViewOnlyUser === 'function' && window.isViewOnlyUser()) {
      if (typeof showFloatingToast === 'function') {
        showFloatingToast("⛔ Access Denied: Payment settlement is disabled in View-Only mode.", "error", 4000);
      }
      return;
    }
    if (typeof openBalanceQrModal === "function") {
      closeCustomerDetailsModal();
      openBalanceQrModal(invId);
    }
  };

  // Switch tabs inside customer profile modal
  window.switchCustDetailTab = function (tabName) {
    const tabs = ["invoices", "products", "payments"];
    tabs.forEach((t) => {
      const btn = document.getElementById(`btn-cust-tab-${t}`);
      const pane = document.getElementById(`pane-cust-tab-${t}`);
      if (btn) btn.classList.toggle("active", t === tabName);
      if (pane) pane.style.display = t === tabName ? "block" : "none";
    });
  };

  function createCustomerDetailsModalDOM() {
    const existing = document.getElementById("customer-details-modal");
    if (existing) return existing;
    const div = document.createElement("div");
    div.id = "customer-details-modal";
    div.className = "modal-overlay hidden no-print";
    div.style.cssText =
      "position: fixed; inset: 0; background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(4px); display: none; align-items: center; justify-content: center; z-index: 99999; padding: 16px;";
    div.onclick = function (e) {
      if (e.target === div) closeCustomerDetailsModal();
    };

    div.innerHTML = `
      <div class="modal-box" style="background: #ffffff; width: 100%; max-width: 950px; max-height: 90vh; border-radius: 14px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); display: flex; flex-direction: column; overflow: hidden; font-family: inherit;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff; padding: 18px 24px; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 44px; height: 44px; background: rgba(14, 165, 233, 0.2); border: 1.5px solid #0ea5e9; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; color: #38bdf8;">
              <i class="fa-solid fa-user-tie"></i>
            </div>
            <div>
              <div style="font-size: 18px; font-weight: 800; color: #ffffff;" id="cust-detail-name">Customer Name</div>
              <div style="font-size: 12px; color: #94a3b8; display: flex; gap: 14px; margin-top: 3px;">
                <span><i class="fa-solid fa-phone text-emerald"></i> <span id="cust-detail-phone">—</span></span>
                <span><i class="fa-solid fa-location-dot text-rose"></i> <span id="cust-detail-address">—</span></span>
                <span><i class="fa-solid fa-id-card text-cyan"></i> GSTIN: <span id="cust-detail-gstin">—</span></span>
              </div>
            </div>
          </div>
          <button type="button" onclick="closeCustomerDetailsModal()" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; padding: 6px 10px; border-radius: 6px;">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <!-- Metric KPI Cards -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 16px 24px; background: #f8fafc; border-bottom: 1px solid #e2e8f0;">
          <div style="background: #ffffff; padding: 12px 14px; border-radius: 10px; border: 1px solid #e2e8f0;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Invoices</div>
            <div style="font-size: 19px; font-weight: 800; color: #0f172a; margin-top: 4px;" id="cust-detail-total-invoices">0</div>
          </div>
          <div style="background: #ffffff; padding: 12px 14px; border-radius: 10px; border: 1px solid #e2e8f0;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Billed</div>
            <div style="font-size: 19px; font-weight: 800; color: #0284c7; margin-top: 4px;" id="cust-detail-total-billed">₹ 0.00</div>
          </div>
          <div style="background: #ffffff; padding: 12px 14px; border-radius: 10px; border: 1px solid #e2e8f0;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Total Received</div>
            <div style="font-size: 19px; font-weight: 800; color: #16a34a; margin-top: 4px;" id="cust-detail-total-paid">₹ 0.00</div>
          </div>
          <div style="background: #ffffff; padding: 12px 14px; border-radius: 10px; border: 1.5px solid #fecaca; background: #fff5f5;">
            <div style="font-size: 11px; font-weight: 700; color: #dc2626; text-transform: uppercase;">Outstanding Due</div>
            <div style="font-size: 19px; font-weight: 800; color: #dc2626; margin-top: 4px;" id="cust-detail-total-balance">₹ 0.00</div>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div style="display: flex; gap: 8px; padding: 12px 24px 0 24px; border-bottom: 1px solid #e2e8f0; background: #ffffff;">
          <button type="button" id="btn-cust-tab-invoices" class="active" onclick="switchCustDetailTab('invoices')" style="padding: 10px 16px; font-size: 13px; font-weight: 700; border: none; background: transparent; border-bottom: 3px solid #0284c7; color: #0284c7; cursor: pointer;">
            <i class="fa-solid fa-file-invoice"></i> Invoices Taken
          </button>
          <button type="button" id="btn-cust-tab-products" onclick="switchCustDetailTab('products')" style="padding: 10px 16px; font-size: 13px; font-weight: 700; border: none; background: transparent; border-bottom: 3px solid transparent; color: #64748b; cursor: pointer;">
            <i class="fa-solid fa-boxes-stacked"></i> Products Purchased &amp; Times
          </button>
          <button type="button" id="btn-cust-tab-payments" onclick="switchCustDetailTab('payments')" style="padding: 10px 16px; font-size: 13px; font-weight: 700; border: none; background: transparent; border-bottom: 3px solid transparent; color: #64748b; cursor: pointer;">
            <i class="fa-solid fa-clock-rotate-left"></i> Payment Log &amp; Settled Timestamps
          </button>
        </div>

        <!-- Body Panes Scrollable Container -->
        <div style="padding: 16px 24px; overflow-y: auto; flex: 1; background: #ffffff;">
          
          <!-- Pane 1: Invoices -->
          <div id="pane-cust-tab-invoices">
            <table class="dashboard-table" style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
              <thead>
                <tr style="border-bottom: 2px solid #e2e8f0; color: #475569; text-align: left;">
                  <th style="padding: 8px 10px;">INVOICE #</th>
                  <th style="padding: 8px 10px;">BILL DATE &amp; TIME</th>
                  <th style="padding: 8px 10px; text-align: right;">GRAND TOTAL</th>
                  <th style="padding: 8px 10px; text-align: right;">PAID</th>
                  <th style="padding: 8px 10px; text-align: right;">BALANCE</th>
                  <th style="padding: 8px 10px; text-align: center;">STATUS</th>
                  <th style="padding: 8px 10px; text-align: center;">SETTLE</th>
                </tr>
              </thead>
              <tbody id="cust-detail-invoices-tbody"></tbody>
            </table>
          </div>

          <!-- Pane 2: Products Purchased -->
          <div id="pane-cust-tab-products" style="display: none;">
            <table class="dashboard-table" style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
              <thead>
                <tr style="border-bottom: 2px solid #e2e8f0; color: #475569; text-align: left;">
                  <th style="padding: 8px 10px;">PRODUCT NAME</th>
                  <th style="padding: 8px 10px;">BILL #</th>
                  <th style="padding: 8px 10px;">PURCHASE DATE &amp; TIME</th>
                  <th style="padding: 8px 10px; text-align: center;">QTY</th>
                  <th style="padding: 8px 10px; text-align: right;">RATE</th>
                  <th style="padding: 8px 10px; text-align: right;">TOTAL (₹)</th>
                </tr>
              </thead>
              <tbody id="cust-detail-products-tbody"></tbody>
            </table>
          </div>

          <!-- Pane 3: Payment History Log -->
          <div id="pane-cust-tab-payments" style="display: none;">
            <table class="dashboard-table" style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
              <thead>
                <tr style="border-bottom: 2px solid #e2e8f0; color: #475569; text-align: left;">
                  <th style="padding: 8px 10px;">EXACT PAYMENT TIME</th>
                  <th style="padding: 8px 10px;">FOR INVOICE #</th>
                  <th style="padding: 8px 10px; text-align: right;">AMOUNT PAID</th>
                  <th style="padding: 8px 10px;">PAYMENT MODE</th>
                  <th style="padding: 8px 10px;">UTR / REFERENCE / NOTE</th>
                </tr>
              </thead>
              <tbody id="cust-detail-payments-tbody"></tbody>
            </table>
          </div>

        </div>

        <!-- Footer -->
        <div style="background: #f8fafc; padding: 12px 24px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
          <div id="cust-modal-statement-actions" style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-sm btn-secondary" onclick="window.printCustomerStatement()" style="display: flex; align-items: center; gap: 6px; font-weight: 700; padding: 8px 14px; border-radius: 8px;">
              <i class="fa-solid fa-print"></i> Print Account Statement
            </button>
            <button type="button" class="btn btn-sm btn-whatsapp" onclick="window.sendWhatsAppCustomerStatement()" style="display: flex; align-items: center; gap: 6px; font-weight: 700; padding: 8px 14px; border-radius: 8px; background: #16a34a; color: white; border: none;">
              <i class="fa-brands fa-whatsapp"></i> Share Statement
            </button>
          </div>
          <button type="button" class="btn btn-secondary" onclick="closeCustomerDetailsModal()" style="padding: 8px 18px; font-weight: 700; border-radius: 8px;">Close</button>
        </div>

      </div>
    `;

    document.body.appendChild(div);
    return div;
  }

  // --- 3. DEDICATED CUSTOMERS DIRECTORY SECTION VIEW ---
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
            No customers found matching your search.
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
                <span style="color: #0284c7; text-decoration: underline; text-underline-offset: 2px;">${c.name}</span>
                ${c.address ? `<div style="font-size: 11px; color: #94a3b8; font-weight: 400;">${c.address}</div>` : ''}
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
              <button class="btn btn-xs" onclick="startBillForCustomer('${safeName}')" title="Create New Bill" style="width: 28px; height: 28px; border-radius: 6px; background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; cursor: pointer;">
                <i class="fa-solid fa-cart-plus"></i>
              </button>
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
          <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">Try searching with a different name or phone number.</div>
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
)}" target="_blank" onclick="event.stopPropagation();" title="Send WhatsApp Bill &amp; Payment Link" style="color: #16a34a; font-size: 16px; padding: 3px 6px; text-decoration: none; display: inline-flex; align-items: center;">
                <i class="fa-brands fa-whatsapp"></i>
              </a>
            ` : ''}
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

  // --- 4. ADVANCED EXPORT: COMPLETE CUSTOMER DIRECTORY AS CSV ---
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

  // --- 5. ADVANCED BROADCAST: BULK WHATSAPP PAYMENT REMINDERS ---
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

    // Send WhatsApp statement for the first customer in due list with highest balance
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


