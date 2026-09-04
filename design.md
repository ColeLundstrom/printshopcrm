# Design — PrintShopCRM

Modern-minimal workbench. Existing routes and workflows stay intact. A new shop can work manually; AI and automation are optional.

## Locked system
Use the light and dark palettes in public/css/app.css: --bg, --bg-2, --panel, --panel-2, --txt, --txt-2, --txt-3, --line, --accent, --accent-ink. Use --mono for code and the existing system sans-serif stack for UI. No external font dependency. Body --fs-md, labels --fs-sm, section titles --fs-lg, page titles --fs-2xl. Use the existing --sp-1 through --sp-11 four-point spacing ramp and --r-sm/--r-md radii.

## Layout
App pages: persistent workflow navigation and one work area. Tables for records; ordered rows for setup. Today prioritizes actual work, with one obvious new-estimate action. Setup leads with shop details, importing, email and SMS. Optional agent connections follow. Settings retain every existing control with section navigation. More tools reveals specialist routes; direct links remain valid.

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
- today: existing today workflow.
- dashboard: existing dashboard workflow.
- search: existing search workflow.
- scan: existing scan workflow.
- reorder: existing reorder workflow.
- pricing: existing pricing workflow.
- agent: existing agent workflow.
- pipeline: existing pipeline workflow.
