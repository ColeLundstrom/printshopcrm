# Different decoration methods on one garment

In an estimate, enter the garment description and size quantities, then select **+ Decoration location** below that garment. Name the location (for example Left sleeve), enter the **garment-only selling price**, and choose a matrix. The garment price replaces the old all-in line rate; do not enter a price that already includes the decorations. Use decoration-only matrix prices.

Repeat for Front with an embroidery matrix, Back with DTF, or any custom method such as laser, patches or promo. Each location has its own matrix, row, column and price. All locations on a line apply to that line's entire quantity. Use separate garment lines when some pieces have different decoration combinations.

The line's rate is garment price plus all per-piece location prices. Flat matrix charges are added once to the extended amount. Garment quantities and extended-size upcharges are counted once. Customer-supplied mode removes both the garment charge and size upcharges; decoration charges and the quote's tax setting still apply. Separate ordinary fee/discount lines remain available.

Quantity matrices with recognized ascending rows (`12–23`, `24–47`, `48+`, or band minimums `12`, `24`, `48`) save the selected column's price bands on the quote. Changing quantity selects the matching saved band. An empty or missing band blocks saving. Non-quantity/custom rows, unrecognized band notation and deliberately selected nonmatching rows retain the selected price for the original quantity; quantity changes require **Edit / reprice**. Repricing loads the current matrix. Editing a shop matrix never rewrites an existing quote, approval or invoice.

The breakdown persists through save, customer/PDF display, approval revisions, invoice conversion, duplication and reorder. Changing a location invalidates an existing approval even when the total is unchanged. Historical lines without per-location pricing retain their existing behavior.

The quick screenprinting margin/capacity model cannot infer labor and machine costs for these combinations. Use recorded Job costing; selling prices are not production cost estimates. The older simplified `/api/v1` quote creator explicitly rejects this structure; the estimate editor and `/api/estimates` save endpoint support it. No model key is required.

Rollback note: older releases do not understand one-time charges inside `decoration_pricing`. Do not run a previous release against new composite documents. Restore a matching pre-upgrade snapshot only with an explicit decision about newer edits, or use a forward fix.
