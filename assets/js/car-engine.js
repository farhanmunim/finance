/**
 * Car finance engine (PCP and hire purchase). Pure functions, no DOM.
 *
 * Works backwards from a quote: given the cash price, deposit, term, monthly payment and any final
 * (balloon) payment, it finds the interest rate that makes the payments repay the amount borrowed.
 *
 * Timing follows the way UK quotes are laid out: monthly payments fall at the end of months 1..n
 * and the final payment at the end of the last month of the term. A 48-month PCP is usually
 * 47 monthly payments with the final payment in month 48, so n defaults to term - 1 when there is a
 * final payment and to the full term when there is not (hire purchase).
 *
 * The APR is the annual effective rate, (1 + monthly rate)^12 - 1, which is how the Consumer Credit
 * (Total Charge for Credit) rules define it. Fees count towards the APR but not the interest rate.
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Present value at monthly rate i of a list of [month, amount] cash flows. */
function presentValue(flows, i) {
  let pv = 0;
  for (const [m, a] of flows) pv += a / Math.pow(1 + i, m);
  return pv;
}

/**
 * Monthly rate i at which the cash flows repay `principal`. Returns 0 when the payments only just
 * cover the loan and a negative rate when they repay less than was borrowed (rare, but possible
 * with a dealer deposit contribution entered as part of the deposit).
 */
export function solveMonthlyRate(principal, flows) {
  const total = flows.reduce((s, [, a]) => s + a, 0);
  if (principal <= 0 || total <= 0) return 0;
  if (Math.abs(total - principal) < 1e-9) return 0;
  // PV falls as the rate rises; bracket and bisect (robust, and fast enough at 200 steps).
  let lo = total > principal ? 0 : -0.5, hi = total > principal ? 1 : 0;
  while (presentValue(flows, hi) > principal && hi < 100) hi *= 2;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (presentValue(flows, mid) > principal) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export const annualFromMonthly = (i) => Math.pow(1 + i, 12) - 1;
export const monthlyFromAnnual = (apr) => Math.pow(1 + apr, 1 / 12) - 1;

/** Number of monthly payments a term implies: one fewer than the term when a final payment replaces the last one. */
export function defaultPaymentCount(termMonths, finalPayment) {
  const t = Math.max(1, Math.round(num(termMonths)));
  return num(finalPayment) > 0 ? Math.max(1, t - 1) : t;
}

/**
 * Monthly payment needed to repay `principal` at monthly rate i, with `count` payments and a final
 * payment of `balloon` at month `term`.
 */
export function paymentFor(principal, i, count, balloon, term) {
  const left = principal - balloon / Math.pow(1 + i, term);
  if (count <= 0) return 0;
  if (Math.abs(i) < 1e-12) return left / count;
  const annuity = (1 - Math.pow(1 + i, -count)) / i;
  return left / annuity;
}

/**
 * Analyse a car finance quote.
 * @param {object} o
 * @param {number} o.price          cash price of the car
 * @param {number} o.deposit        customer deposit plus any part-exchange or dealer contribution
 * @param {number} o.termMonths     length of the agreement
 * @param {number} o.monthlyPayment
 * @param {number} [o.paymentCount] number of monthly payments (defaults from the term)
 * @param {number} [o.finalPayment] optional final / balloon payment, due in the last month
 * @param {number} [o.upfrontFee]   arrangement or acceptance fee, paid with the first payment
 * @param {number} [o.finalFee]     option-to-purchase fee, paid with the final payment
 */
export function analyse(o) {
  const price = num(o.price);
  const deposit = num(o.deposit);
  const term = Math.max(1, Math.min(120, Math.round(num(o.termMonths)) || 0));
  const monthly = num(o.monthlyPayment);
  const balloon = num(o.finalPayment);
  const upfrontFee = num(o.upfrontFee);
  const finalFee = num(o.finalFee);
  const count = Math.min(term, Math.max(1, Math.round(num(o.paymentCount)) || defaultPaymentCount(term, balloon)));
  const credit = round2(price - deposit);
  const warnings = [];

  if (!(price > 0)) return { ok: false, reason: 'price', warnings };
  if (credit <= 0) return { ok: false, reason: 'deposit', warnings: ['The deposit covers the whole price, so there is nothing to borrow.'] };
  if (!(monthly > 0)) return { ok: false, reason: 'monthly', warnings };

  const loanFlows = [];
  for (let m = 1; m <= count; m++) loanFlows.push([m, monthly]);
  if (balloon > 0) loanFlows.push([term, balloon]);
  const allFlows = loanFlows.map(([m, a]) => [m, a]);
  if (upfrontFee > 0) allFlows.push([1, upfrontFee]);
  if (finalFee > 0) allFlows.push([term, finalFee]);

  const monthlyTotal = round2(monthly * count);
  const repaid = round2(monthlyTotal + balloon); // excludes deposit and fees
  const fees = round2(upfrontFee + finalFee);
  const interest = round2(repaid - credit);
  const costOfCredit = round2(interest + fees);
  const totalPayable = round2(deposit + repaid + fees);

  const i = solveMonthlyRate(credit, loanFlows); // interest only
  const iAll = solveMonthlyRate(credit, allFlows); // interest and fees
  const years = term / 12;

  if (interest < -0.5) warnings.push('These payments add up to less than the amount borrowed. Check the figures, or this may be a 0% deal with a dealer contribution included in the deposit.');
  if (balloon > credit) warnings.push('The final payment is larger than the amount borrowed, which is unusual. Check the figures.');

  // Month-by-month balance using the interest rate (fees excluded, as lenders do).
  const schedule = [];
  let bal = credit;
  for (let m = 1; m <= term; m++) {
    const int = bal * i;
    const pay = (m <= count ? monthly : 0) + (m === term ? balloon : 0);
    bal = bal + int - pay;
    schedule.push({ month: m, interest: int, payment: pay, capital: pay - int, balance: Math.abs(bal) < 0.005 ? 0 : bal });
  }
  const yearly = [];
  for (let y = 0; y * 12 < term; y++) {
    const rows = schedule.slice(y * 12, y * 12 + 12);
    const feesThisYear = (upfrontFee && y === 0 ? upfrontFee : 0) + (finalFee && Math.ceil(term / 12) - 1 === y ? finalFee : 0);
    yearly.push({
      year: y + 1,
      months: rows.length,
      paid: rows.reduce((s, r) => s + r.payment, 0) + feesThisYear,
      interest: rows.reduce((s, r) => s + r.interest, 0),
      capital: rows.reduce((s, r) => s + r.capital, 0),
      fees: feesThisYear,
      balance: rows[rows.length - 1].balance,
    });
  }

  return {
    ok: true,
    warnings,
    price, deposit, credit, term, count, monthly, balloon, upfrontFee, finalFee, fees,
    finalMonth: term,
    monthlyTotal, repaid, interest, costOfCredit, totalPayable,
    monthlyRate: i,
    nominalRate: i * 12,
    interestRate: annualFromMonthly(i),
    apr: annualFromMonthly(iAll),
    flatRate: credit > 0 && years > 0 ? interest / credit / years : 0,
    interestPerMonth: interest / term,
    interestPerYear: interest / years,
    costPerMonth: costOfCredit / term,
    costPerYear: costOfCredit / years,
    depositShare: deposit / price,
    balloonShare: balloon / price,
    schedule,
    yearly,
  };
}

/** UK APRs are quoted to one decimal place. */
export const quoteApr = (apr) => Math.round(apr * 1000) / 10;

/**
 * What the same deal would cost with a different deposit or a different APR, keeping the term,
 * number of payments and final payment fixed (the final payment on a PCP is set by the car's
 * expected value, not the rate).
 */
export function whatIf(r, { extraDeposit = 0, apr = null } = {}) {
  const i = apr == null ? r.monthlyRate : monthlyFromAnnual(apr);
  const credit = Math.max(0, r.credit - extraDeposit);
  const monthly = Math.max(0, paymentFor(credit, i, r.count, r.balloon, r.term));
  const interest = monthly * r.count + r.balloon - credit;
  return { monthly, interest, credit };
}
