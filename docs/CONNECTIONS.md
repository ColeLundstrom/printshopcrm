# Connect your shop

Open **Setup & connections** from the sidebar. Every core workflow works without an AI model or model API key. Staff can work from Today; owners and managers connect services.

## Email on your domain

Use the email wizard to choose Google Workspace or enter your mailbox provider’s SMTP settings. Enter an authorized From address and supported SMTP/app password. Google presets fill the server, port and TLS settings; other providers use the advanced server section. Save and send a test to your own shop or sign-in email. Saving credentials alone does not verify delivery.

Follow your email provider’s SPF, DKIM and DMARC instructions. Do not guess DNS values or replace existing mail routing. Some providers or account policies disable password-based SMTP; those need a supported SMTP service or a future OAuth mailbox connector. Outgoing SMTP is implemented. Replies reach the existing mailbox; automatic mailbox synchronization into Conversations is still a roadmap item.

Google’s current guidance: https://support.google.com/a/answer/176600

## Twilio SMS

Save your own Account SID, Auth Token and SMS-capable number (or Messaging Service SID). Test outgoing SMS to your shop phone. Under Setup → Receive texts, copy the exact incoming URL. In Twilio’s number configuration choose **A message comes in → Webhook → HTTP POST**, paste it, and save. For a Messaging Service, use its inbound handling configuration and the correct service SID. Complete Twilio’s applicable account/number registration.

A public HTTPS deployment is required for real callbacks. Set `PSC_PUBLIC_URL` to its canonical origin. Incoming callbacks use the shop’s credentials, verify all form fields with `X-Twilio-Signature`, require matching account and destination, and atomically record the MessageSid receipt with the inbox message. Retries are idempotent across restarts. Suspended shops are rejected. Billing expiry does not discard a customer’s incoming text.

Known senders match a normalized phone. New or ambiguous numbers produce a contact to review. SMS bodies go into Conversations as unread messages. MMS attachment counts are identified; attachments are not fetched. No model, reply, or marketing automation is invoked.

Twilio protocol references: https://www.twilio.com/docs/messaging/guides/webhook-request and https://www.twilio.com/docs/usage/security

## Optional Slack and agents

The built-in Slack connection creates quote drafts. Copy its app manifest from Settings → Slack, install it in your workspace, save its bot token and signing secret, and run the connection test. See https://docs.slack.dev/app-manifests/ . The synthetic callback test verifies reachability with the stored secret; only a real Slack event verifies that the stored secret actually matches Slack’s copy.

An existing external agent can use the shop REST API while keeping its own Slack/model runtime. Setup provides the base URL, request headers, connection test and documentation. A new agent key is read-only. Owners/managers can enable read-and-write access explicitly. This is a shop-wide policy for its single API key, including any other integrations sharing it. Existing keys retain their previous access for compatibility. Revoking or rotating a key invalidates it. Granular per-agent keys and OAuth installation are future work.

Keep the PrintShopCRM key in the agent runtime’s secret storage. It is not a model-provider key. Test with GET /api/v1/me. Read-only keys cannot invoke mutations, even when a valid owner browser cookie accompanies the request. External agents must implement their own workspace/user permissions and approval policy. This connector does not install or host an external agent.

Use **Work manually** to turn off model selection and require human review in assisted workflows. Independently configured automation rules remain separately controlled in Automations.
