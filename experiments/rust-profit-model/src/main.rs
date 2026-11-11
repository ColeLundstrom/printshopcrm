// SPDX-License-Identifier: AGPL-3.0-or-later
// Modified 2026-10-10: isolated compatibility-test transport, not a web service.
use std::io::{self, BufRead};
use printshopcrm_pricing_poc::{monthly_cents, quote_cents};

fn main() {
    for line in io::stdin().lock().lines() {
        let line = match line { Ok(value) => value, Err(error) => { eprintln!("{error}"); std::process::exit(1); } };
        let values: Vec<&str> = line.split('\t').collect();
        match values.first().copied() {
            Some("quote") if values.len() == 14 => {
                let fields: [&str; 13] = values[1..].try_into().expect("checked field count");
                match quote_cents(fields) {
                    Ok(value) => println!("OK\t{}\t{}", value.minimum_unit_cents, value.sell_total_cents),
                    Err(error) => println!("ERR\t{error:?}"),
                }
            }
            Some("month") if values.len() == 6 => {
                let fields: [&str; 5] = values[1..].try_into().expect("checked field count");
                match monthly_cents(fields) {
                    Ok(value) => println!("OK\t{}\t{}", value.break_even_sales_cents, value.target_sales_cents),
                    Err(error) => println!("ERR\t{error:?}"),
                }
            }
            _ => println!("ERR\tInvalidInput"),
        }
    }
}
