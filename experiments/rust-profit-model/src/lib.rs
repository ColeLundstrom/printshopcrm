// SPDX-License-Identifier: AGPL-3.0-or-later
// Modified 2026-10-10: Rust compatibility experiment based on PrintShopCRM's
// public/js/shared/profit-planning.js at 7b3d654ada5f94e224269c11701424612425ba62.
// This preserves provenance; changing implementation language is not relicensing.
//! A bounded, dependency-free experiment, NOT a drop-in replacement for the CRM.
//! Input is the canonical decimal spelling of nonnegative JavaScript numbers.
//! Uses checked u128 rational arithmetic, rejecting values/intermediates it cannot
//! represent. The original JavaScript BigInt model has a broader numeric range.
//! Only authoritative quote/monthly sales cents are returned. No tax, freight,
//! provider fees beyond entered percentage/flat values, persistence, or side effects.

const MAX_SAFE_CENTS: u128 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelError {
    InvalidInput,
    InvalidBoundary,
    ArithmeticRange,
    UnsafeCents,
}
type Result<T> = std::result::Result<T, ModelError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ratio { n: u128, d: u128 }

fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 { let remainder = a % b; a = b; b = remainder; }
    a
}
fn checked_mul(a: u128, b: u128) -> Result<u128> {
    a.checked_mul(b).ok_or(ModelError::ArithmeticRange)
}
fn checked_add(a: u128, b: u128) -> Result<u128> {
    a.checked_add(b).ok_or(ModelError::ArithmeticRange)
}

impl Ratio {
    fn new(n: u128, d: u128) -> Result<Self> {
        if d == 0 { return Err(ModelError::InvalidBoundary); }
        let factor = gcd(n, d);
        Ok(Self { n: n / factor, d: d / factor })
    }
    fn integer(n: u128) -> Self { Self { n, d: 1 } }
    fn parse(raw: &str) -> Result<Self> {
        // A bounded parser, not a permissive float-to-money conversion.
        if raw.is_empty() || raw.len() > 256 || raw.trim() != raw {
            return Err(ModelError::InvalidInput);
        }
        let mut exponent_parts = raw.split(['e', 'E']);
        let coefficient = exponent_parts.next().ok_or(ModelError::InvalidInput)?;
        let exponent = match exponent_parts.next() {
            Some(value) => value.parse::<i32>().map_err(|_| ModelError::InvalidInput)?,
            None => 0,
        };
        if exponent_parts.next().is_some() { return Err(ModelError::InvalidInput); }
        let mut decimal_parts = coefficient.split('.');
        let whole = decimal_parts.next().ok_or(ModelError::InvalidInput)?;
        let fractional = decimal_parts.next().unwrap_or("");
        if whole.is_empty() || decimal_parts.next().is_some()
            || !whole.bytes().chain(fractional.bytes()).all(|b| b.is_ascii_digit()) {
            return Err(ModelError::InvalidInput);
        }
        let digits = format!("{whole}{fractional}").parse::<u128>()
            .map_err(|_| ModelError::ArithmeticRange)?;
        if digits == 0 { return Ok(Self::integer(0)); }
        let places = (fractional.len() as i32).checked_sub(exponent)
            .ok_or(ModelError::ArithmeticRange)?;
        if !(-38..=38).contains(&places) { return Err(ModelError::ArithmeticRange); }
        let scale = 10_u128.checked_pow(places.unsigned_abs())
            .ok_or(ModelError::ArithmeticRange)?;
        if places >= 0 { Self::new(digits, scale) }
        else { Self::new(checked_mul(digits, scale)?, 1) }
    }
    fn add(self, rhs: Self) -> Result<Self> {
        let common = gcd(self.d, rhs.d);
        let left = checked_mul(self.n, rhs.d / common)?;
        let right = checked_mul(rhs.n, self.d / common)?;
        Self::new(checked_add(left, right)?, checked_mul(self.d, rhs.d / common)?)
    }
    fn sub(self, rhs: Self) -> Result<Self> {
        let common = gcd(self.d, rhs.d);
        let left = checked_mul(self.n, rhs.d / common)?;
        let right = checked_mul(rhs.n, self.d / common)?;
        Self::new(left.checked_sub(right).ok_or(ModelError::InvalidBoundary)?,
                  checked_mul(self.d, rhs.d / common)?)
    }
    fn mul(self, rhs: Self) -> Result<Self> {
        let a = gcd(self.n, rhs.d);
        let b = gcd(rhs.n, self.d);
        Self::new(checked_mul(self.n / a, rhs.n / b)?,
                  checked_mul(self.d / b, rhs.d / a)?)
    }
    fn div(self, rhs: Self) -> Result<Self> {
        if rhs.n == 0 { return Err(ModelError::InvalidBoundary); }
        self.mul(Self { n: rhs.d, d: rhs.n })
    }
    fn ceil_cents(self) -> Result<u128> {
        let cents = self.mul(Self::integer(100))?;
        let floor = cents.n / cents.d;
        checked_add(floor, u128::from(cents.n % cents.d != 0))
    }
    fn below(self, limit: u128) -> Result<bool> {
        Ok(self.n < checked_mul(limit, self.d)?)
    }
}

fn safe_cents(value: u128) -> Result<u64> {
    if value > MAX_SAFE_CENTS { return Err(ModelError::UnsafeCents); }
    Ok(value as u64)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuoteCents {
    pub minimum_unit_cents: u64,
    pub sell_total_cents: u64,
}

/// Fields, in order: quantity, garment_cost, consumable_cost, spoilage_pct,
/// setup_minutes, output_hour, machine_rate, labor_rate, overhead_rate,
/// other_cost, payment_pct, payment_flat, target_margin_pct.
/// One operation; spoilage increases material budget, not run time or purchase count.
pub fn quote_cents(fields: [&str; 13]) -> Result<QuoteCents> {
    let mut v = [Ratio::integer(0); 13];
    for (slot, raw) in v.iter_mut().zip(fields) { *slot = Ratio::parse(raw)?; }
    let [quantity, garment, consumable, spoilage, setup, output,
        machine, labor, overhead, other, percentage, flat, margin] = v;
    if quantity.d != 1 || quantity.n == 0 || quantity.n > MAX_SAFE_CENTS || output.n == 0 {
        return Err(ModelError::InvalidBoundary);
    }
    if spoilage.n > checked_mul(100, spoilage.d)? || !percentage.below(100)? || !margin.below(100)? {
        return Err(ModelError::InvalidBoundary);
    }
    let hundred = Ratio::integer(100);
    let retained = Ratio::integer(1).sub(percentage.add(margin)?.div(hundred)?)?;
    if retained.n == 0 { return Err(ModelError::InvalidBoundary); }
    let material_units = quantity.mul(Ratio::integer(1).add(spoilage.div(hundred)?)?)?;
    let hours = setup.div(Ratio::integer(60))?.add(quantity.div(output)?)?;
    let material_cost = material_units.mul(garment.add(consumable)?)?;
    let time_cost = hours.mul(machine.add(labor)?.add(overhead)?)?;
    let cost = material_cost.add(time_cost)?.add(other)?;
    let unit = cost.add(flat)?.div(retained)?.div(quantity)?.ceil_cents()?;
    let total = checked_mul(unit, quantity.n)?;
    Ok(QuoteCents { minimum_unit_cents: safe_cents(unit)?, sell_total_cents: safe_cents(total)? })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonthlyCents {
    pub break_even_sales_cents: u64,
    pub target_sales_cents: u64,
}

/// Fields: fixed_cost_month, variable_cost_pct, target_profit_month,
/// forecast_revenue, productive_hours_month. Forecast is validated but its
/// potentially negative modeled profit is outside this cents-only experiment.
pub fn monthly_cents(fields: [&str; 5]) -> Result<MonthlyCents> {
    let mut v = [Ratio::integer(0); 5];
    for (slot, raw) in v.iter_mut().zip(fields) { *slot = Ratio::parse(raw)?; }
    let [fixed, variable, profit, _forecast, hours] = v;
    if hours.n == 0 || !variable.below(100)? { return Err(ModelError::InvalidBoundary); }
    let contribution = Ratio::integer(1).sub(variable.div(Ratio::integer(100))?)?;
    Ok(MonthlyCents {
        break_even_sales_cents: safe_cents(fixed.div(contribution)?.ceil_cents()?)?,
        target_sales_cents: safe_cents(fixed.add(profit)?.div(contribution)?.ceil_cents()?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> [&'static str; 13] {
        ["100", "4", "1", "5", "30", "100", "20", "30", "10", "5", "3", "0.3", "40"]
    }
    #[test] fn familiar_quote() {
        assert_eq!(quote_cents(base()).unwrap(), QuoteCents { minimum_unit_cents: 1089, sell_total_cents: 108900 });
    }
    #[test] fn exact_decimal_rounding() {
        let mut q = ["1", "0.1", "0.2", "0", "0", "100", "0", "0", "0", "0", "0", "0", "0"];
        assert_eq!(quote_cents(q).unwrap().minimum_unit_cents, 30);
        q[1] = "0.100000000000001";
        assert_eq!(quote_cents(q).unwrap().minimum_unit_cents, 31);
        q[1] = "0"; q[2] = "0"; q[0] = "3"; q[9] = "1";
        assert_eq!(quote_cents(q).unwrap().sell_total_cents, 102);
    }
    #[test] fn invalid_boundaries_fail_closed() {
        for (index, bad) in [(0, "0"), (0, "1.5"), (5, "0"), (3, "100.01"), (10, "100"), (12, "97")] {
            let mut q = base(); q[index] = bad; assert!(quote_cents(q).is_err());
        }
        let mut q = base(); q[10] = "0.1"; q[12] = "99.9";
        assert_eq!(quote_cents(q), Err(ModelError::InvalidBoundary));
    }
    #[test] fn zero_and_scientific_decimals() {
        assert_eq!(Ratio::parse("0e-324").unwrap(), Ratio::integer(0));
        assert_eq!(Ratio::parse("1e+2").unwrap(), Ratio::integer(100));
        assert_eq!(Ratio::parse("1e-3").unwrap(), Ratio::new(1, 1000).unwrap());
        assert_eq!(Ratio::parse("5e-324"), Err(ModelError::ArithmeticRange));
    }
    #[test] fn malformed_input_rejected() {
        for bad in ["", "NaN", "Infinity", "-1", " 1", "1 ", "1e", "1e2e3", "1.2.3", "."] {
            assert!(Ratio::parse(bad).is_err(), "{bad}");
        }
    }
    #[test] fn monthly_thresholds() {
        assert_eq!(monthly_cents(["6000", "40", "3000", "20000", "120"]).unwrap(),
            MonthlyCents { break_even_sales_cents: 1_000_000, target_sales_cents: 1_500_000 });
    }
    #[test] fn monetary_limit_enforced() {
        let mut q = base(); q[9] = "1e14";
        assert_eq!(quote_cents(q), Err(ModelError::UnsafeCents));
    }
}

