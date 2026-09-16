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
    const { fillGaps = true, preferInvoiceNo = null } = (typeof options === 'object' && options !== null) ? options : {};
    
    const parsedNums = [];
    const numSet = new Set();
    let detectedPrefix = '';
    let maxPadding = 4;

    (existingInvoices || []).forEach((inv) => {
      const rawStr = String(inv?.invoiceNo || (inv?.details && inv?.details.invoiceNo) || '').trim();
      if (!rawStr) return;
      
      const match = rawStr.match(/^(.*?)(\d+)$/);
      if (match) {
        const prefix = match[1];
        const num = parseInt(match[2], 10);
        const padLen = match[2].length;
        if (!Number.isNaN(num) && num > 0) {
          parsedNums.push(num);
          numSet.add(num);
          if (prefix && !detectedPrefix) detectedPrefix = prefix;
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
          const prefPad = Math.max(prefMatch[2].length, maxPadding);
          return prefPrefix + prefNum.toString().padStart(prefPad, '0');
        }
      }
    }

    if (parsedNums.length === 0) {
      return detectedPrefix + (1).toString().padStart(maxPadding, '0');
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

    return detectedPrefix + nextNum.toString().padStart(maxPadding, '0');
  }

  global.InvoiceUtils = {
    roundToTwo,
    calculateInvoiceBreakdown,
    calculatePaymentSummary,
    getInvoicePaidAndBalance,
    getNextInvoiceNumber
  };
})(typeof window !== 'undefined' ? window : globalThis);
