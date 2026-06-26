# Quinta Meeting → HubSpot Deal Agent

This project lets you scan your recent Teams meetings, analyze transcripts, and create HubSpot deals with your approval — all from Claude Code.

## Configuration

Set these as environment variables (locally via `.env`, on Render via the dashboard):

```
HUBSPOT_TOKEN=<your HubSpot private app token>
HUBSPOT_OWNER_ID=<your HubSpot owner ID>
QD_USER=quinta
QD_PASS=<your chosen password>
QD_API_KEY=<random secret for agent-to-server calls>
```

To find your HubSpot owner ID: HubSpot → Settings → Users & Teams → click your name → ID is in the URL.

## Pipelines

| Name    | Pipeline ID  | First Stage ID   | Use for                  |
|---------|-------------|------------------|--------------------------|
| sales   | default      | appointmentscheduled | New prospects          |
| upsell  | 310802926    | 495554527        | Existing clients, new products |
| cs      | 14338264     | 48953307         | Account management / CS  |

## Internal domains (skip if all attendees are internal)
- quinta.im
- quicktext.im

## Usage

Run the slash command from any Claude Code session:

```
/meeting-deals
```

This will:
1. Scan your calendar for the last 2 hours of Teams meetings
2. Fetch and analyze transcripts
3. Show you deal drafts one by one
4. Ask for your confirmation before creating each deal in HubSpot

## Requirements

- Microsoft 365 MCP server configured in Claude Code (for calendar + transcripts)
- Internet access for HubSpot API calls (via Bash tool)

## MS365 MCP Setup

Ask your admin for the Microsoft 365 MCP server URL, then run:

```bash
claude mcp add microsoft365 --transport sse <MS365_MCP_URL>
```

Or if using a local MS365 MCP server:

```bash
claude mcp add microsoft365 npx @modelcontextprotocol/server-microsoft365
```
