# Optional Slack shop assistant

The CRM works fully through its web UI without AI or Slack. The optional assistant lets linked employees read job details and department queues, draft estimates, complete tasks, assign employees, and change production dates. It starts disabled. Existing legacy Slack quote behavior remains until a manager enables the assistant.

## Setup

1. Use Setup & connections → Slack to install the supplied Slack app configuration, save the bot token and signing secret, and pass the connection test at the shop’s public HTTPS address. The local demo deliberately blocks external services.
2. Open Slack shop assistant from Setup or the Slack settings card. Link each employee’s Slack member ID to an active shop account. No employee passwords are shared with Slack.
3. Choose Review or Auto. Review asks for a one-time confirmation before a supported write; Auto performs supported writes immediately. Both enforce the same role and production rules. Managers create drafts, assign work and reschedule; staff can complete their own or unassigned tasks when existing gates permit.
4. Optionally configure the shop’s supported model connection in AI settings for natural-language routing. Explicit commands below need no model. This does not install an arbitrary third-party agent or give it unrestricted access.

Use a DM for customer information. Channel replies are visible to channel members; mention the bot for every channel-thread follow-up. DM history stays with the same employee and channel. Supported commands include:

- `find Wildcats`
- `job JOB-1001`
- `queue QC` or `my tasks`
- `quote 48 navy tees, 2 color front, customer@example.com`
- `complete task 12 on JOB-1001`
- `schedule JOB-1001 2026-09-15`
- `assign task 12 on JOB-1001 to 7`
- `confirm <code>` or `cancel`

Use actual job/task/employee IDs returned by the assistant. Confirmation expires after 10 minutes and belongs to that employee and conversation. Job revision changes invalidate prepared task/date changes. Removing a link, disabling the assistant or deactivating the employee prevents new actions; identity is checked again after asynchronous model/supplier work. Credential changes require a new connection test.

## Quote behavior and boundaries

Quote commands create **new draft estimates**, not edits to existing estimates. They use the existing shop pricing engine and optional supplier lookup. The router cannot supply invented prices or rewrite order facts. `make that 96` can replace the leading quantity in a preceding simple quote without a size breakdown. Other incomplete revisions ask for the complete updated order; automatic complex multi-turn order merging is not claimed.

Drafts may use the shop’s existing garment, size, decoration, blank-price and tax defaults when facts are missing. A manager must review those assumptions before sending. The assistant never sends customer messages, charges cards, records payments or approves artwork. New-contact automation is suppressed for its draft creation; legacy quick-quote callers retain their prior automation behavior.

The assistant acknowledges signed Slack deliveries before doing background work. Persistent request receipts prevent blindly repeating interrupted writes, and in-process locks serialize each employee conversation. A crash or failed Slack reply can leave an uncertain outcome: inspect the draft/job before retrying. This is not an exactly-once queue or automatic recovery system. History is limited to 12 turns per conversation; stored conversation/request rows currently have no automatic retention purge.

## Verification

Synthetic tests cover signed DM delivery, duplicate events, wrong signatures/workspaces, employee links and revocation, role restrictions, confirmation scope, stale revisions, production holds, actual 96-piece fallback pricing, no contact-automation emission, revocation before database writes, and credential-rotation invalidation. All outbound Slack calls are intercepted in tests; no real Slack message, merchant transaction or model request is sent.

Still requires a real installed shop bot and model configuration acceptance test. Live Slack latency, provider response quality and physical production outcomes are not established by fixture tests.

Protocol references: [Slack Events API](https://docs.slack.dev/apis/events-api/), [app mentions](https://docs.slack.dev/reference/events/app_mention/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).
