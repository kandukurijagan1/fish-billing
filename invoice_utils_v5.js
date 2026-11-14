(function (global) {
  function roundToTwo(num) {
    return Math.round((Number(num) || 0) * 100) / 100;
  }

  function calculateInvoiceBreakdown(items = [], sellerStateCode = '37', buyerStateCode = '37') {
    const isLocal = String(sellerStateCode) === String(buyerStateCode);
    let taxableVal = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;

    (items || []).forEach((item) => {
      const qty = parseFloat(item.quantity !== undefined ? item.quantity : item.qty) || 0;
      const rate = parseFloat(item.rate !== undefined ? item.rate : item.price) || 0;
      const discount = parseFloat(item.discount) || 0;
      const taxRate = parseFloat(item.taxRate !== undefined ? item.taxRate : (item.gstRate !== undefined ? item.gstRate : (item.gst !== undefined ? item.gst : 0))) || 0;

      let lineAmount = parseFloat(item.amount);
      if (isNaN(lineAmount) || lineAmount <= 0) {
        const lineGross = roundToTwo(qty * rate);
        const discAmt = roundToTwo(lineGross * (discount / 100));
        lineAmount = roundToTwo(lineGross - discAmt);
      }
      taxableVal += lineAmount;

      if (taxRate > 0) {
        const gstAmt = roundToTwo(lineAmount * (taxRate / 100));
        if (isLocal) {
          const cgst = roundToTwo(gstAmt / 2);
          const sgst = roundToTwo(gstAmt - cgst);
          totalCgst += cgst;
          totalSgst += sgst;
        } else {
          totalIgst += gstAmt;
        }
      }
    });

    taxableVal = roundToTwo(taxableVal);
    totalCgst = roundToTwo(totalCgst);
    totalSgst = roundToTwo(totalSgst);
    totalIgst = roundToTwo(totalIgst);

    const totalTax = roundToTwo(totalCgst + totalSgst + totalIgst);
    const rawGrandTotal = roundToTwo(taxableVal + totalTax);
    const roundedGrandTotal = Math.round(rawGrandTotal);

    return {
      taxableVal,
      totalCgst,
      totalSgst,
      totalIgst,
      totalTax,
      rawGrandTotal,
      roundedGrandTotal,
      roundOff: roundToTwo(roundedGrandTotal - rawGrandTotal),
      isLocal
    };
  }

  function calculatePaymentSummary(grandTotal, paymentStatus, paidAmount, balancePaid) {
    let resolvedPaidAmount = 0;
    let resolvedBalancePaid = 0;

    if (paymentStatus === 'Paid') {
      resolvedPaidAmount = grandTotal;
    } else if (paymentStatus === 'Partial') {
      resolvedPaidAmount = parseFloat(paidAmount) || 0;
      resolvedBalancePaid = parseFloat(balancePaid) || 0;
    }

    const totalPaidSum = resolvedPaidAmount + resolvedBalancePaid;

    return {
      paidAmount: resolvedPaidAmount,
      balancePaid: resolvedBalancePaid,
      balanceDue: Math.max(0, roundToTwo(grandTotal - totalPaidSum))
    };
  }

  function getInvoicePaidAndBalance(inv) {
    if (!inv) return { status: 'Paid', isPaid: true, paid: 0, balance: 0, total: 0 };
    const details = inv.details || {};
    const total = parseFloat(inv.total !== undefined ? inv.total : (details.total || 0)) || 0;
    const status = String(details.paymentStatus || inv.paymentStatus || 'Paid').trim();
    const isPaid = status.toLowerCase() === 'paid';
    const isUnpaid = status.toLowerCase() === 'unpaid';

    if (isPaid) {
      return {
        status: 'Paid',
        isPaid: true,
        paid: total,
        balance: 0,
        total
      };
    }

    if (isUnpaid) {
      return {
        status: 'Unpaid',
        isPaid: false,
        paid: 0,
        balance: total,
        total
      };
    }

    // Partial or other status
    let balance = 0;
    let paid = 0;
    if (details.balanceDue !== undefined && !isNaN(parseFloat(details.balanceDue))) {
      balance = Math.max(0, parseFloat(details.balanceDue));
      paid = Math.max(0, roundToTwo(total - balance));
    } else if (inv.balanceDue !== undefined && !isNaN(parseFloat(inv.balanceDue))) {
      balance = Math.max(0, parseFloat(inv.balanceDue));
      paid = Math.max(0, roundToTwo(total - balance));
    } else if (details.paidAmount !== undefined && !isNaN(parseFloat(details.paidAmount))) {
      paid = Math.max(0, parseFloat(details.paidAmount));
      balance = Math.max(0, roundToTwo(total - paid));
    } else if (inv.paidAmount !== undefined && !isNaN(parseFloat(inv.paidAmount))) {
      paid = Math.max(0, parseFloat(inv.paidAmount));
      balance = Math.max(0, roundToTwo(total - paid));
    } else {
      balance = total;
      paid = 0;
    }

    if (balance <= 0) {
      return {
        status: 'Paid',
        isPaid: true,
        paid: total,
        balance: 0,
        total
      };
    }

    return {
      status,
      isPaid: false,
      paid,
      balance,
      total
    };
  }

  function getNextInvoiceNumber(existingInvoices = [], options = {}) {
    const { fillGaps = true, preferInvoiceNo = null, allowDemo = false } = (typeof options === 'object' && options !== null) ? options : {};
    
    const parsedNums = [];
    const numSet = new Set();
    let detectedPrefix = '';
    let maxPadding = 4;

    (existingInvoices || []).forEach((inv) => {
      const rawStr = String(inv?.invoiceNo || (inv?.details && inv?.details.invoiceNo) || '').trim();
      if (!rawStr) return;
      
      // If we are in real-world / production mode, strictly filter out demo records
      const isDemo = /^(DEMO|SAMPLE|TEST)[-_]?/i.test(rawStr) || 
                     String(inv?.id || '').toLowerCase().startsWith('demo_') ||
                     inv?.isDemo === true;
      if (isDemo && !allowDemo) {
        return;
      }

      const match = rawStr.match(/^(.*?)(\d+)$/);
      if (match) {
        const prefix = match[1];
        const num = parseInt(match[2], 10);
        const padLen = match[2].length;
        if (!Number.isNaN(num) && num > 0) {
          parsedNums.push(num);
          numSet.add(num);
          if (prefix && !detectedPrefix && !/^(DEMO|SAMPLE|TEST)[-_]?/i.test(prefix)) {
            detectedPrefix = prefix;
          }
          if (padLen > maxPadding) maxPadding = padLen;
        }
      } else {
        const num = parseInt(rawStr, 10);
        if (!Number.isNaN(num) && num > 0) {
          parsedNums.push(num);
          numSet.add(num);
        }
      }
    });

    // If a preferred invoice number was suggested (e.g. specifically deleted invoice number)
    // and that number is now free, directly prioritize it!
    if (preferInvoiceNo) {
      const prefMatch = String(preferInvoiceNo).trim().match(/^(.*?)(\d+)$/);
      if (prefMatch) {
        const prefNum = parseInt(prefMatch[2], 10);
        if (!Number.isNaN(prefNum) && !numSet.has(prefNum)) {
          const prefPrefix = prefMatch[1] || detectedPrefix;
          const cleanPrefPrefix = /^(DEMO|SAMPLE|TEST)[-_]?/i.test(prefPrefix) ? '' : prefPrefix;
          const prefPad = Math.max(prefMatch[2].length, maxPadding);
          return cleanPrefPrefix + prefNum.toString().padStart(prefPad, '0');
        }
      }
    }

    if (parsedNums.length === 0) {
      const cleanPrefix = /^(DEMO|SAMPLE|TEST)[-_]?/i.test(detectedPrefix) ? '' : detectedPrefix;
      return cleanPrefix + (1).toString().padStart(maxPadding, '0');
    }

    const sortedNums = Array.from(numSet).sort((a, b) => a - b);
    const minNum = sortedNums[0];
    const maxNum = sortedNums[sortedNums.length - 1];

    const startNum = (minNum > 50) ? minNum : 1;
    let nextNum = null;

    if (fillGaps) {
      for (let i = startNum; i <= maxNum; i++) {
        if (!numSet.has(i)) {
          nextNum = i;
          break;
        }
      }
    }

    if (nextNum === null) {
      nextNum = maxNum + 1;
    }

    const cleanPrefix = /^(DEMO|SAMPLE|TEST)[-_]?/i.test(detectedPrefix) ? '' : detectedPrefix;
    return cleanPrefix + nextNum.toString().padStart(maxPadding, '0');
  }

  function mergeInvoicesNonDestructively(existingList, incomingList) {
    const existing = Array.isArray(existingList) ? existingList : [];
    const incoming = Array.isArray(incomingList) ? incomingList : [];
    if (incoming.length === 0) return existing.slice();
    if (existing.length === 0) return incoming.slice();

    const map = new Map();
    existing.forEach(inv => {
      if (!inv) return;
      const rawNo = String(inv.invoiceNo || (inv.details && inv.details.invoiceNo) || inv.id || '').trim();
      const normNo = rawNo.replace(/^#/, '').trim().toLowerCase();
      const key = normNo || rawNo;
      if (key) map.set(key, JSON.parse(JSON.stringify(inv)));
    });

    incoming.forEach(newInv => {
      if (!newInv) return;
      const rawNo = String(newInv.invoiceNo || (newInv.details && newInv.details.invoiceNo) || newInv.id || '').trim();
      const normNo = rawNo.replace(/^#/, '').trim().toLowerCase();
      const key = normNo || rawNo;
      if (!key) return;

      if (!map.has(key)) {
        map.set(key, JSON.parse(JSON.stringify(newInv)));
      } else {
        const oldInv = map.get(key);
        const oldItems = Array.isArray(oldInv.items) ? oldInv.items.length : (Array.isArray(oldInv.details?.items) ? oldInv.details.items.length : (oldInv.itemsCount || 0));
        const newItems = Array.isArray(newInv.items) ? newInv.items.length : (Array.isArray(newInv.details?.items) ? newInv.details.items.length : (newInv.itemsCount || 0));
        const oldTotal = Number(oldInv.total || oldInv.grandTotal || oldInv.details?.total || 0);
        const newTotal = Number(newInv.total || newInv.grandTotal || newInv.details?.total || 0);

        if (newItems > oldItems || (newItems === oldItems && newTotal > oldTotal)) {
          const merged = Object.assign({}, oldInv, newInv);
          merged.items = (newInv.items && newInv.items.length > 0) ? newInv.items : oldInv.items;
          merged.details = Object.assign({}, oldInv.details || {}, newInv.details || {});
          if (newInv.details?.items && newInv.details.items.length > 0) {
            merged.details.items = newInv.details.items;
          } else if (oldInv.details?.items && oldInv.details.items.length > 0) {
            merged.details.items = oldInv.details.items;
          }
          map.set(key, merged);
        } else {
          const merged = Object.assign({}, newInv, oldInv);
          if (newInv.paymentStatus && newInv.paymentStatus !== 'Unpaid') {
            merged.paymentStatus = newInv.paymentStatus;
            if (merged.details) merged.details.paymentStatus = newInv.paymentStatus;
          }
          if (newInv.paidAmount !== undefined && Number(newInv.paidAmount) > Number(oldInv.paidAmount || 0)) {
            merged.paidAmount = newInv.paidAmount;
            merged.balanceDue = newInv.balanceDue;
            if (merged.details) {
              merged.details.paidAmount = newInv.paidAmount;
              merged.details.balanceDue = newInv.balanceDue;
            }
          }
          map.set(key, merged);
        }
      }
    });

    return Array.from(map.values());
  }

  function mergeProductsNonDestructively(existingList, incomingList) {
    const existing = Array.isArray(existingList) ? existingList : [];
    const incoming = Array.isArray(incomingList) ? incomingList : [];
    if (incoming.length === 0) return existing.slice();
    if (existing.length === 0) return incoming.slice();

    const map = new Map();
    const getKey = p => {
      if (!p) return '';
      const desc = String(p.description || p.name || '').trim().toLowerCase();
      const barcode = String(p.barcode || '').trim().toLowerCase();
      const id = String(p.id || '').trim().toLowerCase();
      return desc || barcode || id;
    };

    existing.forEach(p => {
      const k = getKey(p);
      if (k) map.set(k, JSON.parse(JSON.stringify(p)));
    });

    incoming.forEach(p => {
      const k = getKey(p);
      if (!k) return;
      if (!map.has(k)) {
        map.set(k, JSON.parse(JSON.stringify(p)));
      } else {
        const oldProd = map.get(k);
        const merged = Object.assign({}, oldProd, p);
        if ((p.stock === 0 || p.stock === undefined || p.stock === null) && oldProd.stock > 0) {
          merged.stock = oldProd.stock;
          merged.totalValue = oldProd.totalValue;
          merged.status = oldProd.status;
        }
        map.set(k, merged);
      }
    });

    return Array.from(map.values());
  }

  function mergePartiesNonDestructively(existingList, incomingList) {
    const existing = Array.isArray(existingList) ? existingList : [];
    const incoming = Array.isArray(incomingList) ? incomingList : [];
    if (incoming.length === 0) return existing.slice();
    if (existing.length === 0) return incoming.slice();

    const map = new Map();
    const getKey = p => {
      if (!p) return '';
      const name = String(p.name || p.company || '').trim().toLowerCase();
      const phone = String(p.phone || '').trim().replace(/[^0-9]/g, '');
      const id = String(p.id || '').trim().toLowerCase();
      return name || phone || id;
    };

    existing.forEach(p => {
      const k = getKey(p);
      if (k) map.set(k, JSON.parse(JSON.stringify(p)));
    });

    incoming.forEach(p => {
      const k = getKey(p);
      if (!k) return;
      if (!map.has(k)) {
        map.set(k, JSON.parse(JSON.stringify(p)));
      } else {
        const oldParty = map.get(k);
        const merged = Object.assign({}, oldParty);
        if (p.phone && !oldParty.phone) merged.phone = p.phone;
        if (p.gstin && !oldParty.gstin) merged.gstin = p.gstin;
        if (p.address && !oldParty.address) merged.address = p.address;
        if (p.email) merged.email = p.email;
        if (p.state && !oldParty.state) merged.state = p.state;
        if (p.stateCode && !oldParty.stateCode) merged.stateCode = p.stateCode;
        if (p.city && !oldParty.city) merged.city = p.city;
        map.set(k, merged);
      }
    });

    return Array.from(map.values());
  }

  global.InvoiceUtils = {
    roundToTwo,
    calculateInvoiceBreakdown,
    calculatePaymentSummary,
    getInvoicePaidAndBalance,
    getNextInvoiceNumber,
    mergeInvoicesNonDestructively,
    mergeProductsNonDestructively,
    mergePartiesNonDestructively
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.InvoiceUtils;
  }
})(typeof window !== 'undefined' ? window : globalThis);
