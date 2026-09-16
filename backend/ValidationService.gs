/**
 * ============================================================================
 * ValidationService.gs - Strict Server-Side Validation & Financial Calculations
 * ============================================================================
 */

function roundToTwo(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function validateAndComputeInvoice(invoiceData, existingInvoices) {
  if (!invoiceData || typeof invoiceData !== 'object') {
    return { valid: false, error: "Invalid invoice payload: Object required" };
  }

  var d = (invoiceData.details && typeof invoiceData.details === 'object') ? invoiceData.details : invoiceData;

  // 1. Validate Customer Information
  var buyer = invoiceData.buyer || d.buyer || {};
  var customerName = String(buyer.name || invoiceData.customerName || d.customerName || "").trim();
  if (!customerName) {
    return { valid: false, error: "Validation failed: Customer/Party name is required" };
  }

  // 2. Validate Items Array
  var items = invoiceData.items || d.items || [];
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, error: "Validation failed: Invoice must contain at least one line item" };
  }

  var sellerStateCode = String(invoiceData.supplyStateCode || "37").trim();
  var buyerStateCode = String((buyer && buyer.stateCode) || invoiceData.buyerStateCode || "37").trim();
  var isLocal = sellerStateCode === buyerStateCode;

  var computedItems = [];
  var taxableSubtotal = 0;
  var totalCgst = 0;
  var totalSgst = 0;
  var totalIgst = 0;

  for (var i = 0; i < items.length; i++) {
    var itm = items[i];
    if (!itm || typeof itm !== 'object') {
      return { valid: false, error: "Validation failed: Line item #" + (i + 1) + " is invalid" };
    }

    var desc = String(itm.description || itm.name || "").trim();
    if (!desc) {
      return { valid: false, error: "Validation failed: Line item #" + (i + 1) + " must have a description or product name" };
    }

    var qty = Number(itm.quantity !== undefined ? itm.quantity : (itm.qty !== undefined ? itm.qty : 0));
    if (isNaN(qty) || qty <= 0) {
      return { valid: false, error: "Validation failed: Quantity for '" + desc + "' must be a positive number greater than zero" };
    }

    var rate = Number(itm.rate !== undefined ? itm.rate : (itm.price !== undefined ? itm.price : 0));
    if (isNaN(rate) || rate < 0) {
      return { valid: false, error: "Validation failed: Rate/Price for '" + desc + "' cannot be negative" };
    }

    var discount = Number(itm.discount || 0);
    if (isNaN(discount) || discount < 0 || discount > 100) {
      return { valid: false, error: "Validation failed: Discount for '" + desc + "' must be between 0% and 100%" };
    }

    var taxRate = Number(itm.taxRate !== undefined ? itm.taxRate : (itm.gst !== undefined ? itm.gst : 0));
    if (isNaN(taxRate) || taxRate < 0 || taxRate > 100) {
      return { valid: false, error: "Validation failed: Tax/GST rate for '" + desc + "' must be between 0% and 100%" };
    }

    // Line item financial calculation
    var lineGross = roundToTwo(qty * rate);
    var lineDiscountAmt = roundToTwo(lineGross * (discount / 100));
    var lineTaxable = roundToTwo(lineGross - lineDiscountAmt);
    taxableSubtotal += lineTaxable;

    // GST calculation
    var lineGstAmt = roundToTwo(lineTaxable * (taxRate / 100));
    var lineCgst = 0;
    var lineSgst = 0;
    var lineIgst = 0;

    if (isLocal) {
      lineCgst = roundToTwo(lineGstAmt / 2);
      lineSgst = roundToTwo(lineGstAmt - lineCgst);
      totalCgst += lineCgst;
      totalSgst += lineSgst;
    } else {
      lineIgst = lineGstAmt;
      totalIgst += lineIgst;
    }

    var lineTotal = roundToTwo(lineTaxable + lineGstAmt);

    computedItems.push({
      id: itm.id || ("item_" + (i + 1)),
      productId: itm.productId || itm.id || "",
      description: desc,
      hsn: String(itm.hsn || ""),
      quantity: qty,
      unit: String(itm.unit || "NOS"),
      rate: rate,
      discount: discount,
      taxRate: taxRate,
      amount: lineTaxable,
      cgst: lineCgst,
      sgst: lineSgst,
      igst: lineIgst,
      total: lineTotal
    });
  }

  taxableSubtotal = roundToTwo(taxableSubtotal);
  totalCgst = roundToTwo(totalCgst);
  totalSgst = roundToTwo(totalSgst);
  totalIgst = roundToTwo(totalIgst);

  var totalTax = roundToTwo(totalCgst + totalSgst + totalIgst);
  var rawTotal = roundToTwo(taxableSubtotal + totalTax);
  var grandTotal = Math.round(rawTotal);
  var roundOff = roundToTwo(grandTotal - rawTotal);

  // 3. Validate Payments
  var paymentStatus = String(invoiceData.paymentStatus || (invoiceData.details && invoiceData.details.paymentStatus) || "Paid").trim();
  var inputPaid = Number(invoiceData.paidAmount !== undefined ? invoiceData.paidAmount : (invoiceData.details && invoiceData.details.paidAmount !== undefined ? invoiceData.details.paidAmount : (paymentStatus === 'Paid' ? grandTotal : 0)));
  
  if (isNaN(inputPaid) || inputPaid < 0) {
    return { valid: false, error: "Validation failed: Paid amount cannot be negative" };
  }

  var paidAmount = roundToTwo(inputPaid);
  if (paymentStatus === "Paid") {
    paidAmount = grandTotal;
  }
  var balanceDue = roundToTwo(Math.max(0, grandTotal - paidAmount));

  // 4. Validate Invoice Number Uniqueness
  var invNo = String(invoiceData.invoiceNo || (invoiceData.details && invoiceData.details.invoiceNo) || "").trim();
  var invId = String(invoiceData.id || "").trim();

  if (existingInvoices && Array.isArray(existingInvoices) && invNo) {
    for (var k = 0; k < existingInvoices.length; k++) {
      var existing = existingInvoices[k];
      var existingNo = String(existing.invoiceNo || (existing.details && existing.details.invoiceNo) || "").trim();
      var existingId = String(existing.id || "").trim();

      // If matching invoiceNo but different ID -> Duplicate invoice number!
      if (existingNo === invNo && existingId && invId && existingId !== invId) {
        return { 
          valid: false, 
          error: "Validation failed: Invoice #" + invNo + " already exists. Duplicate invoice numbers are strictly rejected." 
        };
      }
    }
  }

  return {
    valid: true,
    computed: {
      invoiceNo: invNo,
      id: invId || ("inv_" + Date.now()),
      invoiceDate: invoiceData.invoiceDate || Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Kolkata", "yyyy-MM-dd"),
      customerName: customerName,
      taxableSubtotal: taxableSubtotal,
      cgst: totalCgst,
      sgst: totalSgst,
      igst: totalIgst,
      totalTax: totalTax,
      roundOff: roundOff,
      total: grandTotal,
      paidAmount: paidAmount,
      balanceDue: balanceDue,
      paymentStatus: balanceDue <= 0 ? "Paid" : (paidAmount > 0 ? "Partial" : "Unpaid"),
      items: computedItems
    }
  };
}
