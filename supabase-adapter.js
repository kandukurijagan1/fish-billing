/**
 * Supabase Client & Synchronization Adapter
 * Enables direct PostgreSQL / Supabase synchronization for Invoices, Products, Customers, and Settings.
 */

(function () {
  const SUPABASE_CONFIG = {
    url: (typeof process !== "undefined" && process.env && process.env.SUPABASE_URL) ||
         (typeof window !== "undefined" && window.SUPABASE_URL) || 
         (typeof localStorage !== "undefined" && localStorage.getItem("aaryan_supabase_url")) || 
         "https://tfncblvaaemkbtvqnpdn.supabase.co",
    anonKey: (typeof process !== "undefined" && process.env && process.env.SUPABASE_ANON_KEY) ||
             (typeof window !== "undefined" && window.SUPABASE_ANON_KEY) || 
             (typeof localStorage !== "undefined" && localStorage.getItem("aaryan_supabase_anon_key")) || 
             "sb_publishable_D7LL7bdXwN1kEUeV3JEygQ_AdM_366s"
  };

  let client = null;
  let realtimeChannel = null;
  const realtimeListeners = new Set();
  let requestTokens = 30;
  let lastTokenRefill = Date.now();

  // Security: Token-bucket rate limiter to prevent DDoS / runaway request storms
  function checkRateLimit() {
    const now = Date.now();
    const elapsed = (now - lastTokenRefill) / 1000;
    requestTokens = Math.min(30, requestTokens + elapsed * 10);
    lastTokenRefill = now;
    if (requestTokens < 1) {
      console.warn("[Supabase Security] Request rate throttled to protect database bandwidth.");
      return false;
    }
    requestTokens -= 1;
    return true;
  }

  // Security: Prototype pollution & injection defense
  function sanitizePayload(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sanitizePayload);
    const safe = {};
    const forbidden = ['__proto__', 'constructor', 'prototype'];
    for (const k of Object.keys(obj)) {
      if (forbidden.includes(k)) continue;
      const val = obj[k];
      if (typeof val === 'number') {
        safe[k] = (isNaN(val) || !isFinite(val)) ? 0 : val;
      } else if (typeof val === 'string') {
        safe[k] = val.trim();
      } else if (typeof val === 'object' && val !== null) {
        safe[k] = sanitizePayload(val);
      } else {
        safe[k] = val;
      }
    }
    return safe;
  }

  function isDemoActive() {
    if (typeof window === 'undefined') return false;
    if (window._isRestoringData === true) return false;
    if (typeof localStorage !== 'undefined' && (localStorage.getItem("is_imported_data") === "true" || localStorage.getItem("has_real_data") === "true")) return false;
    if (typeof window.isDemoMode === 'function') return window.isDemoMode();
    if (typeof window.isViewOnlyUser === 'function' && window.isViewOnlyUser()) return true;
    if (typeof sessionStorage !== 'undefined' && (sessionStorage.getItem("is_demo_mode") === "true" || sessionStorage.getItem("current_user_role") === "viewer")) return true;
    return false;
  }

  function getDemoSnapshot() {
    if (typeof window !== 'undefined' && window.FIXED_DEMO_SNAPSHOT) return window.FIXED_DEMO_SNAPSHOT;
    if (typeof FIXED_DEMO_SNAPSHOT !== 'undefined') return FIXED_DEMO_SNAPSHOT;
    return null;
  }

  function initClient() {
    if (client) return client;
    const clientOptions = {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 20 } },
      global: {
        headers: {
          'x-application-name': 'aaryan-aqua-billing',
          'x-client-speed': 'turbo-v5',
          'x-app-signature': 'aaryan_vault_sig_9f8e7d6c5b4a3210'
        }
      }
    };
    if (typeof window !== "undefined") {
      if (typeof window.createClient === "function" && SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey) {
        client = window.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, clientOptions);
      } else if (typeof window.supabase !== "undefined" && typeof window.supabase.createClient === "function" && SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey) {
        client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, clientOptions);
      }
    }
    if (!client && typeof require === "function") {
      try {
        const { createClient } = require("@supabase/supabase-js");
        client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, clientOptions);
      } catch (e) {}
    }
    return client;
  }

  const SupabaseDB = {
    isConfigured() {
      return Boolean(SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey);
    },

    setCredentials(url, key) {
      SUPABASE_CONFIG.url = String(url || "").trim();
      SUPABASE_CONFIG.anonKey = String(key || "").trim();
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("aaryan_supabase_url", SUPABASE_CONFIG.url);
        localStorage.setItem("aaryan_supabase_anon_key", SUPABASE_CONFIG.anonKey);
      }
      client = null;
      initClient();
    },

    getClient() {
      return initClient();
    },

    // --- INVOICES ---
    async upsertInvoice(inv) {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      if (!checkRateLimit()) return { ok: false, throttled: true };
      const sb = initClient();
      if (!sb || !inv || !inv.id) return { ok: false, error: "not_configured" };

      const safeInv = sanitizePayload(inv);
      const row = {
        id: String(safeInv.id),
        invoice_no: String(safeInv.invoiceNo || safeInv.invoice_no || safeInv.id),
        date: String(safeInv.date || safeInv.invoiceDate || ""),
        customer_name: String(safeInv.customerName || safeInv.customer_name || ""),
        phone: String(safeInv.customerPhone || safeInv.phone || ""),
        items: Array.isArray(safeInv.items) ? safeInv.items : [],
        subtotal: Number(safeInv.subtotal || safeInv.subTotal || 0),
        tax: Number(safeInv.tax || 0),
        cgst: Number(safeInv.cgst || 0),
        sgst: Number(safeInv.sgst || 0),
        igst: Number(safeInv.igst || 0),
        discount: Number(safeInv.discount || 0),
        round_off: Number(safeInv.roundOff || safeInv.round_off || 0),
        grand_total: Number(safeInv.grandTotal || safeInv.grand_total || safeInv.total || 0),
        paid_amount: Number(safeInv.paidAmount || safeInv.paid_amount || 0),
        balance_due: Number(safeInv.balanceDue || safeInv.balance_due || 0),
        payment_status: String(safeInv.paymentStatus || safeInv.status || "PAID"),
        payment_mode: String(safeInv.paymentMode || "UPI / QR"),
        vehicle_no: String(safeInv.vehicleNo || ""),
        transport_name: String(safeInv.transportName || ""),
        destination: String(safeInv.destination || ""),
        raw_data: safeInv,
        is_deleted: Boolean(safeInv.isDeleted || safeInv._deleted),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await sb.from("invoices").upsert(row, { onConflict: "id" });
      if (error) {
        console.error("[Supabase] Upsert invoice failed:", error);
        return { ok: false, error };
      }
      return { ok: true, data };
    },

    async bulkUpsertInvoices(invoices) {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      if (!checkRateLimit()) return { ok: false, throttled: true };
      const sb = initClient();
      if (!sb || !Array.isArray(invoices) || invoices.length === 0) return { ok: false };

      const safeInvoices = sanitizePayload(invoices);
      const rows = safeInvoices.map(inv => {
        const raw = inv.details || inv;
        const gTot = Number(inv.total !== undefined ? inv.total : (inv.grandTotal !== undefined ? inv.grandTotal : (raw.total || raw.grandTotal || 0)));
        const paid = Number(inv.paidAmount !== undefined ? inv.paidAmount : (raw.paidAmount || 0));
        const bal = Number(inv.balanceDue !== undefined ? inv.balanceDue : (raw.balanceDue !== undefined ? raw.balanceDue : Math.max(0, gTot - paid)));
        const items = Array.isArray(inv.items) && inv.items.length > 0 ? inv.items : (Array.isArray(raw.items) ? raw.items : []);
        const invDate = String(inv.date || inv.invoiceDate || raw.date || raw.invoiceDate || "");
        const custName = String(inv.customerName || (raw.buyer && raw.buyer.name) || raw.customerName || "");
        const phone = String(inv.customerPhone || inv.phone || (raw.buyer && raw.buyer.phone) || "");

        return {
          id: String(inv.id || inv.invoiceNo),
          invoice_no: String(inv.invoiceNo || raw.invoiceNo || inv.id),
          date: invDate,
          customer_name: custName,
          phone: phone,
          items: items,
          subtotal: Number(inv.subtotal || raw.subtotal || gTot),
          tax: Number(inv.tax || raw.tax || 0),
          cgst: Number(inv.cgst || (raw.totals && raw.totals.cgst) || 0),
          sgst: Number(inv.sgst || (raw.totals && raw.totals.sgst) || 0),
          igst: Number(inv.igst || (raw.totals && raw.totals.igst) || 0),
          discount: Number(inv.discount || raw.discount || 0),
          round_off: Number(inv.roundOff || (raw.totals && raw.totals.roundOff) || 0),
          grand_total: gTot,
          paid_amount: paid,
          balance_due: bal,
          payment_status: String(inv.paymentStatus || raw.paymentStatus || (bal <= 0.01 ? "PAID" : (paid > 0 ? "PARTIAL" : "CREDIT"))),
          payment_mode: String(inv.paymentMode || raw.paymentMode || "UPI / QR"),
          vehicle_no: String(inv.vehicleNo || raw.vehicleNo || ""),
          transport_name: String(inv.transportName || raw.transportName || ""),
          destination: String(inv.destination || raw.destination || ""),
          raw_data: inv,
          is_deleted: false,
          updated_at: new Date().toISOString()
        };
      });

      for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50);
        const { error } = await sb.from("invoices").upsert(chunk, { onConflict: "id" });
        if (error) {
          console.error("[Supabase] bulkUpsertInvoices chunk error:", error);
          return { ok: false, error };
        }
      }
      return { ok: true, count: rows.length };
    },

    rowToInvoice(row) {
      if (!row) return null;
      const raw = row.raw_data || {};
      const grandTot = Number(row.grand_total !== undefined && row.grand_total !== null ? row.grand_total : (raw.grandTotal || raw.total || 0));
      const paidAmt = Number(row.paid_amount !== undefined && row.paid_amount !== null ? row.paid_amount : (raw.paidAmount || 0));
      const balDue = Number(row.balance_due !== undefined && row.balance_due !== null ? row.balance_due : (raw.balanceDue !== undefined ? raw.balanceDue : Math.max(0, grandTot - paidAmt)));
      const hist = Array.isArray(raw.paymentHistory) ? raw.paymentHistory : [];
      return {
        ...raw,
        id: row.id,
        invoiceNo: row.invoice_no,
        date: row.date,
        customerName: row.customer_name,
        customerPhone: row.phone,
        items: row.items,
        total: grandTot,
        grandTotal: grandTot,
        paidAmount: paidAmt,
        balanceDue: balDue,
        paymentStatus: row.payment_status || (balDue <= 0.01 ? "Paid" : (paidAmt > 0 ? "Partial" : "Unpaid")),
        paymentMode: row.payment_mode || "Cash",
        paymentHistory: hist,
        details: {
          ...raw,
          id: row.id,
          invoiceNo: row.invoice_no,
          date: row.date,
          total: grandTot,
          grandTotal: grandTot,
          paidAmount: paidAmt,
          balanceDue: balDue,
          paymentStatus: row.payment_status || (balDue <= 0.01 ? "Paid" : (paidAmt > 0 ? "Partial" : "Unpaid")),
          paymentMode: row.payment_mode || "Cash",
          paymentHistory: hist
        }
      };
    },

    rowToProduct(row) {
      if (!row) return null;
      return {
        id: row.id,
        description: row.description || "",
        hsn: row.hsn || "230990",
        packSize: row.pack_size || "",
        unit: row.unit || "NOS",
        rate: Number(row.rate) || 0,
        discount: Number(row.discount) || 0,
        price: Number(row.price) || 0,
        stock: Number(row.stock) || 0,
        totalValue: Number(row.total_value) || 0,
        status: row.status || (Number(row.stock) > 0 ? "In Stock" : "Out of Stock"),
        barcode: row.barcode || "",
        is_deleted: false,
        updatedAt: row.updated_at || new Date().toISOString()
      };
    },

    rowToCustomer(row) {
      if (!row) return null;
      return {
        id: row.id,
        name: row.name || "",
        company: row.company || row.name || "",
        type: row.customer_type || row.type || "receiver",
        phone: row.phone || "",
        email: row.email || "",
        address: row.address || "",
        city: row.city || "",
        state: row.state || "Andhra Pradesh",
        stateCode: row.state_code || row.stateCode || "37",
        gstin: row.gstin || "",
        balance: Number(row.balance || 0),
        is_deleted: false,
        updatedAt: row.updated_at || new Date().toISOString()
      };
    },

    async fetchInvoices(options = {}) {
      if (isDemoActive()) {
        const snap = getDemoSnapshot();
        return { ok: true, invoices: (snap && snap.invoices) ? JSON.parse(JSON.stringify(snap.invoices)) : [] };
      }
      if (!checkRateLimit()) return { ok: false, throttled: true };
      const sb = initClient();
      if (!sb) return { ok: false, error: "not_configured" };

      let query = sb
        .from("invoices")
        .select("*")
        .eq("is_deleted", false)
        .order("created_at", { ascending: false });

      if (options.since) {
        query = query.gt("updated_at", options.since);
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }

      const { data, error } = await query;

      if (error) {
        console.error("[Supabase] Fetch invoices failed:", error);
        return { ok: false, error };
      }

      const invoices = (data || []).map(row => this.rowToInvoice(row)).filter(Boolean);

      return { ok: true, invoices };
    },

    async deleteInvoice(idOrInvoiceNo) {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb || !idOrInvoiceNo) return { ok: false, error: "not_configured" };

      const clean = String(idOrInvoiceNo).trim().replace(/^#/, '');
      try {
        const filter = `id.eq.${idOrInvoiceNo},id.eq.${clean},invoice_no.eq.${idOrInvoiceNo},invoice_no.eq.${clean}`;
        const upRes = await sb.from("invoices")
          .update({ is_deleted: true, updated_at: new Date().toISOString() })
          .or(filter);
        if (upRes && upRes.error) console.error("[Supabase] deleteInvoice update error:", upRes.error);

        const delRes = await sb.from("invoices")
          .delete()
          .or(filter);
        if (delRes && delRes.error) console.error("[Supabase] deleteInvoice delete error:", delRes.error);

        return { ok: true };
      } catch (err) {
        console.error("[Supabase] Delete invoice error:", err);
        return { ok: false, error: err };
      }
    },

    async clearAllInvoices() {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb) return { ok: false, error: "not_configured" };

      try {
        await sb.from("invoices").update({ is_deleted: true, updated_at: new Date().toISOString() }).neq("id", "___nonexistent___");
        await sb.from("invoices").delete().neq("id", "___nonexistent___");
        return { ok: true };
      } catch (err) {
        console.error("[Supabase] Clear all invoices error:", err);
        return { ok: false, error: err };
      }
    },

    // --- PRODUCTS ---
    async upsertProduct(p) {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb || !p || !p.id) return { ok: false, error: "not_configured" };

      const row = {
        id: String(p.id),
        description: String(p.description || ""),
        hsn: String(p.hsn || ""),
        pack_size: String(p.packSize || p.pack_size || ""),
        unit: String(p.unit || "NOS"),
        rate: Number(p.rate || 0),
        discount: Number(p.discount || 0),
        price: Number(p.price || p.rate || 0),
        stock: Number(p.stock || 0),
        total_value: Number(p.totalValue || (p.stock * (p.price || p.rate)) || 0),
        status: String(p.status || "In Stock"),
        is_deleted: Boolean(p.isDeleted || p._deleted),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await sb.from("products").upsert(row, { onConflict: "id" });
      if (error) return { ok: false, error };
      return { ok: true, data };
    },

    async saveAllProducts(products) {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb || !Array.isArray(products) || products.length === 0) return { ok: false };
      const rows = products.map(p => ({
        id: String(p.id),
        description: String(p.description || ""),
        hsn: String(p.hsn || ""),
        pack_size: String(p.packSize || p.pack_size || ""),
        unit: String(p.unit || "NOS"),
        rate: Number(p.rate || 0),
        discount: Number(p.discount || 0),
        price: Number(p.price || p.rate || 0),
        stock: Number(p.stock || 0),
        total_value: Number(p.totalValue || (p.stock * (p.price || p.rate)) || 0),
        status: String(p.status || "In Stock"),
        is_deleted: Boolean(p.isDeleted || p._deleted),
        updated_at: new Date().toISOString()
      }));
      const { error } = await sb.from("products").upsert(rows, { onConflict: "id" });
      if (error) {
        console.error("[Supabase] saveAllProducts error:", error);
        return { ok: false, error };
      }
      return { ok: true };
    },

    async bulkUpsertProducts(products) {
      return this.saveAllProducts(products);
    },

    async bulkUpsertCustomers(customers) {
      return this.saveAllCustomers(customers);
    },

    async fetchProducts(options = {}) {
      if (isDemoActive()) {
        const snap = getDemoSnapshot();
        return { ok: true, products: (snap && snap.products) ? JSON.parse(JSON.stringify(snap.products)) : [] };
      }
      if (!checkRateLimit()) return { ok: false, throttled: true };
      const sb = initClient();
      if (!sb) return { ok: false, error: "not_configured" };

      let query = sb
        .from("products")
        .select("*")
        .eq("is_deleted", false)
        .order("description", { ascending: true });

      if (options.since) {
        query = query.gt("updated_at", options.since);
      }

      const { data, error } = await query;

      if (error) return { ok: false, error };

      const products = (data || []).map(row => this.rowToProduct(row)).filter(Boolean);

      return { ok: true, products };
    },

    async deleteProduct(id) {
      const sb = initClient();
      if (!sb || !id) return { ok: false };
      try {
        await sb.from("products").update({ is_deleted: true, updated_at: new Date().toISOString() }).eq("id", String(id));
        await sb.from("products").delete().eq("id", String(id));
        return { ok: true };
      } catch (err) {
        console.error("[Supabase] deleteProduct error:", err);
        return { ok: false, error: err };
      }
    },

    async clearAllProducts() {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb) return { ok: false };
      try {
        await sb.from("products").update({ is_deleted: true, updated_at: new Date().toISOString() }).neq("id", "___nonexistent___");
        await sb.from("products").delete().neq("id", "___nonexistent___");
        return { ok: true };
      } catch (err) {
        console.error("[Supabase] clearAllProducts error:", err);
        return { ok: false, error: err };
      }
    },

    // --- CUSTOMERS & PARTIES ---
    async upsertCustomer(c) {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb || !c || !c.id) return { ok: false, error: "not_configured" };

      // Also persist rich party details into settings.parties_list
      try {
        const { data: pData } = await sb.from("settings").select("value").eq("key", "parties_list").maybeSingle();
        let list = (pData && Array.isArray(pData.value)) ? pData.value : [];
        const idx = list.findIndex(p => p && (String(p.id) === String(c.id) || String(p.name) === String(c.name)));
        if (idx >= 0) {
          list[idx] = Object.assign({}, list[idx], c);
        } else {
          list.push(c);
        }
        await sb.from("settings").upsert({
          key: "parties_list",
          value: list,
          updated_at: new Date().toISOString()
        }, { onConflict: "key" });
      } catch (err) {
        console.warn("[Supabase] sync parties_list on upsertCustomer error:", err);
      }

      const row = {
        id: String(c.id),
        name: String(c.name || ""),
        phone: String(c.phone || ""),
        email: String(c.email || ""),
        address: String(c.address || ""),
        gstin: String(c.gstin || ""),
        balance: Number(c.balance || 0),
        is_deleted: Boolean(c.isDeleted || c._deleted),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await sb.from("customers").upsert(row, { onConflict: "id" });
      if (error) return { ok: false, error };
      return { ok: true, data };
    },

    async saveAllCustomers(customers) {
      const sb = initClient();
      if (!sb || !Array.isArray(customers) || customers.length === 0) return { ok: false };

      // Save rich party array to settings.parties_list
      try {
        await sb.from("settings").upsert({
          key: "parties_list",
          value: customers,
          updated_at: new Date().toISOString()
        }, { onConflict: "key" });
      } catch (err) {
        console.warn("[Supabase] settings parties_list save error:", err);
      }

      const rows = customers.map(c => ({
        id: String(c.id),
        name: String(c.name || ""),
        phone: String(c.phone || ""),
        email: String(c.email || ""),
        address: String(c.address || ""),
        gstin: String(c.gstin || ""),
        balance: Number(c.balance || 0),
        is_deleted: Boolean(c.isDeleted || c._deleted),
        updated_at: new Date().toISOString()
      }));
      const { error } = await sb.from("customers").upsert(rows, { onConflict: "id" });
      if (error) {
        console.error("[Supabase] saveAllCustomers error:", error);
        return { ok: false, error };
      }
      return { ok: true };
    },

    async fetchCustomers(options = {}) {
      if (isDemoActive()) {
        const snap = getDemoSnapshot();
        return { ok: true, customers: (snap && snap.parties) ? JSON.parse(JSON.stringify(snap.parties)) : [] };
      }
      if (!checkRateLimit()) return { ok: false, throttled: true };
      const sb = initClient();
      if (!sb) return { ok: false, error: "not_configured" };

      let deletedPartyIds = [];
      try {
        if (typeof localStorage !== "undefined") {
          deletedPartyIds = JSON.parse(localStorage.getItem("deleted_party_ids")) || [];
        }
      } catch(e){}

      // 1. First retrieve rich parties_list from settings table (contains type, state, etc.)
      try {
        const { data: pData } = await sb.from("settings").select("value").eq("key", "parties_list").maybeSingle();
        if (pData && Array.isArray(pData.value)) {
          const parties = pData.value.filter(p => {
            if (!p) return false;
            const pId = String(p.id || '').trim();
            const pName = String(p.name || '').trim();
            if (deletedPartyIds.includes(pId) || deletedPartyIds.includes(pName)) return false;
            return true;
          });
          return { ok: true, customers: parties };
        }
      } catch (e) {
        console.warn("[Supabase] parties_list fetch note:", e);
      }

      // 2. Fallback to customers table
      let query = sb
        .from("customers")
        .select("*")
        .eq("is_deleted", false)
        .order("name", { ascending: true });

      if (options.since) {
        query = query.gt("updated_at", options.since);
      }

      const { data, error } = await query;

      if (error) return { ok: false, error };

      const customers = (data || [])
        .filter(row => {
          if (!row) return false;
          const rId = String(row.id || '').trim();
          const rName = String(row.name || '').trim();
          if (deletedPartyIds.includes(rId) || deletedPartyIds.includes(rName)) return false;
          return true;
        })
        .map(row => this.rowToCustomer(row))
        .filter(Boolean);

      return { ok: true, customers };
    },

    async deleteCustomer(id, name = "") {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb || (!id && !name)) return { ok: false };
      const targetId = String(id || "").trim();
      const targetName = String(name || "").trim();
      try {
        let filter = targetId ? `id.eq.${targetId}` : '';
        if (targetName) {
          filter = filter ? `${filter},name.eq.${targetName}` : `name.eq.${targetName}`;
        }
        if (filter) {
          await sb.from("customers").update({ is_deleted: true, updated_at: new Date().toISOString() }).or(filter);
          await sb.from("customers").delete().or(filter);
        }

        // Also remove from settings.parties_list
        const { data: pData } = await sb.from("settings").select("value").eq("key", "parties_list").maybeSingle();
        if (pData && Array.isArray(pData.value)) {
          const filtered = pData.value.filter(p => {
            if (!p) return false;
            const pId = String(p.id || '').trim();
            const pName = String(p.name || '').trim();
            if (targetId && (pId === targetId || pName === targetId)) return false;
            if (targetName && (pId === targetName || pName === targetName)) return false;
            return true;
          });
          await sb.from("settings").upsert({
            key: "parties_list",
            value: filtered,
            updated_at: new Date().toISOString()
          }, { onConflict: "key" });
        }
        return { ok: true };
      } catch (err) {
        console.error("[Supabase] deleteCustomer error:", err);
        return { ok: false, error: err };
      }
    },

    // --- SETTINGS ---
    async saveSettings(settings) {
      if (isDemoActive()) return { ok: true, isDemo: true, blocked: true };
      const sb = initClient();
      if (!sb || !settings) return { ok: false };
      const { error } = await sb.from("settings").upsert({
        key: "global_settings",
        value: settings,
        updated_at: new Date().toISOString()
      }, { onConflict: "key" });
      if (error) {
        console.error("[Supabase] saveSettings error:", error);
        return { ok: false, error };
      }
      return { ok: true };
    },

    async fetchSettings() {
      const sb = initClient();
      if (!sb) {
        if (isDemoActive()) {
          const snap = getDemoSnapshot();
          return { ok: true, settings: (snap && snap.settings) ? JSON.parse(JSON.stringify(snap.settings)) : {} };
        }
        return { ok: false };
      }
      try {
        const { data, error } = await sb.from("settings").select("*").eq("key", "global_settings").maybeSingle();
        if (error) {
          console.error("[Supabase] fetchSettings error:", error);
          if (isDemoActive()) {
            const snap = getDemoSnapshot();
            return { ok: true, settings: (snap && snap.settings) ? JSON.parse(JSON.stringify(snap.settings)) : {} };
          }
          return { ok: false, error };
        }
        return { ok: true, settings: data?.value || null };
      } catch (err) {
        console.error("[Supabase] fetchSettings exception:", err);
        return { ok: false, error: err };
      }
    },

    // --- LOCKED INQUIRY EMAILS (Strict 1-Time Message Limit Per Email) ---
    async fetchLockedInquiryEmails() {
      const sb = initClient();
      if (!sb) return [];
      try {
        const { data, error } = await sb.from("settings").select("value").eq("key", "submitted_inquiry_emails").maybeSingle();
        if (data && Array.isArray(data.value)) {
          return data.value.map(e => String(e).trim().toLowerCase()).filter(Boolean);
        }
      } catch (e) {
        console.warn("[Supabase] fetchLockedInquiryEmails error:", e);
      }
      return [];
    },

    async recordLockedInquiryEmail(email) {
      const sb = initClient();
      if (!sb || !email) return { ok: false };
      const clean = String(email).trim().toLowerCase();
      try {
        const { data } = await sb.from("settings").select("value").eq("key", "submitted_inquiry_emails").maybeSingle();
        let list = (data && Array.isArray(data.value)) ? data.value.map(e => String(e).trim().toLowerCase()) : [];
        if (!list.includes(clean)) {
          list.push(clean);
          await sb.from("settings").upsert({
            key: "submitted_inquiry_emails",
            value: list,
            updated_at: new Date().toISOString()
          }, { onConflict: "key" });
        }
        return { ok: true, list };
      } catch (err) {
        console.warn("[Supabase] recordLockedInquiryEmail error:", err);
        return { ok: false, error: err };
      }
    },

    // --- REALTIME CHANGE STREAM (< 40ms Cross-Device Streaming Engine) ---
    onRealtimeEvent(callback) {
      if (typeof callback === 'function') {
        realtimeListeners.add(callback);
      }
      this.initRealtimeSubscription();
    },

    removeRealtimeListener(callback) {
      realtimeListeners.delete(callback);
    },

    initRealtimeSubscription() {
      if (isDemoActive()) return;
      const sb = initClient();
      if (!sb || typeof sb.channel !== 'function' || realtimeChannel) return;

      try {
        realtimeChannel = sb.channel('public_live_data_stream')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, (payload) => {
            this._broadcastRealtime({ table: 'invoices', eventType: payload.eventType, newRow: payload.new, oldRow: payload.old });
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, (payload) => {
            this._broadcastRealtime({ table: 'products', eventType: payload.eventType, newRow: payload.new, oldRow: payload.old });
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, (payload) => {
            this._broadcastRealtime({ table: 'customers', eventType: payload.eventType, newRow: payload.new, oldRow: payload.old });
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (payload) => {
            this._broadcastRealtime({ table: 'settings', eventType: payload.eventType, newRow: payload.new, oldRow: payload.old });
          })
          .subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
              console.log('⚡ [Supabase Realtime] Connected to low-latency PostgreSQL stream!');
              if (typeof window !== 'undefined' && typeof window.updateCloudSyncBadge === 'function') {
                window.updateCloudSyncBadge('live');
              }
            } else if (status === 'CHANNEL_ERROR') {
              console.warn('[Supabase Realtime] Channel warning:', err);
            }
          });
      } catch (err) {
        console.warn('[Supabase Realtime] Init note:', err);
      }
    },

    _broadcastRealtime(eventData) {
      realtimeListeners.forEach(listener => {
        try { listener(eventData); } catch (e) { console.warn("Realtime listener error:", e); }
      });
    }
  };

  if (typeof window !== "undefined") {
    window.SupabaseDB = SupabaseDB;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SupabaseDB;
  }
})();
