-- Supabase Database Schema for Aaryan Aqua Needs (Fish Billing)

-- 1. Invoices Table
create table if not exists public.invoices (
  id text primary key,
  invoice_no text not null,
  date text,
  customer_name text,
  phone text,
  items jsonb default '[]'::jsonb,
  subtotal numeric default 0,
  tax numeric default 0,
  cgst numeric default 0,
  sgst numeric default 0,
  igst numeric default 0,
  discount numeric default 0,
  round_off numeric default 0,
  grand_total numeric default 0,
  paid_amount numeric default 0,
  balance_due numeric default 0,
  payment_status text default 'PAID',
  payment_mode text default 'UPI / QR',
  vehicle_no text,
  transport_name text,
  destination text,
  raw_data jsonb default '{}'::jsonb,
  is_deleted boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. Products / Inventory Table
create table if not exists public.products (
  id text primary key,
  description text not null,
  hsn text default '',
  pack_size text default '',
  unit text default 'NOS',
  rate numeric default 0,
  discount numeric default 0,
  price numeric default 0,
  stock numeric default 0,
  total_value numeric default 0,
  status text default 'In Stock',
  is_deleted boolean default false,
  updated_at timestamptz default now()
);

-- 3. Customers Table
create table if not exists public.customers (
  id text primary key,
  name text not null,
  phone text default '',
  email text default '',
  address text default '',
  gstin text default '',
  balance numeric default 0,
  is_deleted boolean default false,
  updated_at timestamptz default now()
);

-- 4. Global Settings Table
create table if not exists public.settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- Indexes for performance
create index if not exists idx_invoices_no on public.invoices (invoice_no);
create index if not exists idx_invoices_date on public.invoices (date);
create index if not exists idx_invoices_updated on public.invoices (updated_at);
create index if not exists idx_products_updated on public.products (updated_at);
create index if not exists idx_customers_updated on public.customers (updated_at);

-- Row Level Security (RLS)
alter table public.invoices enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.settings enable row level security;

-- Policies allowing authenticated & anon access (adjust as needed for your project's auth model)
create policy "Allow all on invoices" on public.invoices for all using (true) with check (true);
create policy "Allow all on products" on public.products for all using (true) with check (true);
create policy "Allow all on customers" on public.customers for all using (true) with check (true);
create policy "Allow all on settings" on public.settings for all using (true) with check (true);
