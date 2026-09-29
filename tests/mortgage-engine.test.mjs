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
