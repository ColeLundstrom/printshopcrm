// SPDX-License-Identifier: AGPL-3.0-or-later
// Modified 2026-10-10: frozen, fictional oracle fixtures from the JavaScript model.
use printshopcrm_pricing_poc::{monthly_cents, quote_cents};

#[test]
fn matches_frozen_javascript_cents_and_rejections() {
    let mut count = 0;
    for (index, line) in include_str!("parity.tsv").lines().enumerate() {
        let parts: Vec<&str> = line.split('\t').collect();
        let (actual, expected_at) = match parts[0] {
            "quote" => {
                let values: [&str; 13] = parts[1..14].try_into().unwrap();
                (quote_cents(values).map(|v| (v.minimum_unit_cents, v.sell_total_cents)), 14)
            }
            "month" => {
                let values: [&str; 5] = parts[1..6].try_into().unwrap();
                (monthly_cents(values).map(|v| (v.break_even_sales_cents, v.target_sales_cents)), 6)
            }
            unknown => panic!("unknown fixture kind: {unknown}"),
        };
        if parts[expected_at] == "ERR" {
            assert!(actual.is_err(), "fixture {} should reject: {line}", index + 1);
        } else {
            let expected = (parts[expected_at + 1].parse::<u64>().unwrap(), parts[expected_at + 2].parse::<u64>().unwrap());
            assert_eq!(actual, Ok(expected), "fixture {}: {line}", index + 1);
        }
        count += 1;
    }
    assert_eq!(count, 1362, "fixture set must not silently shrink");
}
