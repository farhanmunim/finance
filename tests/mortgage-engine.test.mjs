import test from 'node:test';
import assert from 'node:assert/strict';
import { amortise, compare, monthlyPayment, monthsToRepay } from '../assets/js/mortgage-engine.js';

const close = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) < tol, `expected ${b} got ${a}`);

test('monthly payment formula matches a standard example', () => {
  // £200,000 over 25 years at 5% -> £1,169.18
  close(monthlyPayment(200000, 5, 300), 1169.18);
  close(monthlyPayment(120000, 0, 120), 1000);
});

test('repayment mortgage clears exactly at the end of the term', () => {
  const r = amortise({ principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment' });
  assert.equal(r.ok, true);
  assert.equal(r.months, 300);
  close(r.closingBalance, 0);
  close(r.totalPaid, 1169.18 * 300, 3);
  close(r.totalInterest, r.totalPaid - 200000, 3);
  assert.equal(r.yearly.length, 25);
});

test('interest only pays only interest and leaves the balance', () => {
  const r = amortise({ principal: 200000, termMonths: 120, annualRate: 6, type: 'interest_only' });
  assert.equal(r.months, 120);
  close(r.initialPayment, 1000);
  close(r.closingBalance, 200000);
  close(r.totalInterest, 120000, 1);
});

test('monthly overpayment shortens the term and saves interest', () => {
  const c = compare({ principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment', monthlyOverpayment: 200 });
  assert.ok(c.monthsSaved > 50, `months saved ${c.monthsSaved}`);
  assert.ok(c.interestSaved > 30000, `interest saved ${c.interestSaved}`);
  close(c.withOverpayments.closingBalance, 0);
  assert.equal(c.hasOverpayments, true);
});

test('reduce-payment overpayment keeps the term and lowers the payment', () => {
  const r = amortise({ principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment', lumpSum: 20000, lumpSumMonth: 12, overpaymentEffect: 'reduce_payment' });
  assert.equal(r.months, 300);
  assert.ok(r.paymentChanges.length >= 2);
  assert.ok(r.paymentChanges[1].amount < r.initialPayment);
});

test('fixed period then revert rate recalculates the payment', () => {
  const r = amortise({ principal: 200000, termMonths: 300, annualRate: 4, fixedMonths: 24, revertRate: 7, type: 'repayment' });
  assert.equal(r.months, 300);
  assert.equal(r.paymentChanges.length, 2);
  assert.equal(r.paymentChanges[1].fromMonth, 25);
  assert.ok(r.paymentChanges[1].amount > r.initialPayment);
  close(r.closingBalance, 0);
});

test('user-specified payment: derives the term', () => {
  const r = amortise({ principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment', payment: 1500 });
  assert.equal(r.months, monthsToRepay(200000, 5, 1500));
  close(r.closingBalance, 0);
});

test('payment below interest is rejected', () => {
  const r = amortise({ principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment', payment: 500 });
  assert.equal(r.ok, false);
  assert.ok(r.warnings.length);
});

test('overpayment on interest-only reduces the final balance', () => {
  const r = amortise({ principal: 100000, termMonths: 60, annualRate: 5, type: 'interest_only', monthlyOverpayment: 500 });
  close(r.closingBalance, 70000);
  assert.ok(r.totalInterest < 25000);
});

import { overpayVsSave, breakEvenSavingsRate, rateSensitivity, ltvBands, buyToLet } from '../assets/js/mortgage-engine.js';

test('overpay vs save: overpaying wins when savings rate is below the mortgage rate', () => {
  const o = { principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment', monthlyOverpayment: 200 };
  const low = overpayVsSave(o, 3, 0);
  const high = overpayVsSave(o, 7, 0);
  assert.ok(low.advantage > 0, `advantage ${low.advantage}`);
  assert.ok(high.advantage < 0, `advantage ${high.advantage}`);
  assert.equal(low.yearly.length, 25);
  close(low.overpay.balance, 0);
  close(low.save.balance, 0);
  // both strategies spend the same cash, so deposits into B equal total overpayments
  close(low.save.deposits, 200 * 300, 1);
});

test('break-even savings rate is close to the mortgage rate grossed up for tax', () => {
  const o = { principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment', monthlyOverpayment: 200 };
  const be0 = breakEvenSavingsRate(o, 0);
  assert.ok(Math.abs(be0 - 5) < 0.1, `break-even ${be0}`);
  const be40 = breakEvenSavingsRate(o, 0.4);
  assert.ok(Math.abs(be40 - 5 / 0.6) < 0.2, `break-even ${be40}`);
});

test('rate sensitivity returns a row per delta with the current one flagged', () => {
  const rows = rateSensitivity({ principal: 200000, termMonths: 300, annualRate: 5, type: 'repayment' });
  assert.equal(rows.length, 8);
  const cur = rows.find((r) => r.current);
  close(cur.payment, 1169.18);
  assert.ok(rows[0].payment < cur.payment && rows[rows.length - 1].payment > cur.payment);
});

test('ltv bands report extra deposit needed', () => {
  const bands = ltvBands(300000, 270000); // 90%
  const b85 = bands.find((b) => b.tier === 0.85);
  close(b85.extraDeposit, 15000);
  assert.equal(bands.find((b) => b.tier === 0.9).reached, true);
  assert.equal(b85.reached, false);
});

test('buy-to-let: finance cost restriction gives a 20% credit instead of a deduction', () => {
  // gov.uk style: rent 12,000, expenses 2,000, interest 4,000, higher-rate taxpayer
  const b = buyToLet({ annualRent: 12000, annualExpenses: 2000, annualInterest: 4000, annualMortgagePayments: 4000, taxRate: 0.4, price: 200000 });
  close(b.profit, 10000);
  close(b.taxBeforeCredit, 4000);
  close(b.credit, 800);
  close(b.tax, 3200);
  close(b.oldRulesTax, 2400);
  close(b.extraTaxVsOldRules, 800);
  close(b.cashAfterTax, 12000 - 2000 - 4000 - 3200);
  // credit capped by profit when interest exceeds it
  const capped = buyToLet({ annualRent: 6000, annualExpenses: 1000, annualInterest: 8000, annualMortgagePayments: 8000, taxRate: 0.2 });
  close(capped.credit, 1000);
});
