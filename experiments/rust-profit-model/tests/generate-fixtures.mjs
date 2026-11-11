// SPDX-License-Identifier: AGPL-3.0-or-later
// Modified 2026-10-10. Generates fictional arithmetic inputs; no shop data.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

if (!process.argv[2]) throw new Error('Pass the existing profit-planning.js path.');
const modelPath = resolve(process.argv[2]);
const { calculateProfitQuote, calculateBreakEven } = await import(pathToFileURL(modelPath));
const root = dirname(fileURLToPath(import.meta.url));
const quoteFields = ['quantity', 'garment_cost', 'consumable_cost', 'spoilage_pct', 'setup_minutes', 'output_hour', 'machine_rate', 'labor_rate', 'overhead_rate', 'other_cost', 'payment_pct', 'payment_flat', 'target_margin_pct'];
const monthFields = ['fixed_cost_month', 'variable_cost_pct', 'target_profit_month', 'forecast_revenue', 'productive_hours_month'];
const quote = changes => ({ quantity: 100, garment_cost: 4, consumable_cost: 1, spoilage_pct: 5, setup_minutes: 30, output_hour: 100, machine_rate: 20, labor_rate: 30, overhead_rate: 10, other_cost: 5, payment_pct: 3, payment_flat: 0.3, target_margin_pct: 40, ...changes });
const monthly = changes => ({ fixed_cost_month: 6000, variable_cost_pct: 40, target_profit_month: 3000, forecast_revenue: 20000, productive_hours_month: 120, ...changes });
const rows = [];
function add(kind, input) {
  const fields = kind === 'quote' ? quoteFields : monthFields;
  let expected;
  try {
    if (kind === 'quote') {
      const value = calculateProfitQuote(input);
      expected = ['OK', value.minimum_unit_cents, value.sell_total_cents];
    } else {
      const value = calculateBreakEven(input);
      expected = ['OK', Math.round(value.break_even_sales * 100), Math.round(value.target_sales * 100)];
    }
  } catch { expected = ['ERR']; }
  rows.push([kind, ...fields.map(field => String(input[field])), ...expected].join('\t'));
}

add('quote', quote());
const pennies = quote({ quantity: 1, garment_cost: 0.1, consumable_cost: 0.2, spoilage_pct: 0, setup_minutes: 0, machine_rate: 0, labor_rate: 0, overhead_rate: 0, other_cost: 0, payment_pct: 0, payment_flat: 0, target_margin_pct: 0 });
add('quote', pennies);
add('quote', { ...pennies, garment_cost: 0.100000000000001 });
add('quote', { ...pennies, quantity: 3, garment_cost: 0, consumable_cost: 0, other_cost: 1 });
add('quote', { ...pennies, garment_cost: 0, consumable_cost: 0, output_hour: 3, machine_rate: 0.9 });
add('quote', { ...pennies, garment_cost: 0, consumable_cost: 0 });
add('quote', quote({ payment_pct: 0, target_margin_pct: 99.999 }));
for (const quantity of [1, 3, 12, 100, 1000]) for (const target_margin_pct of [0, 20, 40, 80, 96.99]) add('quote', quote({ quantity, target_margin_pct }));
for (const changes of [{ quantity: 0 }, { quantity: 1.5 }, { output_hour: 0 }, { spoilage_pct: 100.01 }, { payment_pct: 100 }, { target_margin_pct: 100 }, { target_margin_pct: 97 }, { payment_pct: 0.1, target_margin_pct: 99.9 }, { other_cost: 1e14 }]) add('quote', quote(changes));
for (const field of quoteFields) add('quote', quote({ [field]: -1 }));
let seed = 20261010;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const amount = max => Math.round(random() * max * 100) / 100;
for (let i = 0; i < 1000; i++) add('quote', quote({ quantity: 1 + Math.floor(random() * 10000), garment_cost: amount(100), consumable_cost: amount(10), spoilage_pct: amount(100), setup_minutes: amount(120), output_hour: 1 + amount(500), machine_rate: amount(200), labor_rate: amount(100), overhead_rate: amount(100), other_cost: amount(100), payment_pct: amount(5), payment_flat: amount(1), target_margin_pct: amount(90) }));
add('month', monthly());
for (const changes of [{ fixed_cost_month: 0, target_profit_month: 0 }, { fixed_cost_month: 0.1, variable_cost_pct: 0 }, { variable_cost_pct: 99.99 }, { productive_hours_month: 0 }, { variable_cost_pct: 100 }, { fixed_cost_month: -1 }, { fixed_cost_month: 1e14 }]) add('month', monthly(changes));
for (let i = 0; i < 300; i++) add('month', monthly({ fixed_cost_month: amount(100000), variable_cost_pct: amount(99), target_profit_month: amount(100000), forecast_revenue: amount(1000000), productive_hours_month: 1 + amount(1000) }));
writeFileSync(resolve(root, 'parity.tsv'), rows.join('\n') + '\n');
writeFileSync(resolve(root, 'fixture-provenance.json'), JSON.stringify({ generated_at: '2026-10-10', model_repo: 'https://github.com/ColeLundstrom/printshopcrm', model_commit: '7b3d654ada5f94e224269c11701424612425ba62', model_path: 'public/js/shared/profit-planning.js', model_sha256: createHash('sha256').update(readFileSync(modelPath)).digest('hex'), fixtures: rows.length, successful: rows.filter(row => row.includes('\tOK\t')).length, rejected: rows.filter(row => row.endsWith('\tERR')).length, seed: 20261010, scope: 'Authoritative quote unit/total cents and monthly sales-threshold cents only. Fictional input values. This is not full API, numeric-range, browser, database, or provider parity.' }, null, 2) + '\n');
console.log(`Generated ${rows.length} fixtures from ${modelPath}`);

