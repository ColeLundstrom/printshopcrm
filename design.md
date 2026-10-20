# Design — PrintShopCRM

Modern-minimal workbench. Existing routes and workflows stay intact. A new shop can work manually; AI and automation are optional.

## Locked system
Use the light and dark palettes in public/css/app.css: --bg, --bg-2, --panel, --panel-2, --txt, --txt-2, --txt-3, --line, --accent, --accent-ink. Use --mono for code and the existing system sans-serif stack for UI. No external font dependency. Body --fs-md, labels --fs-sm, section titles --fs-lg, page titles --fs-2xl. Use the existing --sp-1 through --sp-11 four-point spacing ramp and --r-sm/--r-md radii.

## Layout
Task-first. A shop arrives wanting to do one thing ("make a mockup"), so the product leads with verbs, not a feature map.
- Home opens on "What do you want to do?": big tiles for Make an estimate, Make a mockup, Automatic follow-ups, then smaller ones (public/js/shared/tasks.js). The "Needs you today" queue follows; the numbers come last.
- The top bar's New button opens the same tiles on every screen.
- Each tile lands on a guided screen that asks one question at a time (#/do/estimate, #/do/mockup, #/auto-follow-ups), never on a blank form. Power editors stay one click away ("Use the full editor", "Custom rules").
- The sidebar shows only the everyday screens: Home, Customers, Estimates, Jobs, Invoices, Messages, Auto follow-ups. Every other route sits under "All tools"; Setup and Settings are pinned at the foot. Name things the way a shop talks ("Who owes you", not "Follow-ups"; "Sent mail", not "Outbox").
- Adding a screen: put it under All tools unless a shop uses it every day. Adding a task: add it to TASKS with a guided landing page.

Tables for records; ordered rows for setup. Setup leads with shop details, importing, email and SMS. Optional agent connections follow. Settings retain every existing control with section navigation. Direct links to every route remain valid.

## Interaction
Primary action uses the existing filled accent button, secondary actions use borders. Clear verbs, visible labels, no novelty icons or decorative art. Saved credentials never imply verified delivery. Empty states explain the next action. Advanced controls disclose without losing entered values. Keyboard focus uses --ring, touch targets --tap. No reveal animations; respect reduced motion. Never animate financial values.

## Responsive
One column on phones; min-width:0 and minmax(0,1fr) on flexible grids. Tables scroll in their own region. Check 320, 375, 414 and 768 CSS pixels. Use existing accessible modal and leave guards. Never conceal unsaved changes.

## Pages
- assistant: existing assistant workflow.
- onboarding: existing onboarding workflow.
- quote: existing quote workflow.
- books: existing books workflow.
- followups: existing followups workflow.
- orders: existing orders workflow.
- products: existing products workflow.
- roi: existing roi workflow.
- capacity: existing capacity workflow.
- board: existing board workflow.
- autopilot: existing autopilot workflow.
- misc: existing misc workflow.
- intake: existing intake workflow.
- matrices: existing matrices workflow.
- estimates: existing estimates workflow.
- billing: existing billing workflow.
- contacts: existing contacts workflow.
- gangsheet: existing gangsheet workflow.
- developers: existing developers workflow.
- dtfresize: existing dtfresize workflow.
- invoices: existing invoices workflow.
- conversations: existing conversations workflow.
- admin: existing admin workflow.
- automations: existing automations workflow.
- today: Home — task tiles, then the needs-you queue, then the pulse.
- do-estimate: guided estimate (customer → what they want, priced live → send).
- do-mockup: pick or start an order, then the mockup composer.
- auto-followups: plain-English switches over the starter automation rules.
- dashboard: existing dashboard workflow.
- search: existing search workflow.
- scan: existing scan workflow.
- reorder: existing reorder workflow.
- pricing: existing pricing workflow.
- agent: existing agent workflow.
- pipeline: existing pipeline workflow.
