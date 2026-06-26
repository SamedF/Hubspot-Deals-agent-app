# Scan Teams meetings and create HubSpot deals interactively

Run the full meeting-to-deal pipeline for the last 2 hours.

## Configuration

- HubSpot owner ID: from `HUBSPOT_OWNER_ID` env var (default: `247600067`)
- Internal domains: `quinta.im`, `quicktext.im`
- Min confidence to show deal: `0.65`
- Pipelines: sales=`default`/`appointmentscheduled`, upsell=`310802926`/`495554527`, cs=`14338264`/`48953307`

---

## STEP 0 — Detect calendar source

Use the Bash tool to read the project config and check for connected Graph accounts:

```bash
node -e "
var fs=require('fs'),path=require('path');
var env={};
try{fs.readFileSync(path.join(process.cwd(),'.env'),'utf8').split('\n').forEach(function(l){var m=l.match(/^([A-Z_0-9]+)=(.*)/);if(m)env[m[1]]=m[2].trim();});}catch(e){}
var apiKey=process.env.QD_API_KEY||env.QD_API_KEY||'';
var serverUrl=(process.env.SERVER_URL||env.SERVER_URL||'http://localhost:3333').replace(/\/$/,'');
console.log(JSON.stringify({apiKey:apiKey,serverUrl:serverUrl}));
"
```

If `apiKey` is non-empty, call:
```bash
curl -sf -H "X-API-KEY: <apiKey>" "<serverUrl>/api/auth/users"
```

- **If response contains 1+ user objects → use GRAPH PATH (Steps 1A + 2A)**
- **If empty array, error, or no apiKey → use MCP PATH (Steps 1B + 2B)**

---

## STEP 1A — Fetch meetings via Graph API (server scan)

Compute time window:
```bash
node -e "var d=new Date();var b=d.toISOString();d.setHours(d.getHours()-2);var a=d.toISOString();console.log('after='+encodeURIComponent(a)+'&before='+encodeURIComponent(b));"
```

Call the server scan endpoint:
```bash
curl -sf -H "X-API-KEY: <apiKey>" "<serverUrl>/api/meetings/scan?<after_before_params>"
```

Parse the JSON response. Each meeting object has:
- `subject`, `date`, `organizer_email`
- `attendees`: `[{name, email}]` — all attendees (filter out internal domains yourself)
- `has_transcript`: boolean
- `transcript`: raw VTT text (may be null)

Tell the user: "X meetings found, Y have transcripts."

Skip meetings where `has_transcript` is false or `transcript` is under 100 chars.

→ Proceed directly to **Step 3**.

---

## STEP 1B — Scan calendar via MS365 MCP

Call `outlook_calendar_search` (via the Microsoft 365 MCP server):
- query: `*`, afterDateTime: 2 hours ago (ISO 8601), beforeDateTime: now, order: newest, limit: 25

Keep only meetings that are ALL of:
- Not cancelled
- Location contains "Teams" or "Microsoft", OR has `onlineMeeting` object
- At least one attendee NOT ending in `@quinta.im` or `@quicktext.im`
- `organizer.address` matches your email (required to access transcripts)

Tell the user how many meetings were scanned and how many qualified.

---

## STEP 2B — Fetch transcripts via MS365 MCP

For each qualifying meeting, call `read_resource` with the event URI (`calendar:///events/{id}`). Extract `meetingTranscriptUrl`. If missing, construct from `onlineMeeting.joinUrl`: base64url-encode it and use `meeting-transcript:///events/{token}`.

Call `read_resource` with the transcript URL. Extract `transcripts[0].content` (VTT text). Strip timestamps and speaker tags — keep only spoken words. Skip if under 100 characters or if 403 (log: "reconnect MS365 connector").

Extract external attendees (non-quinta.im, non-quicktext.im) from the calendar event into `attendees: [{name, email}]`.

---

## STEP 3 — Analyze each transcript

For each meeting with a usable transcript, extract:
- `is_sales_cs_meeting`: true/false
- `meeting_type`: "sales" | "cs" | "upsell" | "other"
- `company_name`: exact hotel/company name
- `deal_name`: "CompanyName - Product1 + Product2"
- `estimated_amount`: number or null
- `products`: Quinta products mentioned (Q-Data, Q-Channel, Q-Brain+, Q-Sales, Q-Task, Q-SEO, Q-Mail, Q-Automate, WhatsApp/WABA, Velma)
- `summary`: 2-3 sentences in English
- `next_steps`: list of concrete follow-up actions
- `confidence`: 0.0-1.0
- `attendees`: external attendees as `[{"name": "...", "email": "..."}]`

Skip if `is_sales_cs_meeting` is false or `confidence < 0.65`.

---

## STEP 4 — Push deals to the web UI

Collect all qualifying deal drafts into a JSON array. Each object must have:

```json
{
  "status": "pending",
  "meeting_subject": "<event subject>",
  "meeting_date": "<ISO date e.g. 2026-06-24>",
  "meeting_type": "sales|upsell|cs",
  "company_name": "...",
  "deal_name": "...",
  "pipeline": "sales|upsell|cs",
  "estimated_amount": 1000,
  "products": ["Q-Data", "Velma"],
  "summary": "...",
  "next_steps": ["step 1", "step 2"],
  "confidence": 0.87,
  "attendees": [
    {"name": "Andrea Gulberti", "email": "andrea@example.com"}
  ]
}
```

### 4a — Write deals to `pending_deals.json`

```bash
node -e "var fs=require('fs'),path=require('path');var f=path.join(process.cwd(),'pending_deals.json');var ex=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[];var kept=ex.filter(function(d){return d.status!=='pending';});var nd=__DEALS_JSON__;fs.writeFileSync(f,JSON.stringify(kept.concat(nd),null,2));console.log('Queued '+nd.length+' deals');"
```

Replace `__DEALS_JSON__` with the actual array literal.

### 4b — Start the server (if not already running)

```powershell
$projectDir = Get-Location
$serverJs = Join-Path $projectDir "server.js"
$running = netstat -ano 2>$null | Select-String ":3333"
if (-not $running) {
  Start-Process node -ArgumentList $serverJs -WindowStyle Hidden
  Start-Sleep -Seconds 2
}
Start-Process "http://localhost:3333"
```

Tell the user:

```
🌐 Your deals are ready for review at http://localhost:3333
   Edit any field, then click "Create in HubSpot" to approve.
```

---

## STEP 5 — Final summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DONE
Meetings scanned : X  |  Qualifying : X
Deals queued     : X  →  http://localhost:3333
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
