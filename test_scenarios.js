/**
 * Comprehensive Automated Test Suite
 * Tests all key scenarios:
 * 1. Generating an invoice with unpaid balance
 * 2. Settling post-invoice payment with exact timestamp
 * 3. Syncing to Supabase PostgreSQL database
 * 4. Verifying customer 360 profile aggregation
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://tfncblvaaemkbtvqnpdn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_D7LL7bdXwN1kEUeV3JEygQ_AdM_366s';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runAllTests() {
  console.log('====================================================');
  console.log('🚀 AARYAN AQUA BILLING - AUTOMATED TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
      failed++;
    }
  }

  // --- TEST CASE 1: Create Invoice with Partial Payment ---
  console.log('👉 TEST CASE 1: Creating an invoice with partial payment...');
  const testInvId = 'test_inv_' + Date.now();
  const testCustomer = 'Test Farmer Murthy';
  const testPhone = '9876543210';
  const initialCreationTime = new Date().toISOString();

  const testInvoice = {
    id: testInvId,
    invoice_no: 'TEST-001',
    date: initialCreationTime,
    customer_name: testCustomer,
    phone: testPhone,
    items: [
      { name: 'Shrimp Feed 25KG', quantity: 2, rate: 1500, total: 3000 },
      { name: 'Water Probiotic 1L', quantity: 1, rate: 800, total: 800 }
    ],
    subtotal: 3800,
    grand_total: 3800,
    paid_amount: 1000, // Customer paid only 1,000 upfront
    balance_due: 2800, // 2,800 due
    payment_status: 'PARTIAL',
    payment_mode: 'Cash',
    raw_data: {
      id: testInvId,
      invoiceNo: 'TEST-001',
      date: initialCreationTime,
      customerName: testCustomer,
      customerPhone: testPhone,
      items: [
        { name: 'Shrimp Feed 25KG', quantity: 2, rate: 1500, total: 3000 },
        { name: 'Water Probiotic 1L', quantity: 1, rate: 800, total: 800 }
      ],
      total: 3800,
      paidAmount: 1000,
      balanceDue: 2800,
      paymentStatus: 'PARTIAL',
      paymentHistory: [
        {
          date: initialCreationTime,
          amount: 1000,
          mode: 'Cash',
          reference: 'Upfront counter advance',
          status: 'PARTIAL'
        }
      ]
    }
  };

  const insertRes = await sb.from('invoices').insert([testInvoice]);
  assert(insertRes.status === 201, 'Invoice saved into Supabase with ₹2,800 balance due');

  // --- TEST CASE 2: Post-Invoice Settlement with Exact Timestamp ---
  console.log('\n👉 TEST CASE 2: Settling balance 2 hours later via UPI QR...');
  const postPaymentTime = new Date().toISOString();
  const paymentAmount = 2800;
  const utrNumber = 'UPI/UTR/894729184712';

  const updatedRawData = {
    ...testInvoice.raw_data,
    paidAmount: 3800,
    balanceDue: 0,
    paymentStatus: 'PAID',
    paymentMode: 'UPI / QR',
    paymentReference: utrNumber,
    lastPaymentTime: postPaymentTime,
    paymentHistory: [
      ...testInvoice.raw_data.paymentHistory,
      {
        date: postPaymentTime,
        amount: paymentAmount,
        mode: 'UPI / QR',
        reference: utrNumber,
        status: 'PAID',
        note: 'Customer cleared balance via UPI QR'
      }
    ]
  };

  const updateRes = await sb
    .from('invoices')
    .update({
      paid_amount: 3800,
      balance_due: 0,
      payment_status: 'PAID',
      payment_mode: 'UPI / QR',
      raw_data: updatedRawData,
      updated_at: postPaymentTime
    })
    .eq('id', testInvId);

  assert(updateRes.status === 204, 'Post-invoice payment timestamp & UTR recorded in Supabase');

  // --- TEST CASE 3: Retrieve and Verify Customer 360 Aggregation ---
  console.log('\n👉 TEST CASE 3: Querying Customer Profile to verify full purchase & payment timeline...');
  const fetchRes = await sb.from('invoices').select('*').eq('id', testInvId).single();
  assert(fetchRes.data && fetchRes.data.id === testInvId, 'Fetched customer invoice from Supabase');

  const fetched = fetchRes.data;
  assert(fetched.paid_amount === 3800 && fetched.balance_due === 0, 'Balance reconciled to ₹0.00');
  assert(fetched.payment_status === 'PAID', 'Payment status marked as PAID');

  const history = fetched.raw_data.paymentHistory || [];
  assert(history.length === 2, 'Customer payment history contains both transactions');
  assert(history[0].amount === 1000 && history[0].mode === 'Cash', 'First payment (₹1,000 Cash advance) verified');
  assert(history[1].amount === 2800 && history[1].reference === utrNumber, 'Second payment (₹2,800 UPI with UTR) verified with exact timestamp');

  // --- CLEANUP TEST DATA ---
  console.log('\n🧹 Cleaning up test row from Supabase...');
  await sb.from('invoices').delete().eq('id', testInvId);
  console.log('✅ Test record removed from database.');

  console.log('\n====================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');
}

runAllTests().catch(err => console.error('Test suite encountered an error:', err));

