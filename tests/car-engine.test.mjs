import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse, whatIf, quoteApr, defaultPaymentCount, solveMonthlyRate } from '../assets/js/car-engine.js';

const close = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) < tol, `expected ${b} got ${a}`);

// A published PCP quote: £26,500 car, £5,000 deposit, 47 x £378.12, final payment £12,879.26 in month 48, 13.9% APR,
// total amount payable £35,650.90.
const pcp = { price: 26500, deposit: 5000, termMonths: 48, monthlyPayment: 378.12, finalPayment: 12879.26 };

test('reproduces a real PCP quote', () => {
  const r = analyse(pcp);
  assert.equal(r.ok, true);
  assert.equal(r.count, 47);
  assert.equal(r.credit, 21500);
  assert.equal(r.repaid, 30650.9);
  assert.equal(r.totalPayable, 35650.9);
  assert.equal(r.interest, 9150.9);
  assert.equal(quoteApr(r.apr), 13.9);
  close(r.monthlyRate * 100, 1.0905, 0.0001);
  close(r.interestPerMonth, 190.64);
  close(r.interestPerYear, 2287.73);
});

test('reproduces the matching hire purchase quote (no final payment)', () => {
  const r = analyse({ price: 26500, deposit: 5000, termMonths: 48, monthlyPayment: 577.69 });
  assert.equal(r.count, 48);
  assert.equal(quoteApr(r.apr), 13.9);
});

test('the schedule repays the loan exactly and yearly figures add up', () => {
  const r = analyse(pcp);
  close(r.schedule[r.schedule.length - 1].balance, 0, 0.05);
  close(r.yearly.reduce((s, y) => s + y.interest, 0), r.interest, 0.05);
  close(r.yearly.reduce((s, y) => s + y.capital, 0), r.credit, 0.05);
  assert.equal(r.yearly.length, 4);
});

test('payment count defaults from the term and can be overridden', () => {
  assert.equal(defaultPaymentCount(48, 10000), 47);
  assert.equal(defaultPaymentCount(48, 0), 48);
  const r = analyse({ ...pcp, termMonths: 49, paymentCount: 48 });
  assert.equal(r.count, 48);
  assert.equal(r.finalMonth, 49);
  assert.equal(analyse({ ...pcp, paymentCount: 99 }).count, 48, 'never more payments than months');
});

test('interest-free deal gives 0% and fees raise the APR above the interest rate', () => {
  const z = analyse({ price: 12000, deposit: 0, termMonths: 24, monthlyPayment: 500 });
  close(z.apr, 0, 1e-9);
  assert.equal(z.interest, 0);
  const f = analyse({ ...pcp, upfrontFee: 199, finalFee: 10 });
  assert.equal(quoteApr(f.interestRate), 13.9);
  assert.ok(f.apr > f.interestRate);
  assert.equal(f.costOfCredit, 9150.9 + 209);
  assert.equal(f.totalPayable, 35650.9 + 209);
});

test('payments below the amount borrowed give a negative rate and a warning', () => {
  const r = analyse({ price: 10000, deposit: 0, termMonths: 10, monthlyPayment: 900 });
  assert.ok(r.monthlyRate < 0);
  assert.ok(r.warnings.length > 0);
});

test('invalid inputs are reported rather than computed', () => {
  assert.equal(analyse({ ...pcp, deposit: 30000 }).ok, false);
  assert.equal(analyse({ ...pcp, monthlyPayment: 0 }).ok, false);
  assert.equal(analyse({ ...pcp, price: 0 }).ok, false);
});

test('what-if: at the same rate the quote is reproduced; more deposit or lower APR costs less', () => {
  const r = analyse(pcp);
  close(whatIf(r).monthly, 378.12, 0.01);
  const more = whatIf(r, { extraDeposit: 1000 });
  assert.ok(more.monthly < 378.12 && more.interest < r.interest);
  const zero = whatIf(r, { apr: 0 });
  close(zero.interest, 0, 0.01);
  close(zero.monthly, (21500 - 12879.26) / 47, 0.01);
});

test('rate solver handles a plain annuity', () => {
  // £10,000 over 12 months at 1% a month -> £888.49
  const flows = Array.from({ length: 12 }, (_, k) => [k + 1, 888.4879]);
  close(solveMonthlyRate(10000, flows), 0.01, 1e-6);
});

test('reproduces a real hire purchase quote with a £1 purchase fee', () => {
  // £26,500 car, £3,975 deposit, 48 x £605.23, £1 purchase fee, 13.9% APR, total amount payable £33,027.04
  const r = analyse({ price: 26500, deposit: 3975, termMonths: 48, monthlyPayment: 605.23, finalFee: 1 });
  assert.equal(r.count, 48);
  assert.equal(r.credit, 22525);
  assert.equal(r.totalPayable, 33027.04);
  assert.equal(r.interest, 6526.04);
  assert.equal(quoteApr(r.apr), 13.9);
});
