#!/usr/bin/env node
// One-time setup for the Trinect LLC payment page: creates (or updates) two Stripe Payment Links and
// writes their public URLs to docs/links.json, then commits and pushes so the site picks them up.
//
//   node setup/create-links.mjs                      # asks for the Stripe secret key (hidden)
//   node setup/create-links.mjs < ~/stripe-key.txt   # or reads it from a file / pipe
//
// The key is used for these API calls only. It is never written to disk, logged or published: the site
// only ever holds the Payment Link URLs, which are public by design. Running it again finds the links it
// made before (by metadata) and updates them instead of making new ones.
//
// Options (environment): SITE_URL (where the site lives; the thank-you page is SITE_URL + thanks.html),
// MIN_USD (default 1), MAX_USD (default 50000), NO_PUSH=1 (write links.json only), PRINT_ONLY=1 (print
// the links and write nothing, for running it on the machine that holds the key).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = (process.env.SITE_URL || 'https://iutsa.github.io/trinect-pay/').replace(/\/?$/, '/');
const MIN = Math.round(Number(process.env.MIN_USD || 1) * 100);
const MAX = Math.round(Number(process.env.MAX_USD || 50000) * 100);

const OPTIONS = {
  invoice: {
    product: 'Trinect LLC invoice payment',
    description: 'Trinect LLC invoice payment',
    field: { key: 'invoice', label: 'Invoice number' },
  },
  other: {
    product: 'Trinect LLC payment',
    description: 'Trinect LLC payment',
    field: { key: 'purpose', label: 'What is this payment for?' },
  },
};

async function readKey() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY.trim();
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  // Typed at a prompt: nothing is echoed
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes('Stripe secret key')) rl.output.write(s); };
  const key = await new Promise((resolve) => rl.question('Stripe secret key (sk_live_… or rk_live_…, hidden): ', resolve));
  rl.close();
  process.stdout.write('\n');
  return key.trim();
}

const key = await readKey();
if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) {
  console.error('That does not look like a Stripe secret key (it starts with sk_live_, rk_live_, sk_test_ or rk_test_).');
  process.exit(1);
}
const live = key.includes('_live_');

// Stripe's API takes form-encoded bodies with bracketed keys
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, name, out); else out.append(name, String(v));
  }
  return out;
}
async function stripe(method, url, body) {
  const res = await fetch(`https://api.stripe.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body: body ? form(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${json.error ? json.error.message : res.status}`);
  return json;
}

// The links this script made before, by their metadata
async function existingLinks() {
  const found = {};
  let after;
  for (;;) {
    const page = await stripe('GET', `/v1/payment_links?limit=100&active=true${after ? `&starting_after=${after}` : ''}`);
    for (const l of page.data) {
      const kind = l.metadata && l.metadata.trinect_kind;
      if (l.metadata && l.metadata.business === 'trinect' && OPTIONS[kind] && !found[kind]) found[kind] = l;
    }
    if (!page.has_more) return found;
    after = page.data[page.data.length - 1].id;
  }
}

const account = await stripe('GET', '/v1/account');
const shownAs = (account.settings && account.settings.dashboard && account.settings.dashboard.display_name)
  || (account.business_profile && account.business_profile.name) || account.id;
console.log(`Stripe account: ${shownAs} (${live ? 'LIVE' : 'test'} mode)`);

const before = await existingLinks();
const links = {};
for (const [kind, o] of Object.entries(OPTIONS)) {
  // Nothing here names a PunchMan company or subscription, so PunchMan's webhook ignores these payments
  const common = {
    after_completion: { type: 'redirect', redirect: { url: `${SITE_URL}thanks.html` } },
    billing_address_collection: 'auto',
    submit_type: 'pay',
    custom_fields: { 0: { key: o.field.key, label: { type: 'custom', custom: o.field.label }, type: 'text', optional: false } },
    payment_intent_data: { description: o.description, metadata: { business: 'trinect', trinect_kind: kind } },
    metadata: { business: 'trinect', trinect_kind: kind },
  };
  if (before[kind]) {
    const { payment_intent_data: _skip, ...updatable } = common;   // set once, at creation
    const l = await stripe('POST', `/v1/payment_links/${before[kind].id}`, updatable);
    links[kind] = l.url;
    console.log(`${kind}: updated ${l.url}`);
    continue;
  }
  const price = await stripe('POST', '/v1/prices', {
    currency: 'usd',
    custom_unit_amount: { enabled: true, minimum: MIN, maximum: MAX },
    product_data: { name: o.product, metadata: { business: 'trinect', trinect_kind: kind } },
    metadata: { business: 'trinect', trinect_kind: kind },
  });
  const l = await stripe('POST', '/v1/payment_links', { ...common, line_items: { 0: { price: price.id, quantity: 1 } } });
  links[kind] = l.url;
  console.log(`${kind}: created ${l.url}`);
}

// Run somewhere else (where the key lives): just print the links, write nothing
if (process.env.PRINT_ONLY) { console.log(`LINKS ${JSON.stringify(links)}`); process.exit(0); }
const file = path.join(ROOT, 'docs', 'links.json');
const old = readFileSync(file, 'utf8');
const next = `${JSON.stringify(links, null, 2)}\n`;
writeFileSync(file, next);
if (old === next) { console.log('docs/links.json already up to date.'); process.exit(0); }
console.log('Wrote docs/links.json');
if (process.env.NO_PUSH) process.exit(0);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
git('add', 'docs/links.json');
git('commit', '-m', `Payment links (${live ? 'live' : 'test'} mode)`);
git('push');
console.log(`Pushed. The page updates in a minute or two: ${SITE_URL}`);
