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
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;
const APP_URL = (process.env.APP_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const TOKENS_FILE = path.join(process.env.DEALS_DIR || __dirname, 'tokens.json');
const OAUTH_SCOPES = 'Calendars.Read Files.Read User.Read offline_access';
const INTERNAL_DOMAINS = ['quinta.im', 'quicktext.im'];

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

// ── Microsoft OAuth tokens ────────────────────────────────────────────────────
function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; }
}
function writeTokens(t) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)); }

function msTokenRequest(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'login.microsoftonline.com',
      path: `/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ error: data }); } });
    });
    req.setTimeout(15000, () => req.destroy(new Error('MS token timeout')));
    req.on('error', reject); req.write(body); req.end();
  });
}

async function getValidToken(email) {
  const tokens = readTokens();
  const user = tokens[email];
  if (!user) return null;
  if (user.expires_at && Date.now() < user.expires_at - 300000) return user.access_token;
  const r = await msTokenRequest({ grant_type: 'refresh_token', refresh_token: user.refresh_token,
    client_id: AZURE_CLIENT_ID, client_secret: AZURE_CLIENT_SECRET, scope: OAUTH_SCOPES });
  if (!r.access_token) return null;
  tokens[email] = { ...user, access_token: r.access_token,
    refresh_token: r.refresh_token || user.refresh_token,
    expires_at: Date.now() + (r.expires_in || 3600) * 1000 };
  writeTokens(tokens);
  return r.access_token;
}

function graphRequest(accessToken, apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.microsoft.com', path: '/v1.0' + apiPath, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken },
    }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ error: data }); } });
    });
    req.setTimeout(20000, () => req.destroy(new Error('Graph timeout')));
    req.on('error', reject); req.end();
  });
}

function graphDownload(downloadUrl) {
  return new Promise((resolve, reject) => {
    https.get(downloadUrl, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        graphDownload(res.headers.location).then(resolve).catch(reject); return;
      }
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

const oauthStates = new Set();

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
async function hubspotSearch(objectType, propName, operator, value) {
  const r = await hubspotRequest('POST', `/crm/v3/objects/${objectType}/search`, {
    filterGroups: [{ filters: [{ propertyName: propName, operator, value }] }],
    limit: 1,
    properties: [propName],
  });
  return (r.results && r.results.length) ? r.results[0].id : null;
}

// Associate deal with company and contacts after creation; returns summary log
async function associateDealCRM(dealId, deal) {
  const log = [];

  // Company: try exact match first, fall back to partial token match
  if (deal.company_name) {
    let companyId = await hubspotSearch('companies', 'name', 'EQ', deal.company_name);
    if (!companyId) companyId = await hubspotSearch('companies', 'name', 'CONTAINS_TOKEN', deal.company_name.split(' ')[0]);
    if (companyId) {
      await hubspotRequest('POST', '/crm/v3/associations/deals/companies/batch/create', {
        inputs: [{ from: { id: String(dealId) }, to: { id: String(companyId) }, type: 'deal_to_company' }],
      });
      log.push('company:' + companyId);
    } else {
      log.push('company:not_found');
    }
  }

  // Contacts by email (from attendees array in deal JSON)
  const attendees = Array.isArray(deal.attendees) ? deal.attendees : [];
  for (const a of attendees) {
    if (!a.email) continue;
    const contactId = await hubspotSearch('contacts', 'email', 'EQ', a.email);
    if (contactId) {
      await hubspotRequest('POST', '/crm/v3/associations/deals/contacts/batch/create', {
        inputs: [{ from: { id: String(dealId) }, to: { id: String(contactId) }, type: 'deal_to_contact' }],
      });
      log.push('contact:' + contactId);
    } else {
      log.push('contact_not_found:' + a.email);
    }
  }

  return log;
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
      await hubspotRequest('POST', '/crm/v3/associations/line_items/quotes/batch/create', {
        inputs: [{ from: { id: String(li.id) }, to: { id: String(quote.id) }, type: 'line_item_to_quote' }],
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

  // OAuth: /auth/callback is public (Microsoft redirects here)
  if (AZURE_CLIENT_ID && method === 'GET' && pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !oauthStates.has(state)) { res.writeHead(400); res.end('Invalid OAuth state'); return; }
    oauthStates.delete(state);
    try {
      const tr = await msTokenRequest({ grant_type: 'authorization_code', code,
        client_id: AZURE_CLIENT_ID, client_secret: AZURE_CLIENT_SECRET,
        redirect_uri: APP_URL + '/auth/callback', scope: OAUTH_SCOPES });
      if (!tr.access_token) { res.writeHead(400); res.end('Token exchange failed: ' + JSON.stringify(tr)); return; }
      const profile = await graphRequest(tr.access_token, '/me?$select=displayName,mail,userPrincipalName');
      const email = profile.mail || profile.userPrincipalName;
      const tokens = readTokens();
      tokens[email] = { name: profile.displayName, email, access_token: tr.access_token,
        refresh_token: tr.refresh_token, expires_at: Date.now() + (tr.expires_in || 3600) * 1000,
        connected_at: new Date().toISOString() };
      writeTokens(tokens);
      res.writeHead(302, { Location: '/' }); res.end();
    } catch (e) { res.writeHead(500); res.end('OAuth error: ' + e.message); }
    return;
  }

  const apiKeyOk = API_KEY && req.headers['x-api-key'] === API_KEY;
  if (!apiKeyOk && !getSessionToken(req)) { json(res, { error: 'Unauthorized' }, 401); return; }

  // OAuth connect (session required — starts the Microsoft login flow)
  if (AZURE_CLIENT_ID && method === 'GET' && pathname === '/auth/connect') {
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.add(state);
    const authUrl = 'https://login.microsoftonline.com/' + AZURE_TENANT_ID + '/oauth2/v2.0/authorize' +
      '?client_id=' + AZURE_CLIENT_ID +
      '&response_type=code' +
      '&redirect_uri=' + encodeURIComponent(APP_URL + '/auth/callback') +
      '&scope=' + encodeURIComponent(OAUTH_SCOPES) +
      '&state=' + state +
      '&prompt=select_account';
    res.writeHead(302, { Location: authUrl }); res.end();
    return;
  }

  // Azure config flag (tells UI whether to show Connect button)
  if (method === 'GET' && pathname === '/api/auth/config') {
    return json(res, { azure_configured: !!(AZURE_CLIENT_ID && AZURE_TENANT_ID) });
  }

  // Connected Microsoft accounts
  if (method === 'GET' && pathname === '/api/auth/users') {
    const t = readTokens();
    return json(res, Object.values(t).map(u => ({ name: u.name, email: u.email, connected_at: u.connected_at })));
  }

  if (method === 'DELETE' && pathname.startsWith('/api/auth/users/')) {
    const email = decodeURIComponent(pathname.replace('/api/auth/users/', ''));
    const t = readTokens(); delete t[email]; writeTokens(t);
    return json(res, { ok: true });
  }

  // Scan all connected accounts' calendars and return meetings + transcripts
  if (method === 'GET' && pathname === '/api/meetings/scan') {
    const tokens = readTokens();
    const emails = Object.keys(tokens);
    if (!emails.length) return json(res, { meetings: [], note: 'No connected accounts' });

    const afterDt  = url.searchParams.get('after')  || new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const beforeDt = url.searchParams.get('before') || new Date().toISOString();
    const meetings = [];

    for (const email of emails) {
      const token = await getValidToken(email).catch(() => null);
      if (!token) continue;

      const calPath = '/me/calendarView' +
        '?startDateTime=' + encodeURIComponent(afterDt) +
        '&endDateTime='   + encodeURIComponent(beforeDt) +
        '&$select=id,subject,start,end,location,attendees,organizer,onlineMeeting,isCancelled,isOrganizer' +
        '&$orderby=start/dateTime+desc&$top=25';

      const cal = await graphRequest(token, calPath).catch(() => null);
      if (!cal || !cal.value) continue;

      for (const ev of cal.value) {
        if (ev.isCancelled) continue;
        const loc = (ev.location?.displayName || '').toLowerCase();
        if (!loc.includes('teams') && !loc.includes('microsoft') && !ev.onlineMeeting) continue;
        if (!ev.isOrganizer) continue;
        const external = (ev.attendees || []).filter(a =>
          !INTERNAL_DOMAINS.some(d => (a.emailAddress?.address || '').toLowerCase().endsWith('@' + d)));
        if (!external.length) continue;

        let transcript = null;
        try {
          const toUtc = s => s.endsWith('Z') ? s : s + 'Z';
          const start = new Date(toUtc(ev.start.dateTime));
          const end   = new Date(toUtc(ev.end.dateTime));
          const wStart = new Date(start.getTime() - 300000);   // 5 min before
          const wEnd   = new Date(end.getTime()   + 5400000);  // 90 min after

          const files = await graphRequest(token,
            '/me/drive/root:/Recordings:/children?$orderby=createdDateTime+desc&$top=30').catch(() => null);

          if (files?.value) {
            const match = files.value.find(f => {
              if (!f.name.endsWith('.vtt')) return false;
              const c = new Date(f.createdDateTime);
              return c >= wStart && c <= wEnd;
            });
            if (match?.['@microsoft.graph.downloadUrl']) {
              transcript = await graphDownload(match['@microsoft.graph.downloadUrl']).catch(() => null);
            }
          }
        } catch {}

        meetings.push({
          id: ev.id, subject: ev.subject || '(no subject)',
          date: (ev.start.dateTime || '').slice(0, 10),
          organizer_email: email,
          attendees: (ev.attendees || []).map(a => ({
            name: a.emailAddress?.name || '', email: a.emailAddress?.address || '' })),
          has_transcript: !!(transcript && transcript.length > 100),
          transcript,
        });
      }
    }
    return json(res, { meetings });
  }

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

          // Associate company + contacts (best-effort)
          let assocLog = [];
          try { assocLog = await associateDealCRM(result.id, deal); } catch (e) { assocLog = ['assoc_error:' + e.message]; }

          // Create quote and line items
          const quoteResult = await createQuoteForDeal(result.id, deal);
          if (quoteResult.id) {
            deals[idx].hubspot_quote_id = quoteResult.id;
            deals[idx].hubspot_quote_url = quoteResult.url;
          }

          writeDeals(deals);
          json(res, { id: result.id, url: dealUrl, quote_url: quoteResult.url, quote_error: quoteResult.error, assoc: assocLog });
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
