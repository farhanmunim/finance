/**
 * Mortgage amortisation engine. Pure functions, no DOM.
 *
 * Interest is charged monthly at annualRate / 12 on the opening balance of each month,
 * which is how most UK lenders quote and (closely) how they charge. Payments are made at the
 * end of each month.
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Standard annuity payment for a balance over n months at monthly rate r. */
export function monthlyPayment(balance, annualRatePct, months) {
  if (months <= 0) return balance;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return balance / months;
  return (balance * r) / (1 - Math.pow(1 + r, -months));
}

/** Months needed to clear a balance with a fixed payment (Infinity if payment does not cover interest). */
export function monthsToRepay(balance, annualRatePct, payment) {
  const r = annualRatePct / 100 / 12;
  if (payment <= 0) return Infinity;
  if (r === 0) return Math.ceil(balance / payment);
  if (payment <= balance * r) return Infinity;
  return Math.ceil(-Math.log(1 - (balance * r) / payment) / Math.log(1 + r));
}

/**
 * Run a month-by-month schedule.
 * @param {object} o
 * @param {number} o.principal          loan amount
 * @param {number} o.termMonths         contractual term
 * @param {number} o.annualRate         initial interest rate (%)
 * @param {'repayment'|'interest_only'} o.type
 * @param {number} [o.fixedMonths]      length of the initial rate period (0 = whole term)
 * @param {number} [o.revertRate]       rate after the fixed period (%)
 * @param {number} [o.payment]          override the contractual monthly payment (repayment only)
 * @param {number} [o.monthlyOverpayment]
 * @param {number} [o.annualOverpayment]   paid every 12th month
 * @param {number} [o.lumpSum]             one-off overpayment
 * @param {number} [o.lumpSumMonth]        month the one-off is paid (1 = first month)
 * @param {'reduce_term'|'reduce_payment'} [o.overpaymentEffect]
 */
export function amortise(o) {
  const principal = num(o.principal);
  const termMonths = Math.max(1, Math.round(num(o.termMonths)));
  const type = o.type === 'interest_only' ? 'interest_only' : 'repayment';
  const fixedMonths = Math.max(0, Math.round(num(o.fixedMonths)));
  const revertRate = o.revertRate == null || o.revertRate === '' ? num(o.annualRate) : num(o.revertRate);
  const monthlyOver = num(o.monthlyOverpayment);
  const annualOver = num(o.annualOverpayment);
  const lumpSum = num(o.lumpSum);
  const lumpSumMonth = Math.max(1, Math.round(num(o.lumpSumMonth) || 1));
  const effect = o.overpaymentEffect === 'reduce_payment' ? 'reduce_payment' : 'reduce_term';
  const maxMonths = 100 * 12;

  const rateFor = (m) => (fixedMonths > 0 && m > fixedMonths ? revertRate : num(o.annualRate));

  let balance = principal;
  let payment = type === 'repayment'
    ? (num(o.payment) > 0 ? num(o.payment) : monthlyPayment(balance, rateFor(1), termMonths))
    : 0;
  const schedule = [];
  const paymentChanges = [];
  let currentRate = rateFor(1);
  let totalInterest = 0, totalPaid = 0, totalOverpaid = 0;
  let m = 0;
  const warnings = [];

  const initialPayment = type === 'repayment' ? payment : principal * (currentRate / 100 / 12);
  paymentChanges.push({ fromMonth: 1, amount: round2(initialPayment), rate: currentRate });

  while (balance > 0.005 && m < maxMonths) {
    // Interest-only loans stop at the end of the term with the balance outstanding.
    if (type === 'interest_only' && m >= termMonths) break;
    if (type === 'repayment' && num(o.payment) === 0 && m >= termMonths + 1) break; // safety
    m += 1;

    const rate = rateFor(m);
    if (rate !== currentRate) {
      currentRate = rate;
      if (type === 'repayment' && num(o.payment) === 0) {
        payment = monthlyPayment(balance, rate, Math.max(1, termMonths - m + 1));
        paymentChanges.push({ fromMonth: m, amount: round2(payment), rate });
      } else if (type === 'interest_only') {
        paymentChanges.push({ fromMonth: m, amount: round2(balance * (rate / 100 / 12)), rate });
      }
    }
    const r = rate / 100 / 12;
    const interest = balance * r;
    let scheduled;
    if (type === 'interest_only') {
      scheduled = interest;
    } else {
      if (payment <= interest && m === 1) {
        warnings.push('The monthly payment does not cover the interest, so the loan would never be repaid.');
        return { ok: false, warnings, months: 0, schedule: [], totalInterest: 0, totalPaid: 0, totalOverpaid: 0, paymentChanges, closingBalance: principal, initialPayment: round2(initialPayment) };
      }
      scheduled = Math.min(payment, balance + interest);
    }
    let over = monthlyOver + (m % 12 === 0 ? annualOver : 0) + (m === lumpSumMonth ? lumpSum : 0);
    const afterScheduled = balance + interest - scheduled;
    over = Math.min(over, Math.max(0, afterScheduled));
    balance = afterScheduled - over;
    totalInterest += interest;
    totalPaid += scheduled + over;
    totalOverpaid += over;
    schedule.push({ month: m, rate, opening: round2(afterScheduled - interest + scheduled), interest: round2(interest), payment: round2(scheduled), overpayment: round2(over), principal: round2(scheduled - interest + over), closing: round2(Math.max(0, balance)) });

    if (over > 0 && effect === 'reduce_payment' && type === 'repayment' && balance > 0.005 && num(o.payment) === 0) {
      payment = monthlyPayment(balance, currentRate, Math.max(1, termMonths - m));
      paymentChanges.push({ fromMonth: m + 1, amount: round2(payment), rate: currentRate });
    }
  }
  if (m >= maxMonths) warnings.push('The loan takes more than 100 years to repay at this payment.');
  else if (type === 'repayment' && num(o.payment) > 0 && m > termMonths) warnings.push(`At this payment the loan takes ${Math.round(m / 12)} years to clear, longer than the ${Math.round(termMonths / 12)}-year term${fixedMonths > 0 ? ' - the higher rate after the deal makes a big difference' : ''}.`);

  return {
    ok: true,
    warnings,
    type,
    months: m,
    initialPayment: round2(initialPayment),
    paymentChanges,
    schedule,
    totalInterest: round2(totalInterest),
    totalPaid: round2(totalPaid),
    totalOverpaid: round2(totalOverpaid),
    closingBalance: round2(Math.max(0, balance)),
    yearly: summariseByYear(schedule),
  };
}

export function summariseByYear(schedule) {
  const years = [];
  for (const row of schedule) {
    const y = Math.ceil(row.month / 12);
    let cur = years[y - 1];
    if (!cur) { cur = { year: y, opening: row.opening, interest: 0, paid: 0, overpaid: 0, principal: 0, closing: row.closing }; years[y - 1] = cur; }
    cur.interest = round2(cur.interest + row.interest);
    cur.paid = round2(cur.paid + row.payment + row.overpayment);
    cur.overpaid = round2(cur.overpaid + row.overpayment);
    cur.principal = round2(cur.principal + row.principal);
    cur.closing = row.closing;
  }
  return years;
}

/**
 * Compare a plan without overpayments against the same plan with them.
 */
export function compare(options) {
  const base = amortise({ ...options, monthlyOverpayment: 0, annualOverpayment: 0, lumpSum: 0 });
  const withOver = amortise(options);
  const hasOverpayments = num(options.monthlyOverpayment) + num(options.annualOverpayment) + num(options.lumpSum) > 0;
  return {
    base,
    withOverpayments: withOver,
    hasOverpayments,
    interestSaved: round2(base.totalInterest - withOver.totalInterest),
    monthsSaved: base.months - withOver.months,
    balanceReduced: round2(base.closingBalance - withOver.closingBalance),
  };
}

export const _internal = { num, round2 };

/** Planned overpayment for a given month, from the same options amortise() uses. */
function plannedOverpayment(o, m) {
  const lumpMonth = Math.max(1, Math.round(num(o.lumpSumMonth) || 1));
  return num(o.monthlyOverpayment) + (m % 12 === 0 ? num(o.annualOverpayment) : 0) + (m === lumpMonth ? num(o.lumpSum) : 0);
}

/**
 * Overpay the mortgage, or put the same money in savings?
 * Both strategies spend exactly the same cash each month (standard payment + planned overpayment).
 *  A: overpay the mortgage; once it is cleared (or the payment falls) the freed cash goes into savings.
 *  B: pay the mortgage as normal; the overpayment money goes into savings every month.
 * Compared at the end of the standard mortgage term on "net position" = savings − mortgage balance.
 * @param {object} options amortise() options including overpayments
 * @param {number} savingsRate gross savings rate (%)
 * @param {number} taxRate tax on the interest (0, 0.2, 0.4, 0.45)
 */
export function overpayVsSave(options, savingsRate, tax = 0) {
  const taxRate = typeof tax === 'number' ? tax : num(tax?.rate);
  const allowance = typeof tax === 'number' ? 0 : num(tax?.allowance); // Personal Savings Allowance per tax year
  const base = amortise({ ...options, monthlyOverpayment: 0, annualOverpayment: 0, lumpSum: 0 });
  const over = amortise(options);
  if (!base.ok || !over.ok) return null;
  const horizon = base.months;
  const rGross = num(savingsRate) / 100 / 12;
  let savA = 0, savB = 0, depositsA = 0, depositsB = 0, taxA = 0, taxB = 0;
  let yearInterestA = 0, yearInterestB = 0; // gross interest so far this tax year
  // Interest is credited gross; tax is due only on the part above the allowance in each year.
  const credit = (bal, yearInterest) => {
    const gross = bal * rGross;
    const taxable = Math.max(0, Math.min(gross, yearInterest + gross - allowance));
    const t = taxable * taxRate;
    return { gross, t };
  };
  const yearly = [];
  for (let m = 1; m <= horizon; m++) {
    if ((m - 1) % 12 === 0) { yearInterestA = 0; yearInterestB = 0; }
    const b = base.schedule[m - 1];
    const a = over.schedule[m - 1];
    const outflow = b.payment + plannedOverpayment(options, m);
    const cashA = a ? a.payment + a.overpayment : 0;
    const ca = credit(savA, yearInterestA); yearInterestA += ca.gross; taxA += ca.t;
    savA = savA + ca.gross - ca.t + Math.max(0, outflow - cashA);
    depositsA += Math.max(0, outflow - cashA);
    const cb = credit(savB, yearInterestB); yearInterestB += cb.gross; taxB += cb.t;
    savB = savB + cb.gross - cb.t + Math.max(0, outflow - b.payment);
    depositsB += Math.max(0, outflow - b.payment);
    if (m % 12 === 0 || m === horizon) {
      const balA = a ? a.closing : 0;
      yearly.push({ year: Math.ceil(m / 12), savingsA: round2(savA), balanceA: balA, netA: round2(savA - balA), savingsB: round2(savB), balanceB: b.closing, netB: round2(savB - b.closing) });
    }
  }
  const last = yearly[yearly.length - 1];
  return {
    horizonMonths: horizon,
    netRate: round2(num(savingsRate) * (1 - taxRate) * 100) / 100,
    taxRate, allowance,
    overpay: { savings: last.savingsA, balance: last.balanceA, net: last.netA, interestPaid: over.totalInterest, deposits: round2(depositsA), interestEarned: round2(savA - depositsA), taxPaid: round2(taxA) },
    save: { savings: last.savingsB, balance: last.balanceB, net: last.netB, interestPaid: base.totalInterest, deposits: round2(depositsB), interestEarned: round2(savB - depositsB), taxPaid: round2(taxB) },
    advantage: round2(last.netA - last.netB), // positive = overpaying wins
    yearly,
  };
}

/** Gross savings rate at which saving and overpaying come out equal (bisection). */
export function breakEvenSavingsRate(options, tax = 0) {
  let lo = 0, hi = 40;
  const f = (r) => overpayVsSave(options, r, tax)?.advantage ?? 0;
  if (f(lo) <= 0) return 0;
  if (f(hi) >= 0) return null;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
  return Math.round(((lo + hi) / 2) * 100) / 100;
}

/** Monthly payment and total interest at a range of interest rates around the entered one. */
export function rateSensitivity(options, deltas = [-2, -1, -0.5, 0, 0.5, 1, 2, 3]) {
  const rate = num(options.annualRate);
  return deltas.map((d) => {
    const r = Math.max(0, Math.round((rate + d) * 100) / 100);
    const revert = options.revertRate == null ? null : Math.max(0, num(options.revertRate) + d);
    const run = amortise({ ...options, annualRate: r, revertRate: revert, monthlyOverpayment: 0, annualOverpayment: 0, lumpSum: 0 });
    return { delta: d, rate: r, payment: run.ok ? run.initialPayment : null, totalInterest: run.ok ? run.totalInterest : null, current: d === 0 };
  });
}

/** Common lender LTV tiers and the extra deposit needed to reach each one. */
export function ltvBands(price, principal, tiers = [0.95, 0.9, 0.85, 0.8, 0.75, 0.6]) {
  if (!(price > 0)) return [];
  const ltv = principal / price;
  return tiers.map((t) => ({ tier: t, maxLoan: round2(price * t), extraDeposit: round2(Math.max(0, principal - price * t)), reached: ltv <= t + 1e-9 }));
}

/**
 * Buy-to-let: UK residential landlords cannot deduct mortgage interest. They get a tax
 * reduction of reliefRate (20%) × the lower of finance costs and property profits instead.
 * @param {object} p { annualRent, annualExpenses, annualInterest, annualMortgagePayments, taxRate, reliefRate, price }
 */
export function buyToLet(p) {
  const rent = num(p.annualRent), expenses = num(p.annualExpenses), interest = num(p.annualInterest), payments = num(p.annualMortgagePayments);
  const taxRate = num(p.taxRate), reliefRate = p.reliefRate == null ? 0.2 : num(p.reliefRate);
  const profit = Math.max(0, rent - expenses);
  const taxBeforeCredit = profit * taxRate;
  const creditBase = Math.min(interest, profit);
  const credit = Math.min(taxBeforeCredit, creditBase * reliefRate);
  const tax = taxBeforeCredit - credit;
  const cashBeforeTax = rent - expenses - payments;
  const oldRulesTax = Math.max(0, rent - expenses - interest) * taxRate; // pre-2020 for comparison
  return {
    rent, expenses, interest, payments, profit: round2(profit), taxRate, reliefRate,
    taxBeforeCredit: round2(taxBeforeCredit), creditBase: round2(creditBase), credit: round2(credit), tax: round2(tax),
    cashBeforeTax: round2(cashBeforeTax), cashAfterTax: round2(cashBeforeTax - tax),
    oldRulesTax: round2(oldRulesTax), extraTaxVsOldRules: round2(tax - oldRulesTax),
    grossYield: p.price > 0 ? rent / num(p.price) : null,
    netYield: p.price > 0 ? (cashBeforeTax - tax + (payments - interest)) / num(p.price) : null, // capital repaid is not a cost
    effectiveTaxRate: profit > 0 ? tax / Math.max(1e-9, rent - expenses - interest) : null,
  };
}
