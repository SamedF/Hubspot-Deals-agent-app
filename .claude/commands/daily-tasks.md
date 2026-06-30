# Generate daily tasks from emails, meetings, and HubSpot

Scans the last 48–72 hours of communications across three sources — Microsoft 365 emails, Microsoft Teams chat messages, and HubSpot (emails logged in the CRM) — plus meeting next steps, to produce a prioritized follow-up task list.

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

**Office 365 emails + Teams chats (last 48h):**
```bash
curl -s -H "X-API-KEY: <apiKey>" "<serverUrl>/api/tasks/email-data"
```
Returns: `{ emails: [...], teams_messages: [...] }`

**HubSpot emails + meeting next steps (last 72h):**
```bash
curl -s -H "X-API-KEY: <apiKey>" "<serverUrl>/api/tasks/hubspot-data"
```
Returns: `{ emails: [...], meeting_next_steps: [...] }`

Tell the user: "X Office 365 emails, Y Teams messages, Z HubSpot emails, W meeting next steps."

---

## STEP 2 — Analyze all communications

Apply the same follow-up logic to all three sources. Create a task if ANY of:
- An external contact sent a message and has not received a reply (their message is the last in the exchange)
- The message body contains an explicit ask, question, or request directed at me
- I (or a colleague) wrote "I'll send", "I'll check", "I'll get back to you", "je vous envoie", "je reviens vers vous", "I'll follow up", "on va vous envoyer", etc. — and no follow-up is visible
- A prospect or client hasn't heard back after an initial outreach

**Teams-specific rules** (use `chat_type` field):
- `oneOnOne` chats: treat like an email thread — look for unanswered messages or open commitments
- `group` chats: only flag if someone directly asked me a question or I made a commitment
- `meeting` chats: look for action items discussed during the meeting

**HubSpot email direction** (`direction` field):
- `INCOMING_EMAIL` = received from a contact → check if unanswered
- `EMAIL` = sent by us → check if it contained a commitment with no follow-up visible

Skip: automated notifications, out-of-office replies, internal-only exchanges (quinta.im / quicktext.im), read receipts, booking confirmations, system messages.

Deduplicate: if the same thread appears in both Office 365 and HubSpot, create only one task.

---

## STEP 3 — Convert meeting next steps

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
  "source": "email|teams|hubspot-email|meeting",
  "title": "Short action title (e.g. 'Reply to Jean-Pierre re: pricing')",
  "body": "Context or details (1-2 sentences)",
  "related_to": "Company or person name",
  "due_date": "YYYY-MM-DD or null",
  "priority": "high|medium|low",
  "hubspot_email_id": "HubSpot email object id if source=hubspot-email, else null",
  "email_thread_id": "conversation_id if source=email, else null",
  "teams_chat_id": "chat_id if source=teams, else null",
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
Tasks generated      : X
  📧 Office 365      : X
  💬 Teams chats     : X
  💼 HubSpot emails  : X
  🎯 Meeting steps   : X
Open the Tasks tab at http://localhost:3333
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
