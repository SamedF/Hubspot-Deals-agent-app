# Quinta Meeting → HubSpot Deal Agent (Claude Code)

Scan your Teams meetings, analyze transcripts, and create HubSpot deals — directly from Claude Code with your approval at each step.

---

## Prerequisites

1. **Claude Code** installed (`npm install -g @anthropic-ai/claude-code`)
2. **Microsoft 365 MCP** configured in Claude Code (for calendar + transcript access)

---

## Setup

### 1. Clone this project

Copy this folder to your machine and open it in Claude Code:

```bash
cd quinta-meeting-deals-cc
claude
```

### 2. Configure Microsoft 365 MCP

You need the MS365 MCP server to access your Teams meetings and transcripts.

**Option A — Cowork remote MCP** (ask Akram for the server URL):
```bash
claude mcp add microsoft365 --transport sse <MS365_MCP_URL>
```

**Option B — Local MS365 MCP server**:
```bash
claude mcp add microsoft365 npx @modelcontextprotocol/server-microsoft365
```

Verify it's working:
```bash
claude mcp list
```

### 3. Set your HubSpot owner ID

Open `CLAUDE.md` and replace `<your HubSpot owner ID>` with your actual ID.

To find it: HubSpot → Settings → Users & Teams → click your name → the number at the end of the URL.

---

## Usage

Start Claude Code from the project folder:

```bash
claude
```

Then run the slash command:

```
/meeting-deals
```

Claude will:
1. Scan your calendar for the last 2 hours of Teams meetings
2. Fetch and analyze transcripts
3. Show you each deal draft with full summary + next steps
4. Ask **yes / no / edit** before creating anything
5. Create approved deals directly in HubSpot via API
6. Print the HubSpot deal link

---

## Notes

- You must be the **meeting organizer** to access the transcript
- Only meetings with at least one external attendee are processed
- 403 on transcript = reconnect your MS365 connector (`claude mcp remove microsoft365` then re-add)
- The HubSpot API token in CLAUDE.md is shared for the whole Quinta team
