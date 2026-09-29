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
