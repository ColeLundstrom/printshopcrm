# ScreenPrintAI reference review — 2026-09-04

Cole requested a read-only review of MerchTroop's ScreenPrintAI, clarified that ideas must be improved rather than copied, and excluded his separate event business. He reported unreliable mockups, incomplete separation quality and digitizing that never really worked.

Inspected the deployed portal's README, separation audit notes and mockup UI source over read-only SSH. The source includes placement-side inputs, art uploads, width/height measurements and operator-adjustment protection. Its internal audit claims numerous separation capabilities but also acknowledges unproven photoreal results and lack of independent production validation. Those claims are not acceptance evidence and no portal code or live data has been copied into PrintShopCRM.

Candidate work for a separate verified implementation:

- Artwork preflight tied to requested print dimensions: source dimensions, resolution warnings, file validity and transparent-background preview. Clearly distinguish measured facts from visual judgement.
- Reproducible proof composition with uploaded artwork, explicit placement/scale, saved versions and approvals. Avoid generative changes to customer logos and retain operator adjustments.
- Embroidery file handoff: retain supplied stitch files, stitch-count metadata, digitizer notes, sew-out proof and approval. Do not market automatic production-ready digitizing without file validation and real sew-outs.
- Separation experiments need representative source/output comparisons, measurable export checks and physical press validation. Keep experimental results out of automatic production approval.

Outstanding user priority: Rosie-style optional agent operation from Slack on a phone. Existing Autopilot has Review/Auto screens; the built-in Slack integration produces quote drafts through /quote or mentions. Broad conversational tool use, user/role binding, reliable multi-turn clarification and action review remain to be improved. Existing model/API setup does not by itself make this a complete Slack shop operator.

No event staffing, event billing or event-specific workflows are proposed for PrintShopCRM.
