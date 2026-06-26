# Scan Teams meetings and create HubSpot deals interactively

Run the full meeting-to-deal pipeline for the last 2 hours.

## Configuration

- HubSpot token: from `HUBSPOT_TOKEN` env var (set in CLAUDE.md or `.env`)
- HubSpot owner ID: from `HUBSPOT_OWNER_ID` env var (default: `247600067`)
- Internal domains: `quinta.im`, `quicktext.im`
- Min confidence to show deal: `0.65`
- Pipelines: sales=`default`/`appointmentscheduled`, upsell=`310802926`/`495554527`, cs=`14338264`/`48953307`
- Server path: derived at runtime from the project folder (see Step 4b)

---

## STEP 1 — Scan calendar

Call `outlook_calendar_search` (via the Microsoft 365 MCP server):
- query: `*`, afterDateTime: 2 hours ago (ISO 8601), beforeDateTime: now, order: newest, limit: 25

Keep only meetings that are ALL of:
- Not cancelled
- Location contains "Teams" or "Microsoft", OR has `onlineMeeting` object
- At least one attendee NOT ending in `@quinta.im` or `@quicktext.im`
- `organizer.address` matches your email (required to access transcripts)

Tell the user how many meetings were scanned and how many qualified.

---

## STEP 2 — Fetch transcripts

For each qualifying meeting, call `read_resource` with the event URI (`calendar:///events/{id}`). Extract `meetingTranscriptUrl`. If missing, construct from `onlineMeeting.joinUrl`: base64url-encode it and use `meeting-transcript:///events/{token}`.

Call `read_resource` with the transcript URL. Extract `transcripts[0].content` (VTT text). Strip timestamps and speaker tags — keep only spoken words. Skip if under 100 characters or if 403 (log: "reconnect MS365 connector").

---

## STEP 3 — Analyze transcript

Extract:
- `is_sales_cs_meeting`: true/false
- `meeting_type`: "sales" | "cs" | "upsell" | "other"
- `company_name`: exact hotel/company name
- `deal_name`: "CompanyName - Product1 + Product2"
- `estimated_amount`: number or null
- `products`: Quinta products mentioned (Q-Data, Q-Channel, Q-Brain+, Q-Sales, Q-Task, Q-SEO, Q-Mail, Q-Automate, WhatsApp/WABA, Velma)
- `summary`: 2-3 sentences in English
- `next_steps`: list of concrete follow-up actions
- `confidence`: 0.0-1.0
- `attendees`: list of external attendees (non-quinta.im, non-quicktext.im) from the calendar event, as `[{"name": "...", "email": "..."}]`

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

Use the Bash tool to run this Node.js one-liner (replace `__DEALS_JSON__` with the actual JSON array).
The script uses `process.cwd()` so it works from any machine as long as Claude Code is opened in the project folder.

```bash
node -e "var fs=require('fs'),path=require('path');var f=path.join(process.cwd(),'pending_deals.json');var ex=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[];var kept=ex.filter(function(d){return d.status!=='pending';});var nd=__DEALS_JSON__;fs.writeFileSync(f,JSON.stringify(kept.concat(nd),null,2));console.log('Queued '+nd.length+' deals');"
```

Replace `__DEALS_JSON__` with the actual array literal. Escape any double quotes inside string values with `\"`.

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
