/**
 * UK income tax, National Insurance and student loan engine.
 *
 * Pure functions, no DOM. Works in the browser (ES module) and in Node for tests.
 * All rates come from a tax-year JSON file (see /data/tax-years/*.json); nothing is hard-coded here.
 *
 * Method (per tax year):
 *  1. Work out employment income (after salary sacrifice / net pay pension), self-employment
 *     profits, savings interest, dividends and other income.
 *  2. Work out "adjusted net income" (used for the Personal Allowance taper and the
 *     High Income Child Benefit Charge) - total income less gross relief-at-source pension
 *     contributions and gross Gift Aid.
 *  3. Work out allowances: Personal Allowance (tapered above the income limit), Blind Person's
 *     Allowance and Marriage Allowance transfer. Allowances are set against non-savings income
 *     first, then savings, then dividends.
 *  4. Tax non-savings income through the bands (Scottish bands for Scottish taxpayers).
 *  5. Tax savings income (starting rate for savings, Personal Savings Allowance) and dividend
 *     income (dividend allowance, dividend rates) using UK-wide bands, stacked on top of
 *     non-savings income. Relief-at-source pension and Gift Aid extend the band limits.
 *  6. National Insurance: Class 1 (employees) on an annual basis, Class 4 on profits, with the
 *     statutory interaction (annual maximum) when someone has both.
 *  7. Student loans on the combined income.
 *
 * Property income: finance costs (mortgage interest) are not deductible; a tax reducer of
 * 20% of the lower of finance costs, property profits and adjusted total income applies.
 */

/** Deep-clone a rates object and apply {path: value} overrides (paths like "incomeTax.bands.ruk.0.rate"). */
export function applyOverrides(rates, overrides = {}) {
  const out = JSON.parse(JSON.stringify(rates));
  for (const [path, value] of Object.entries(overrides)) {
    if (value === '' || value == null) continue;
    const keys = path.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) { if (o[k] == null) o[k] = {}; o = o[k]; }
    const last = keys[keys.length - 1];
    o[last] = value === 'null' ? null : Number(value);
  }
  return out;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Turn a band list ({upTo}) into absolute [from, to) ranges, extending limits by `extension`. */
function buildBands(bands, extension, { extendFrom = 0 } = {}) {
  let from = 0;
  return bands.map((b, i) => {
    const ext = i >= extendFrom ? extension : 0;
    const to = b.upTo == null ? Infinity : b.upTo + ext;
    const out = { id: b.id, name: b.name, rate: b.rate, from, to };
    from = to;
    return out;
  });
}

/**
 * Allocate `amount` of income starting at position `start` across `bands`.
 * Returns pieces { id, name, rate, amount, tax } (rate may be overridden via rateFor(band)).
 */
function allocate(bands, start, amount, rateFor, label) {
  const pieces = [];
  let pos = start;
  let left = amount;
  for (const b of bands) {
    if (left <= 0) break;
    if (pos >= b.to) continue;
    const room = b.to - Math.max(pos, b.from);
    const take = Math.min(room, left);
    if (take > 0) {
      const rate = rateFor ? rateFor(b) : b.rate;
      pieces.push({ id: b.id, name: b.name, rate, amount: take, tax: take * rate, label });
      left -= take;
      pos += take;
    }
  }
  return pieces;
}

/** Which band does the income at position `pos` fall into? */
function bandAt(bands, pos) {
  for (const b of bands) if (pos < b.to) return b;
  return bands[bands.length - 1];
}

function levelOfBand(id) {
  // Map any band id to the UK-wide taxpayer level used for the Personal Savings Allowance
  // and dividend rates.
  if (id === 'additional' || id === 'top') return 'additional';
  if (id === 'higher' || id === 'advanced') return 'higher';
  return 'basic';
}

/**
 * Main entry point.
 * @param {object} input see README for the shape; every field is optional.
 * @param {object} rates a tax-year JSON object.
 */
export function calculate(input = {}, rates) {
  if (!rates) throw new Error('rates are required');
  const it = rates.incomeTax;
  const ni = rates.nationalInsurance;
  const sl = rates.studentLoans;
  const warnings = [];

  const region = input.region === 'scotland' ? 'scotland' : 'ruk';
  const basicRate = it.basicRate;

  // ---------------------------------------------------------------- 1. Employment income
  const emp = input.employment || {};
  const salary = num(emp.salary);
  const bonus = num(emp.bonus);
  const benefits = num(emp.taxableBenefits);
  const empExpenses = num(emp.expenses); // allowable employment expenses (reduce tax, not NI)
  const grossPay = salary + bonus;
  const pension = emp.pension || {};
  const method = ['salary_sacrifice', 'net_pay', 'relief_at_source'].includes(pension.method) ? pension.method : 'none';
  let pensionGross = 0;
  if (method !== 'none') {
    pensionGross = pension.type === 'amount' ? num(pension.value) : salary * (num(pension.value) / 100);
    if (pensionGross > grossPay) {
      warnings.push('Pension contribution was capped at your gross pay.');
      pensionGross = grossPay;
    }
  }
  let taxablePay = grossPay;
  let niablePay = grossPay;
  let pensionCash = pensionGross; // what actually leaves your pay
  let rasGrossEmployment = 0;
  if (method === 'salary_sacrifice') {
    taxablePay -= pensionGross;
    niablePay -= pensionGross;
  } else if (method === 'net_pay') {
    taxablePay -= pensionGross;
  } else if (method === 'relief_at_source') {
    rasGrossEmployment = pensionGross;
    pensionCash = pensionGross * (1 - basicRate);
  }
  const employmentIncome = Math.max(0, taxablePay + benefits - empExpenses);

  // ---------------------------------------------------------------- 2. Self-employment
  const se = input.selfEmployment || {};
  const turnover = num(se.turnover);
  const expenses = num(se.expenses);
  const useTradingAllowance = se.deduction === 'trading_allowance';
  const tradingAllowanceUsed = useTradingAllowance ? Math.min(it.tradingAllowance, turnover) : 0;
  const expensesUsed = useTradingAllowance ? 0 : Math.min(expenses, turnover);
  if (!useTradingAllowance && expenses > turnover && turnover > 0) {
    warnings.push('Self-employment expenses exceed turnover. Losses are not modelled; profit has been treated as £0.');
  }
  if (useTradingAllowance && expenses > it.tradingAllowance) {
    warnings.push(`Your expenses are above the £${it.tradingAllowance.toLocaleString('en-GB')} trading allowance - deducting actual expenses would give a lower tax bill.`);
  }
  const profit = Math.max(0, turnover - tradingAllowanceUsed - expensesUsed);
  const sePensionPaid = num(se.pensionPaid);
  const sePensionGross = sePensionPaid / (1 - basicRate);

  // ---------------------------------------------------------------- 3. Property income
  // Residential landlords cannot deduct mortgage interest (finance costs) from rental income.
  // Instead they get a tax reducer of 20% of the finance costs, capped (see below).
  const prop = input.property || {};
  const rent = num(prop.rentalIncome);
  const propExpenses = num(prop.expenses);
  const financeCosts = num(prop.financeCosts);
  const usePropertyAllowance = prop.deduction === 'property_allowance';
  const propertyAllowanceUsed = usePropertyAllowance ? Math.min(it.propertyAllowance, rent) : 0;
  const propExpensesUsed = usePropertyAllowance ? 0 : Math.min(propExpenses, rent);
  if (!usePropertyAllowance && propExpenses > rent && rent > 0) warnings.push('Property expenses exceed rental income. Property losses are not modelled; profit has been treated as £0.');
  const propertyProfit = Math.max(0, rent - propertyAllowanceUsed - propExpensesUsed);

  // ---------------------------------------------------------------- 4. Other income
  const other = input.other || {};
  const savings = num(other.savingsInterest);
  const dividends = num(other.dividends);
  const otherIncome = num(other.otherIncome);

  const nonSavings = employmentIncome + profit + propertyProfit + otherIncome;
  const totalIncome = nonSavings + savings + dividends;

  // ---------------------------------------------------------------- 4. Adjustments & allowances
  const adj = input.adjustments || {};
  const giftAidPaid = num(adj.giftAid);
  const giftAidGross = giftAidPaid / (1 - basicRate);
  const rasGross = rasGrossEmployment + sePensionGross;
  const adjustedNetIncome = Math.max(0, totalIncome - rasGross - giftAidGross);

  const paStandard = it.personalAllowance;
  const paExcess = Math.max(0, adjustedNetIncome - it.personalAllowanceIncomeLimit);
  const paTaper = Math.min(paStandard, Math.floor(paExcess / 2));
  const personalAllowance = paStandard - paTaper;
  const blind = adj.blindPersonsAllowance ? it.blindPersonsAllowance : 0;
  const marriage = ['transfer', 'receive'].includes(adj.marriageAllowance) ? adj.marriageAllowance : 'none';
  const marriageTransfer = marriage === 'transfer' ? Math.min(it.marriageAllowanceTransfer, personalAllowance) : 0;
  const allowanceTotal = personalAllowance + blind - marriageTransfer;

  // Allowances against non-savings first, then savings, then dividends.
  const allowNS = Math.min(allowanceTotal, nonSavings);
  const allowSav = Math.min(allowanceTotal - allowNS, savings);
  const allowDiv = Math.min(allowanceTotal - allowNS - allowSav, dividends);
  const taxableNS = nonSavings - allowNS;
  const taxableSav = savings - allowSav;
  const taxableDiv = dividends - allowDiv;
  const taxableTotal = taxableNS + taxableSav + taxableDiv;
  const allowanceUnused = allowanceTotal - allowNS - allowSav - allowDiv;

  // ---------------------------------------------------------------- 5. Income tax
  const extension = rasGross + giftAidGross; // basic (and higher) rate limits extended
  const ukBands = buildBands(it.bands.ruk, extension);
  // Scottish taxpayers: the starter rate limit is not extended; the limits above it are.
  const nsBands = region === 'scotland' ? buildBands(it.bands.scotland, extension, { extendFrom: 1 }) : ukBands;

  const nsPieces = allocate(nsBands, 0, taxableNS, null, 'nonSavings');

  // Savings: starting rate band (0%) reduced £1 for £1 by taxable non-savings income.
  const startingRateAvail = Math.max(0, it.savings.startingRateBand - taxableNS);
  const startingRateUsed = Math.min(startingRateAvail, taxableSav);

  // Taxpayer level for the Personal Savings Allowance: the highest UK-wide rate any of the
  // income reaches (Scottish higher/advanced/top rate income counts as higher/additional).
  let level = 'basic';
  const bump = (l) => { if (l === 'additional' || (l === 'higher' && level === 'basic')) level = l; };
  if (taxableTotal > 0) bump(levelOfBand(bandAt(ukBands, Math.max(0, taxableTotal - 0.01)).id));
  if (region === 'scotland' && taxableNS > 0) bump(levelOfBand(bandAt(nsBands, Math.max(0, taxableNS - 0.01)).id));
  const psa = it.savings.personalSavingsAllowance[level];
  const psaUsed = Math.min(psa, taxableSav - startingRateUsed);

  const savPieces = [];
  let pos = taxableNS;
  if (startingRateUsed > 0) { savPieces.push({ id: 'starting', name: 'Starting rate for savings', rate: 0, amount: startingRateUsed, tax: 0, label: 'savings' }); pos += startingRateUsed; }
  if (psaUsed > 0) { savPieces.push({ id: 'psa', name: 'Personal Savings Allowance', rate: 0, amount: psaUsed, tax: 0, label: 'savings' }); pos += psaUsed; }
  const savTaxed = taxableSav - startingRateUsed - psaUsed;
  if (savTaxed > 0) savPieces.push(...allocate(ukBands, pos, savTaxed, null, 'savings'));
  pos += savTaxed;

  // Dividends: allowance is a 0% band that still uses up band space.
  const divPieces = [];
  const divAllowUsed = Math.min(it.dividends.allowance, taxableDiv);
  if (divAllowUsed > 0) { divPieces.push({ id: 'dividend-allowance', name: 'Dividend allowance', rate: 0, amount: divAllowUsed, tax: 0, label: 'dividends' }); pos += divAllowUsed; }
  const divTaxed = taxableDiv - divAllowUsed;
  if (divTaxed > 0) {
    divPieces.push(...allocate(ukBands, pos, divTaxed, (b) => it.dividends.rates[levelOfBand(b.id)], 'dividends')
      .map((p) => ({ ...p, name: `Dividend ${p.name.toLowerCase()}` })));
  }

  const sum = (arr) => arr.reduce((s, p) => s + p.tax, 0);
  const nonSavingsTax = sum(nsPieces);
  const savingsTax = sum(savPieces);
  const dividendTax = sum(divPieces);
  const taxBeforeReducers = nonSavingsTax + savingsTax + dividendTax;

  let marriageReducer = 0;
  if (marriage === 'receive') {
    const eligible = region === 'scotland' ? !['higher', 'advanced', 'top'].includes(bandAt(nsBands, Math.max(0, taxableNS - 0.01)).id) && level === 'basic' : level === 'basic';
    if (eligible) marriageReducer = Math.min(taxBeforeReducers, it.marriageAllowanceTransfer * basicRate);
    else warnings.push('Marriage Allowance can only be received by basic-rate taxpayers (starter, basic or intermediate rate in Scotland), so it has not been applied.');
  }
  // Finance cost tax reduction: 20% of the lower of finance costs, property profits and
  // adjusted total income (non-savings income after allowances). Not available with the
  // property allowance. Unused amounts carry forward (not modelled).
  let financeCostReducer = 0;
  let financeCostReliefBase = 0;
  if (financeCosts > 0 && !usePropertyAllowance) {
    financeCostReliefBase = Math.min(financeCosts, propertyProfit, taxableNS);
    financeCostReducer = Math.min(Math.max(0, taxBeforeReducers - marriageReducer), financeCostReliefBase * it.financeCostReliefRate);
  } else if (financeCosts > 0 && usePropertyAllowance) {
    warnings.push('Mortgage interest relief cannot be claimed together with the property allowance, so it has not been applied.');
  }
  const incomeTaxTotal = Math.max(0, taxBeforeReducers - marriageReducer - financeCostReducer);

  // ---------------------------------------------------------------- 6. National Insurance
  const c1 = ni.class1;
  const class1Main = clamp(niablePay - c1.primaryThreshold, 0, c1.upperEarningsLimit - c1.primaryThreshold) * c1.employeeMainRate;
  const class1Upper = Math.max(0, niablePay - c1.upperEarningsLimit) * c1.employeeUpperRate;
  const class1Employee = class1Main + class1Upper;
  const class1Employer = Math.max(0, niablePay - c1.secondaryThreshold) * c1.employerRate;

  const c4 = ni.class4;
  const c4MainBand = clamp(profit - c4.lowerProfitsLimit, 0, c4.upperProfitsLimit - c4.lowerProfitsLimit);
  const c4MainFull = c4MainBand * c4.mainRate;
  // Annual maximum (SSCR 2001 reg. 100): Class 1 main-rate contributions already paid reduce the
  // amount of Class 4 that can be charged at the main rate; displaced profits are charged at 2%.
  const c4Maximum = (c4.upperProfitsLimit - c4.lowerProfitsLimit) * c4.mainRate;
  const c4Room = Math.max(0, c4Maximum - class1Main);
  const class4Main = Math.min(c4MainFull, c4Room);
  const c4Displaced = c4.mainRate > 0 ? (c4MainFull - class4Main) / c4.mainRate : 0;
  const class4Upper = (Math.max(0, profit - c4.upperProfitsLimit) + c4Displaced) * c4.upperRate;
  const class4 = class4Main + class4Upper;

  const c2 = ni.class2;
  const class2Voluntary = round2(c2.weeklyRate * c2.weeksInYear);
  const class2Status = profit <= 0 ? 'n/a' : profit >= c2.smallProfitsThreshold ? 'credited' : 'voluntary';

  const niTotal = class1Employee + class4;

  // ---------------------------------------------------------------- 7. Student loans
  const plans = Array.isArray(input.studentLoans) ? input.studentLoans.filter((p) => sl[p]) : [];
  const unearned = savings + dividends + otherIncome + propertyProfit;
  const slUnearned = unearned > sl.unearnedIncomeLimit ? unearned : 0;
  const slIncome = taxablePay + profit + slUnearned;
  const undergradPlans = plans.filter((p) => p !== 'postgraduate');
  let undergrad = null;
  if (undergradPlans.length) {
    const threshold = Math.min(...undergradPlans.map((p) => sl[p].threshold));
    const rate = sl[undergradPlans[0]].rate;
    undergrad = { plans: undergradPlans, threshold, rate, amount: Math.floor(Math.max(0, slIncome - threshold) * rate) };
  }
  let postgraduate = null;
  if (plans.includes('postgraduate')) {
    postgraduate = { threshold: sl.postgraduate.threshold, rate: sl.postgraduate.rate, amount: Math.floor(Math.max(0, slIncome - sl.postgraduate.threshold) * sl.postgraduate.rate) };
  }
  const studentLoanTotal = (undergrad?.amount || 0) + (postgraduate?.amount || 0);

  // ---------------------------------------------------------------- 8. High Income Child Benefit Charge
  const children = Math.max(0, Math.floor(num(adj.childBenefitChildren)));
  const optedOut = !!adj.childBenefitOptedOut;
  let hicbc = null;
  if (children > 0 && rates.childBenefit) {
    const cb = rates.childBenefit;
    const annual = (cb.weeklyEldest + (children - 1) * cb.weeklyOther) * 52;
    let percent = 0;
    if (adjustedNetIncome >= cb.hicbc.fullWithdrawal) percent = 100;
    else if (adjustedNetIncome > cb.hicbc.threshold) percent = Math.min(100, Math.floor((adjustedNetIncome - cb.hicbc.threshold) / cb.hicbc.stepPounds) * cb.hicbc.stepPercent);
    const charge = optedOut ? 0 : Math.floor(annual * percent / 100);
    const received = optedOut ? 0 : round2(annual);
    hicbc = { children, optedOut, childBenefitAnnual: round2(annual), received, percent, charge, netKept: round2(received - charge), threshold: cb.hicbc.threshold, fullWithdrawal: cb.hicbc.fullWithdrawal };
    if (optedOut && percent > 0 && percent < 100) warnings.push(`You have opted out of Child Benefit payments but would only lose ${percent}% of them to the charge - claiming and paying the charge would leave you ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(annual - Math.floor(annual * percent / 100))} a year better off.`);
  }
  const hicbcCharge = hicbc?.charge || 0;
  const childBenefitReceived = hicbc?.received || 0;

  // ---------------------------------------------------------------- 9. Totals
  // Property: rent less expenses less finance costs is the cash that actually arrives.
  const propertyCash = Math.max(0, rent - propExpensesUsed - (usePropertyAllowance ? propExpenses : 0)) - financeCosts;
  const cashIncome = grossPay + profit + Math.max(0, rent - propExpensesUsed - (usePropertyAllowance ? propExpenses : 0)) + savings + dividends + otherIncome;
  const totalDeductions = incomeTaxTotal + niTotal + studentLoanTotal + hicbcCharge;
  const takeHome = cashIncome - financeCosts - pensionCash - sePensionPaid - totalDeductions + childBenefitReceived;
  const grossIncome = totalIncome + (method === 'salary_sacrifice' || method === 'net_pay' ? pensionGross : 0);

  const r = (v) => round2(v);
  const roundPieces = (arr) => arr.map((p) => ({ ...p, amount: r(p.amount), tax: r(p.tax) }));

  return {
    taxYear: rates.taxYear,
    region,
    warnings,
    income: {
      employment: { salary, bonus, grossPay, taxableBenefits: benefits, expenses: empExpenses, pensionMethod: method, pensionGross: r(pensionGross), pensionCash: r(pensionCash), taxablePay: r(taxablePay), niablePay: r(niablePay), taxableIncome: r(employmentIncome) },
      selfEmployment: { turnover, expenses, deduction: useTradingAllowance ? 'trading_allowance' : 'expenses', tradingAllowanceUsed: r(tradingAllowanceUsed), expensesUsed: r(expensesUsed), profit: r(profit), pensionPaid: r(sePensionPaid), pensionGross: r(sePensionGross) },
      property: { rentalIncome: rent, expenses: propExpenses, financeCosts, deduction: usePropertyAllowance ? 'property_allowance' : 'expenses', propertyAllowanceUsed: r(propertyAllowanceUsed), expensesUsed: r(propExpensesUsed), profit: r(propertyProfit), cash: r(propertyCash) },
      savings, dividends, otherIncome,
      nonSavings: r(nonSavings), total: r(totalIncome), gross: r(grossIncome), cash: r(cashIncome),
    },
    allowances: {
      personalAllowanceStandard: paStandard, incomeLimit: it.personalAllowanceIncomeLimit,
      adjustedNetIncome: r(adjustedNetIncome), giftAidGross: r(giftAidGross), reliefAtSourceGross: r(rasGross),
      taper: paTaper, personalAllowance, blindPersonsAllowance: blind, marriageAllowance: marriage, marriageTransfer,
      total: allowanceTotal, unused: r(allowanceUnused),
      allocated: { nonSavings: r(allowNS), savings: r(allowSav), dividends: r(allowDiv) },
      taxable: { nonSavings: r(taxableNS), savings: r(taxableSav), dividends: r(taxableDiv), total: r(taxableTotal) },
    },
    incomeTax: {
      level, bandExtension: r(extension),
      bands: nsBands.map((b) => ({ ...b, to: b.to === Infinity ? null : b.to })),
      ukBands: ukBands.map((b) => ({ ...b, to: b.to === Infinity ? null : b.to })),
      nonSavings: { pieces: roundPieces(nsPieces), tax: r(nonSavingsTax) },
      savings: { pieces: roundPieces(savPieces), tax: r(savingsTax), startingRateAvailable: r(startingRateAvail), personalSavingsAllowance: psa },
      dividends: { pieces: roundPieces(divPieces), tax: r(dividendTax), allowance: it.dividends.allowance },
      beforeReducers: r(taxBeforeReducers), marriageReducer: r(marriageReducer),
      financeCostReducer: r(financeCostReducer), financeCostReliefBase: r(financeCostReliefBase), financeCostReliefRate: it.financeCostReliefRate,
      total: r(incomeTaxTotal),
    },
    nationalInsurance: {
      class1: { niablePay: r(niablePay), primaryThreshold: c1.primaryThreshold, upperEarningsLimit: c1.upperEarningsLimit, mainRate: c1.employeeMainRate, upperRate: c1.employeeUpperRate, main: r(class1Main), upper: r(class1Upper), total: r(class1Employee), employer: r(class1Employer), employerRate: c1.employerRate, secondaryThreshold: c1.secondaryThreshold },
      class4: { profit: r(profit), lowerProfitsLimit: c4.lowerProfitsLimit, upperProfitsLimit: c4.upperProfitsLimit, mainRate: c4.mainRate, upperRate: c4.upperRate, mainBandProfits: r(c4MainBand), main: r(class4Main), displacedProfits: r(c4Displaced), upper: r(class4Upper), total: r(class4), annualMaximumApplied: c4Displaced > 0.005 },
      class2: { status: class2Status, smallProfitsThreshold: c2.smallProfitsThreshold, weeklyRate: c2.weeklyRate, voluntaryAnnual: class2Voluntary },
      total: r(niTotal),
    },
    studentLoans: { plans, income: r(slIncome), unearnedIncluded: r(slUnearned), undergraduate: undergrad, postgraduate, total: studentLoanTotal },
    hicbc,
    totals: {
      grossIncome: r(grossIncome), cashIncome: r(cashIncome), pensionCash: r(pensionCash + sePensionPaid),
      incomeTax: r(incomeTaxTotal), nationalInsurance: r(niTotal), studentLoans: studentLoanTotal, hicbc: hicbcCharge, childBenefitReceived: r(childBenefitReceived), financeCosts: r(financeCosts),
      totalDeductions: r(totalDeductions), takeHome: r(takeHome), takeHomeMonthly: r(takeHome / 12), takeHomeWeekly: r(takeHome / 52),
      effectiveRate: cashIncome > 0 ? totalDeductions / cashIncome : 0,
      employerCost: r(grossPay + class1Employer + (method === 'salary_sacrifice' ? pensionGross : 0)),
    },
  };
}

/**
 * Marginal deduction rate: how much of the next £100 of earnings is lost to tax, NI and
 * student loan. Uses employment income when present, otherwise self-employment turnover.
 */
export function marginalRate(input, rates, step = 100) {
  const base = calculate(input, rates);
  const next = JSON.parse(JSON.stringify(input || {}));
  const hasEmployment = num(next.employment?.salary) > 0;
  if (hasEmployment) next.employment.salary = num(next.employment.salary) + step;
  else if (num(next.selfEmployment?.turnover) > 0) next.selfEmployment.turnover = num(next.selfEmployment.turnover) + step;
  else return null;
  const after = calculate(next, rates);
  const extraDeductions = (after.totals.totalDeductions - base.totals.totalDeductions);
  // Pension contributions that scale with salary are not a "deduction" for this purpose.
  return { rate: clamp(extraDeductions / step, 0, 1.5), on: hasEmployment ? 'employment' : 'selfEmployment', step };
}

export const _internal = { buildBands, allocate, bandAt, num };
