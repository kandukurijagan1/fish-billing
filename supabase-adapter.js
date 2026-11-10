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

  function isDemoActive() {
    if (typeof window === 'undefined') return false;
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
    if (typeof window !== "undefined") {
      if (typeof window.createClient === "function" && SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey) {
        client = window.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
      } else if (typeof window.supabase !== "undefined" && typeof window.supabase.createClient === "function" && SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey) {
        client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
      }
    }
    if (!client && typeof require === "function") {
      try {
        const { createClient } = require("@supabase/supabase-js");
        client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
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
      const sb = initClient();
      if (!sb || !inv || !inv.id) return { ok: false, error: "not_configured" };

      const row = {
        id: String(inv.id),
        invoice_no: String(inv.invoiceNo || inv.invoice_no || inv.id),
        date: String(inv.date || inv.invoiceDate || ""),
        customer_name: String(inv.customerName || inv.customer_name || ""),
        phone: String(inv.customerPhone || inv.phone || ""),
        items: Array.isArray(inv.items) ? inv.items : [],
        subtotal: Number(inv.subtotal || inv.subTotal || 0),
        tax: Number(inv.tax || 0),
        cgst: Number(inv.cgst || 0),
        sgst: Number(inv.sgst || 0),
        igst: Number(inv.igst || 0),
        discount: Number(inv.discount || 0),
        round_off: Number(inv.roundOff || inv.round_off || 0),
        grand_total: Number(inv.grandTotal || inv.grand_total || inv.total || 0),
        paid_amount: Number(inv.paidAmount || inv.paid_amount || 0),
        balance_due: Number(inv.balanceDue || inv.balance_due || 0),
        payment_status: String(inv.paymentStatus || inv.status || "PAID"),
        payment_mode: String(inv.paymentMode || "UPI / QR"),
        vehicle_no: String(inv.vehicleNo || ""),
        transport_name: String(inv.transportName || ""),
        destination: String(inv.destination || ""),
        raw_data: inv,
        is_deleted: Boolean(inv.isDeleted || inv._deleted),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await sb.from("invoices").upsert(row, { onConflict: "id" });
      if (error) {
        console.error("[Supabase] Upsert invoice failed:", error);
        return { ok: false, error };
      }
      return { ok: true, data };
    },

    async fetchInvoices() {
      if (isDemoActive()) {
        const snap = getDemoSnapshot();
        return { ok: true, invoices: (snap && snap.invoices) ? JSON.parse(JSON.stringify(snap.invoices)) : [] };
      }
      const sb = initClient();
      if (!sb) return { ok: false, error: "not_configured" };

      const { data, error } = await sb
        .from("invoices")
        .select("*")
        .eq("is_deleted", false)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("[Supabase] Fetch invoices failed:", error);
        return { ok: false, error };
      }

      const invoices = (data || []).map((row) => {
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
      });

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

    async fetchProducts() {
      if (isDemoActive()) {
        const snap = getDemoSnapshot();
        return { ok: true, products: (snap && snap.products) ? JSON.parse(JSON.stringify(snap.products)) : [] };
      }
      const sb = initClient();
      if (!sb) return { ok: false, error: "not_configured" };

      const { data, error } = await sb
        .from("products")
        .select("*")
        .eq("is_deleted", false)
        .order("description", { ascending: true });

      if (error) return { ok: false, error };

      const products = (data || []).map((row) => ({
        id: row.id,
        description: row.description,
        hsn: row.hsn,
        packSize: row.pack_size,
        unit: row.unit,
        rate: Number(row.rate),
        discount: Number(row.discount),
        price: Number(row.price),
        stock: Number(row.stock),
        totalValue: Number(row.total_value),
        status: row.status
      }));

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

    async fetchCustomers() {
      if (isDemoActive()) {
        const snap = getDemoSnapshot();
        return { ok: true, customers: (snap && snap.parties) ? JSON.parse(JSON.stringify(snap.parties)) : [] };
      }
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
      const { data, error } = await sb
        .from("customers")
        .select("*")
        .eq("is_deleted", false)
        .order("name", { ascending: true });

      if (error) return { ok: false, error };

      const customers = (data || [])
        .filter(row => {
          if (!row) return false;
          const rId = String(row.id || '').trim();
          const rName = String(row.name || '').trim();
          if (deletedPartyIds.includes(rId) || deletedPartyIds.includes(rName)) return false;
          return true;
        })
        .map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type || "receiver",
          phone: row.phone || "",
          email: row.email || "",
          address: row.address || "",
          gstin: row.gstin || "",
          balance: Number(row.balance || 0),
          state: row.state || "Andhra Pradesh",
          stateCode: row.state_code || row.stateCode || "37",
          company: row.company || row.name || ""
        }));

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
      if (isDemoActive()) {
        const snap = getDemoSnapshot();
        return { ok: true, settings: (snap && snap.settings) ? JSON.parse(JSON.stringify(snap.settings)) : {} };
      }
      const sb = initClient();
      if (!sb) return { ok: false };
      const { data, error } = await sb.from("settings").select("*").eq("key", "global_settings").maybeSingle();
      if (error) {
        console.error("[Supabase] fetchSettings error:", error);
        return { ok: false, error };
      }
      return { ok: true, settings: data?.value || null };
    }
  };

  if (typeof window !== "undefined") {
    window.SupabaseDB = SupabaseDB;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SupabaseDB;
  }
})();
