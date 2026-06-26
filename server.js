'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

// Load .env file if present (doesn't override already-set env vars)
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

const PORT = process.env.PORT || 3333;
const DEALS_FILE = path.join(process.env.DEALS_DIR || __dirname, 'pending_deals.json');
const HTML_FILE = path.join(__dirname, 'ui.html');
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const OWNER_ID = process.env.HUBSPOT_OWNER_ID || '247600067';
const HUBSPOT_PORTAL = process.env.HUBSPOT_PORTAL || '25445053';
const LOGIN_USER = process.env.QD_USER || 'quinta';
const LOGIN_PASS = process.env.QD_PASS || 'dealsQ26';
const API_KEY = process.env.QD_API_KEY || null; // optional: allows agent to POST deals without a session

const PIPELINES = {
  sales:  { id: 'default',    stage: 'appointmentscheduled', dealtype: 'newbusiness'      },
  upsell: { id: '310802926',  stage: '495554527',            dealtype: 'existingbusiness' },
  cs:     { id: '14338264',   stage: '48953307',             dealtype: 'existingbusiness' },
};

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = new Map(); // token -> expiry timestamp

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 24 * 3600 * 1000);
  return token;
}

function getSessionToken(req) {
  const m = (req.headers.cookie || '').match(/qds=([0-9a-f]{64})/);
  if (!m) return null;
  const exp = sessions.get(m[1]);
  if (!exp || Date.now() > exp) { sessions.delete(m[1]); return null; }
  return m[1];
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (now > exp) sessions.delete(t);
}, 3600000);

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event) {
  const msg = 'event: ' + event + '\ndata: {}\n\n';
  for (const c of [...sseClients]) {
    try { c.write(msg); } catch { sseClients.delete(c); }
  }
}

let broadcastTimer = null;
try {
  fs.watch(__dirname, (event, filename) => {
    if (filename === 'pending_deals.json') {
      clearTimeout(broadcastTimer);
      broadcastTimer = setTimeout(() => broadcast('update'), 800);
    }
  });
} catch {}

// ── Data ──────────────────────────────────────────────────────────────────────
function readDeals() {
  try { return JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8')); } catch { return []; }
}

function writeDeals(deals) {
  fs.writeFileSync(DEALS_FILE, JSON.stringify(deals, null, 2));
}

// ── HubSpot ───────────────────────────────────────────────────────────────────
function hubspotRequest(method, path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = https.request({
      hostname: 'api.hubapi.com', path, method,
      headers: {
        'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (!data) { resolve({ _status: res.statusCode }); return; } // 204 No Content etc.
        try { resolve(JSON.parse(data)); } catch { resolve({ error: data, _status: res.statusCode }); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(new Error('HubSpot request timeout: ' + method + ' ' + path)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Search HubSpot CRM and return first matching object id, or null
async function hubspotSearch(objectType, propName, value) {
  const r = await hubspotRequest('POST', `/crm/v3/objects/${objectType}/search`, {
    filterGroups: [{ filters: [{ propertyName: propName, operator: 'EQ', value }] }],
    limit: 1,
    properties: [propName],
  });
  return (r.results && r.results.length) ? r.results[0].id : null;
}

// Associate deal with company and contacts after creation
async function associateDealCRM(dealId, deal) {
  // Company by name
  if (deal.company_name) {
    const companyId = await hubspotSearch('companies', 'name', deal.company_name);
    if (companyId) {
      await hubspotRequest('POST', '/crm/v3/associations/deals/companies/batch/create', {
        inputs: [{ from: { id: String(dealId) }, to: { id: String(companyId) }, type: 'deal_to_company' }],
      });
    }
  }
  // Contacts by email (from attendees array in deal JSON)
  const attendees = Array.isArray(deal.attendees) ? deal.attendees : [];
  for (const a of attendees) {
    if (!a.email) continue;
    const contactId = await hubspotSearch('contacts', 'email', a.email);
    if (contactId) {
      await hubspotRequest('POST', '/crm/v3/associations/deals/contacts/batch/create', {
        inputs: [{ from: { id: String(dealId) }, to: { id: String(contactId) }, type: 'deal_to_contact' }],
      });
    }
  }
}

async function createQuoteForDeal(dealId, deal) {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 30);

  // 1. Create the quote (expiration date must be ms timestamp as string)
  const quote = await hubspotRequest('POST', '/crm/v3/objects/quotes', {
    properties: {
      hs_title: deal.deal_name,
      hs_expiration_date: String(expiry.getTime()),
      hs_status: 'DRAFT',
      hs_language: 'en',
      hs_template_type: 'CUSTOMIZABLE_QUOTE_TEMPLATE',
    },
  });
  if (!quote.id) return { error: 'Quote creation failed: ' + JSON.stringify(quote) };

  // 2. Associate quote with deal via v3 batch API
  const assocResult = await hubspotRequest('POST', '/crm/v3/associations/quotes/deals/batch/create', {
    inputs: [{ from: { id: String(quote.id) }, to: { id: String(dealId) }, type: 'quote_to_deal' }],
  });
  if (assocResult.error) console.warn('Quote-deal association warning:', assocResult.error);

  // 3. Create one line item per product and associate with the quote
  const products = Array.isArray(deal.products) && deal.products.length
    ? deal.products
    : ['Quinta Services'];
  const total = parseFloat(deal.estimated_amount) || 0;
  const unitPrice = total && products.length ? (total / products.length).toFixed(2) : '0';

  for (const product of products) {
    const li = await hubspotRequest('POST', '/crm/v3/objects/line_items', {
      properties: {
        name: product,
        quantity: '1',
        price: unitPrice,
        recurringbillingfrequency: 'monthly',
        hs_recurring_billing_period: 'P12M',
      },
    });
    if (li.id) {
      // Associate line item with quote
      await hubspotRequest('POST', '/crm/v3/associations/line_items/quotes/batch/create', {
        inputs: [{ from: { id: String(li.id) }, to: { id: String(quote.id) }, type: 'line_item_to_quote' }],
      });
      // Associate line item with deal
      await hubspotRequest('POST', '/crm/v3/associations/line_items/deals/batch/create', {
        inputs: [{ from: { id: String(li.id) }, to: { id: String(dealId) }, type: 'line_item_to_deal' }],
      });
    }
  }

  const quoteUrl = 'https://app-eu1.hubspot.com/contacts/' + HUBSPOT_PORTAL + '/quotes/' + quote.id;
  return { id: quote.id, url: quoteUrl };
}

function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); });
}

function json(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(HTML_FILE));
    } catch (e) { res.writeHead(500); res.end('ui.html not found: ' + e.message); }
    return;
  }

  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    let creds;
    try { creds = JSON.parse(body); } catch { return json(res, { error: 'Bad request' }, 400); }
    if (creds.user === LOGIN_USER && creds.pass === LOGIN_PASS) {
      const token = createSession();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'qds=' + token + '; HttpOnly; SameSite=Strict; Path=/',
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      json(res, { error: 'Invalid credentials' }, 401);
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const m = (req.headers.cookie || '').match(/qds=([0-9a-f]{64})/);
    if (m) sessions.delete(m[1]);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'qds=; Max-Age=0; Path=/' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const apiKeyOk = API_KEY && req.headers['x-api-key'] === API_KEY;
  if (!apiKeyOk && !getSessionToken(req)) { json(res, { error: 'Unauthorized' }, 401); return; }

  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); sseClients.delete(res); }
    }, 25000);
    return;
  }

  if (method === 'GET' && pathname === '/api/deals') {
    return json(res, readDeals());
  }

  if (method === 'POST' && pathname === '/api/deals') {
    const body = await readBody(req);
    try {
      const incoming = JSON.parse(body);
      const newDeals = Array.isArray(incoming) ? incoming : [incoming];
      const existing = readDeals();
      writeDeals([...existing.filter(d => d.status !== 'pending'), ...newDeals]);
      json(res, { ok: true });
    } catch (e) { json(res, { error: e.message }, 400); }
    return;
  }

  const match = pathname.match(/^\/api\/deals\/(\d+)(\/[\w-]+)?$/);
  if (match) {
    const idx = parseInt(match[1], 10);
    const action = match[2] || '';

    if (method === 'PUT' && !action) {
      const body = await readBody(req);
      try {
        const deals = readDeals();
        if (idx < 0 || idx >= deals.length) return json(res, { error: 'Not found' }, 404);
        const updated = JSON.parse(body);
        delete updated._editing;
        deals[idx] = updated;
        writeDeals(deals);
        json(res, { ok: true });
      } catch (e) { json(res, { error: e.message }, 400); }
      return;
    }

    if (method === 'POST' && action === '/create') {
      const deals = readDeals();
      if (idx < 0 || idx >= deals.length) return json(res, { error: 'Not found' }, 404);
      const deal = deals[idx];
      const pipe = PIPELINES[deal.pipeline] || PIPELINES.cs;
      const nsStr = Array.isArray(deal.next_steps)
        ? deal.next_steps.map(s => '- ' + s).join('\n')
        : (deal.next_steps || '');
      const closeDate = new Date();
      closeDate.setDate(closeDate.getDate() + 30);
      const payload = {
        properties: {
          dealname: deal.deal_name,
          pipeline: pipe.id,
          dealstage: pipe.stage,
          hubspot_owner_id: OWNER_ID,
          dealtype: pipe.dealtype,
          description: (deal.summary || '') + (nsStr ? '\n\nNext steps:\n' + nsStr : ''),
          closedate: closeDate.toISOString().split('T')[0],
        },
      };
      if (deal.estimated_amount) payload.properties.amount = String(deal.estimated_amount);
      try {
        const result = await hubspotRequest('POST', '/crm/v3/objects/deals', payload);
        if (result.id) {
          const dealUrl = 'https://app-eu1.hubspot.com/contacts/' + HUBSPOT_PORTAL + '/record/0-3/' + result.id;
          deals[idx].status = 'created';
          deals[idx].hubspot_id = result.id;
          deals[idx].hubspot_url = dealUrl;

          // Associate company + contacts (best-effort, won't block deal creation)
          try { await associateDealCRM(result.id, deal); } catch {}

          // Create quote and line items
          const quoteResult = await createQuoteForDeal(result.id, deal);
          if (quoteResult.id) {
            deals[idx].hubspot_quote_id = quoteResult.id;
            deals[idx].hubspot_quote_url = quoteResult.url;
          }

          writeDeals(deals);
          json(res, { id: result.id, url: dealUrl, quote_url: quoteResult.url, quote_error: quoteResult.error });
        } else {
          json(res, { error: JSON.stringify(result) }, 400);
        }
      } catch (e) { json(res, { error: e.message }, 500); }
      return;
    }

    if (method === 'POST' && action === '/create-quote') {
      const deals = readDeals();
      if (idx < 0 || idx >= deals.length) return json(res, { error: 'Not found' }, 404);
      const deal = deals[idx];
      if (!deal.hubspot_id) return json(res, { error: 'Deal not created in HubSpot yet' }, 400);
      try {
        const quoteResult = await createQuoteForDeal(deal.hubspot_id, deal);
        if (quoteResult.id) {
          deals[idx].hubspot_quote_id = quoteResult.id;
          deals[idx].hubspot_quote_url = quoteResult.url;
          writeDeals(deals);
          json(res, { id: quoteResult.id, url: quoteResult.url });
        } else {
          json(res, { error: quoteResult.error }, 400);
        }
      } catch (e) { json(res, { error: e.message }, 500); }
      return;
    }

    if (method === 'POST' && action === '/skip') {
      const deals = readDeals();
      if (idx >= 0 && idx < deals.length) { deals[idx].status = 'skipped'; writeDeals(deals); }
      json(res, { ok: true });
      return;
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\nQuinta Deal Review  ->  http://localhost:' + PORT);
  console.log('Login: ' + LOGIN_USER + ' / dealsQ26  (override: QD_USER / QD_PASS)\n');
  exec((process.platform === 'win32' ? 'start' : 'open') + ' http://localhost:' + PORT);
});
