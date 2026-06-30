# Generate daily tasks from emails, meetings, and HubSpot

Scans the last 48 hours of emails, open HubSpot tasks, inactive deals, and meeting next steps to produce a prioritized task list.

## STEP 0 — Get config

```bash
node -e "
var fs=require('fs'),path=require('path');
var env={};
try{fs.readFileSync(path.join(process.cwd(),'.env'),'utf8').split('\n').forEach(function(l){var m=l.match(/^([A-Z_0-9]+)=(.*)/);if(m)env[m[1]]=m[2].trim();});}catch(e){}
var apiKey=process.env.QD_API_KEY||env.QD_API_KEY||'';
var serverUrl=(process.env.SERVER_URL||env.SERVER_URL||'http://localhost:3333').replace(/\/$/,'');
console.log(JSON.stringify({apiKey,serverUrl}));
"
```

---

## STEP 1 — Fetch all data sources

Run both calls with the Bash tool:

**Emails (last 48h, external only):**
```bash
curl -s -H "X-API-KEY: <apiKey>" "<serverUrl>/api/tasks/email-data"
```

**HubSpot + meeting next steps:**
```bash
curl -s -H "X-API-KEY: <apiKey>" "<serverUrl>/api/tasks/hubspot-data"
```

Tell the user: "X emails found, Y HubSpot tasks, Z inactive deals."

---

## STEP 2 — Analyze emails

For each email, decide if it warrants a task. Create a task if ANY of:
- The email is from an external contact and I haven't replied (is the last in a thread from someone else)
- The body contains an explicit ask, question, or request directed at me
- I previously said "I'll send", "I'll check", "I'll get back to you", "je vous envoie", etc.

Skip: newsletters, automated notifications, out-of-office, internal emails, read receipts.

---

## STEP 3 — Convert HubSpot + meeting data

**From `open_tasks`:** one task per item, `source: "hubspot"`, `hubspot_task_id: id`

**From `inactive_deals`** (no activity in 7+ days): task = "Follow up: [deal name]", `source: "hubspot"`, priority: medium

**From `upcoming_closes`** (closing within 7 days): task = "Prepare close: [deal name] — closes [date]", `source: "hubspot"`, priority: high

**From `meeting_next_steps`:** one task per next step, `source: "meeting"`, `related_to: company`

---

## STEP 4 — Post tasks to server

Build the task array (replace `__TASKS_JSON__` with actual array):

```bash
node -e "
var fs=require('fs'),path=require('path');
var env={};
try{fs.readFileSync(path.join(process.cwd(),'.env'),'utf8').split('\n').forEach(function(l){var m=l.match(/^([A-Z_0-9]+)=(.*)/);if(m)env[m[1]]=m[2].trim();});}catch(e){}
var apiKey=process.env.QD_API_KEY||env.QD_API_KEY||'';
var serverUrl=(process.env.SERVER_URL||env.SERVER_URL||'http://localhost:3333').replace(/\/$/,'');
var tasks=__TASKS_JSON__;
var http=require('http');
var body=JSON.stringify(tasks);
var opts={hostname:'localhost',port:3333,path:'/api/tasks',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-API-KEY':apiKey}};
var req=http.request(opts,function(r){var d='';r.on('data',function(c){d+=c;});r.on('end',function(){console.log(d);});});
req.write(body);req.end();
"
```

Each task object must follow this schema:
```json
{
  "id": "task_<timestamp>_<index>",
  "status": "todo",
  "source": "email|meeting|hubspot",
  "title": "Short action title",
  "body": "Context or details (1-2 sentences)",
  "related_to": "Company or person name",
  "due_date": "YYYY-MM-DD or null",
  "priority": "high|medium|low",
  "hubspot_task_id": "HubSpot task id if source=hubspot, else null",
  "email_thread_id": "conversation_id if source=email, else null",
  "created_at": "<current ISO timestamp>"
}
```

---

## STEP 5 — Start server + open tasks view

```powershell
$running = netstat -ano 2>$null | Select-String ":3333"
if (-not $running) {
  $proj = Get-Location
  Start-Process node -ArgumentList (Join-Path $proj "server.js") -WorkingDirectory $proj -WindowStyle Hidden
  Start-Sleep -Seconds 2
}
Start-Process "http://localhost:3333"
```

Tell the user:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ DONE
Tasks generated  : X
  📧 Email       : X
  🎯 Meeting     : X
  💼 HubSpot     : X
Open the Tasks tab at http://localhost:3333
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
