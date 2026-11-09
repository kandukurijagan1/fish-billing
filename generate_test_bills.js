/**
 * Bulk Bill Generator for Testing (Generates 150 Real-World Aquaculture Invoices)
 * Syncs directly to:
 * 1. Supabase PostgreSQL database
 * 2. Local initial_db.json / local caches
 *
 * Scenarios generated:
 * - Paid bills via UPI QR (with realistic timestamps & UTR references)
 * - Pending / Unpaid bills with balances due
 * - Partial bills with settlement logs
 * - Realistic fish & shrimp feed/medicine products across 12 farmers/customers
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://tfncblvaaemkbtvqnpdn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_D7LL7bdXwN1kEUeV3JEygQ_AdM_366s';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const CUSTOMERS = [
  { name: 'Kiran Aqua Farms', phone: '9848123456', address: 'Repalle, Bapatla Dist' },
  { name: 'Srinivasa Fish Hatchery', phone: '9440123789', address: 'Nizampatnam Road, Repalle' },
  { name: 'Raju Aqua Culture', phone: '9849234567', address: 'Bhattiprolu Mandal' },
  { name: 'Venkat Shrimp Culture', phone: '9989345678', address: 'Penumudi, Guntur' },
  { name: 'Lakshmi Bio Aqua', phone: '9121456789', address: 'Karlapalem, Bapatla' },
  { name: 'Murthy Broodstock Farms', phone: '9391567890', address: 'Avanigadda Road' },
  { name: 'Bhavani Aqua Needs', phone: '9701678901', address: 'Machilipatnam Coastal' },
  { name: 'Prasad Prawn Cultivators', phone: '9866789012', address: 'Kavali Coastal Belt' },
  { name: 'Naveen Aqua Care', phone: '9949890123', address: 'Chirala Beach Road' },
  { name: 'Anjaneya Fish Ponds', phone: '9490901234', address: 'Duggirala Canal Road' },
  { name: 'Sri Rama Fisheries', phone: '9848012345', address: 'Nagayalanka Island' },
  { name: 'Surya Aqua Agency', phone: '9959123450', address: 'Ongole Highway' }
];

const PRODUCTS = [
  { name: 'Vannamei Shrimp Feed 25KG', hsn: '230990', unit: 'Bag', rate: 1650 },
  { name: 'NutriPro Water Probiotic 1L', hsn: '300290', unit: 'Bottle', rate: 850 },
  { name: 'Super Gas Oxygen Tablets 5KG', hsn: '283699', unit: 'Can', rate: 1200 },
  { name: 'Soil Rich Pond Conditioner 20KG', hsn: '310590', unit: 'Bucket', rate: 2100 },
  { name: 'Aqua Clean Zeolite Powder 50KG', hsn: '253090', unit: 'Bag', rate: 750 },
  { name: 'GrowFast Vitamin Premix 10KG', hsn: '293690', unit: 'Box', rate: 1850 },
  { name: 'BioShield Anti-Bacterial 5L', hsn: '380899', unit: 'Can', rate: 3200 },
  { name: 'Mineral Pro Pond Salt 50KG', hsn: '250100', unit: 'Bag', rate: 600 }
];

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateBills(count = 150) {
  const bills = [];
  const now = new Date();

  for (let i = 1; i <= count; i++) {
    const cust = CUSTOMERS[i % CUSTOMERS.length];
    const invNo = String(1000 + i);
    const daysAgo = getRandomInt(0, 45);
    const billDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000 - getRandomInt(10, 500) * 60 * 1000);
    const billIso = billDate.toISOString();

    // Pick 1 to 4 random products
    const itemsCount = getRandomInt(1, 4);
    const items = [];
    let subtotal = 0;

    for (let j = 0; j < itemsCount; j++) {
      const p = PRODUCTS[getRandomInt(0, PRODUCTS.length - 1)];
      const qty = getRandomInt(1, 10);
      const total = qty * p.rate;
      subtotal += total;
      items.push({
        id: `item_${i}_${j}`,
        name: p.name,
        description: p.name,
        hsn: p.hsn,
        unit: p.unit,
        quantity: qty,
        rate: p.rate,
        price: p.rate,
        total: total
      });
    }

    const grandTotal = subtotal;
    const scenario = i % 3; // 0: Fully Paid, 1: Partial with settlement, 2: Unpaid/Pending
    let paidAmt = 0;
    let balanceDue = grandTotal;
    let status = 'UNPAID';
    let mode = 'Pending';
    const paymentHistory = [];

    if (scenario === 0) {
      // 100% PAID upfront or via UPI QR
      paidAmt = grandTotal;
      balanceDue = 0;
      status = 'PAID';
      mode = i % 2 === 0 ? 'UPI / QR' : 'Cash';
      paymentHistory.push({
        date: billIso,
        amount: grandTotal,
        mode: mode,
        reference: mode === 'UPI / QR' ? `UPI/${getRandomInt(100000000000, 999999999999)}` : 'Cash payment',
        status: 'PAID',
        note: 'Settled at time of invoice'
      });
    } else if (scenario === 1) {
      // PARTIAL settlement with follow-up payment
      const upfront = Math.round(grandTotal * 0.4);
      const settledLater = Math.round(grandTotal * 0.4);
      paidAmt = upfront + settledLater;
      balanceDue = grandTotal - paidAmt;
      status = balanceDue <= 0 ? 'PAID' : 'PARTIAL';
      mode = 'UPI / QR';

      paymentHistory.push({
        date: billIso,
        amount: upfront,
        mode: 'Cash',
        reference: 'Advance at pickup',
        status: 'PARTIAL',
        note: 'Advance deposit'
      });

      const settlementDate = new Date(billDate.getTime() + getRandomInt(1, 4) * 24 * 60 * 60 * 1000).toISOString();
      paymentHistory.push({
        date: settlementDate,
        amount: settledLater,
        mode: 'UPI / QR',
        reference: `UPI/${getRandomInt(100000000000, 999999999999)}`,
        status: status,
        note: 'Balance QR partial settlement'
      });
    } else {
      // UNPAID / FULL BALANCE DUE
      paidAmt = 0;
      balanceDue = grandTotal;
      status = 'UNPAID';
      mode = 'Credit';
    }

    const rawData = {
      id: `inv_${invNo}`,
      invoiceNo: invNo,
      date: billIso,
      invoiceDate: billIso,
      customerName: cust.name,
      customerPhone: cust.phone,
      buyerName: cust.name,
      buyer: {
        name: cust.name,
        phone: cust.phone,
        address: cust.address,
        gstin: '37AAAAA' + getRandomInt(1000, 9999) + 'Z1'
      },
      items: items,
      subtotal: subtotal,
      total: grandTotal,
      grandTotal: grandTotal,
      paidAmount: paidAmt,
      balanceDue: balanceDue,
      paymentStatus: status,
      paymentMode: mode,
      paymentHistory: paymentHistory
    };

    bills.push({
      id: `inv_${invNo}`,
      invoice_no: invNo,
      date: billIso,
      customer_name: cust.name,
      phone: cust.phone,
      items: items,
      subtotal: subtotal,
      grand_total: grandTotal,
      paid_amount: paidAmt,
      balance_due: balanceDue,
      payment_status: status,
      payment_mode: mode,
      raw_data: rawData
    });
  }

  return bills;
}

async function run() {
  const count = 150;
  console.log(`\n======================================================`);
  console.log(`📦 GENERATING ${count} REALISTIC TEST BILLS`);
  console.log(`======================================================\n`);

  const bills = generateBills(count);

  console.log(`⚡ Inserting ${bills.length} bills into Supabase PostgreSQL in batches...`);
  const batchSize = 50;
  for (let i = 0; i < bills.length; i += batchSize) {
    const batch = bills.slice(i, i + batchSize);
    const { error } = await sb.from('invoices').upsert(batch, { onConflict: 'id' });
    if (error) {
      console.error(`❌ Batch ${i / batchSize + 1} error:`, error);
    } else {
      console.log(`✅ Batch ${i / batchSize + 1} (${batch.length} bills) synced to Supabase.`);
    }
  }

  // Also update local initial_db.json
  const initialDbPath = path.join(__dirname, 'initial_db.json');
  try {
    let currentDb = {};
    if (fs.existsSync(initialDbPath)) {
      currentDb = JSON.parse(fs.readFileSync(initialDbPath, 'utf8'));
    }
    currentDb.invoices = bills.map(b => b.raw_data);
    fs.writeFileSync(initialDbPath, JSON.stringify(currentDb, null, 2), 'utf8');
    console.log(`✅ Updated initial_db.json with ${bills.length} test invoices.`);
  } catch (err) {
    console.warn('⚠️ Could not update initial_db.json:', err.message);
  }

  console.log(`\n======================================================`);
  console.log(`🎉 SUCCESS! 150 bills generated across 12 customers.`);
  console.log(`📊 Check your Supabase database or open the app to see:`);
  console.log(`   - Live invoices in History table (#1001 to #1150)`);
  console.log(`   - Paid, Partial, and Pending dues`);
  console.log(`   - 360° Customer Profiles with complete purchase and payment logs`);
  console.log(`======================================================\n`);
}

run().catch(e => console.error(e));

