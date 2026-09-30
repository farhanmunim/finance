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
/** Fill in fields added to the tax-year data after launch, so older data files still work. */
export function withDefaults(rates) {
  const it = { propertyAllowance: 1000, financeCostReliefRate: 0.2, tradingAllowance: 1000, basicRate: 0.2, ...rates.incomeTax };
  it.rentARoom = it.rentARoom || { threshold: 7500, sharedThreshold: 3750 };
  return {
    ...rates,
    incomeTax: it,
    pensions: rates.pensions || { annualAllowance: 60000, reliefMinimumGross: 3600 },
    selfAssessment: rates.selfAssessment || { paymentsOnAccountMinimum: 1000, collectedAtSourceShare: 0.8 },
  };
}

export function calculate(input = {}, rates) {
  if (!rates) throw new Error('rates are required');
  rates = withDefaults(rates);
  const seAuto = num(input.selfEmployment?.turnover) > 0 && !['expenses', 'trading_allowance'].includes(input.selfEmployment?.deduction);
  const prAuto = num(input.property?.rentalIncome) > 0 && !['expenses', 'property_allowance'].includes(input.property?.deduction);
  if (seAuto || prAuto) {
    // "Automatic": try each allowance choice and keep the one with the lowest total deductions.
    const seOpts = seAuto ? ['expenses', 'trading_allowance'] : [input.selfEmployment?.deduction];
    const prOpts = prAuto ? (num(input.property?.lodgerIncome) > 0 ? ['expenses'] : ['expenses', 'property_allowance']) : [input.property?.deduction];
    let best = null;
    for (const se of seOpts) for (const pr of prOpts) {
      const r = calculateOnce({ ...input, selfEmployment: { ...(input.selfEmployment || {}), deduction: se }, property: { ...(input.property || {}), deduction: pr } }, rates);
      if (!best || r.totals.totalDeductions < best.totals.totalDeductions - 0.005) best = r;
    }
    if (seAuto) best.income.selfEmployment.auto = true;
    if (prAuto) best.income.property.auto = true;
    best.warnings = best.warnings.filter((w) => !/trading allowance - deducting actual expenses|property allowance, so it has not been applied/.test(w));
    return best;
  }
  return calculateOnce(input, rates);
}

function calculateOnce(input = {}, rates, nested = false) {
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
  const payrollGiving = num(emp.payrollGiving); // Give As You Earn: taken from pay before tax, not NI
  const grossPay = salary + bonus;
  const pension = emp.pension || {};
  const method = ['salary_sacrifice', 'net_pay', 'relief_at_source'].includes(pension.method) ? pension.method : 'none';
  let pensionGross = 0;
  if (method !== 'none') {
    pensionGross = pension.type === 'amount' ? num(pension.value) : salary * (num(pension.value) / 100);
    // A deduction from pay cannot exceed the pay; a relief-at-source contribution can (it is
    // paid from your own money), so that is checked against the relief limit below instead.
    if (method !== 'relief_at_source' && pensionGross > grossPay) {
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
  const employmentIncome = Math.max(0, taxablePay + benefits - empExpenses - payrollGiving);

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
  // Jointly owned property: only your share of the income, costs and interest is yours to declare.
  const share = prop.share == null || prop.share === '' ? 1 : clamp(num(prop.share) / 100, 0, 1);
  const rentTotal = num(prop.rentalIncome);
  const rent = rentTotal * share;
  const propExpenses = num(prop.expenses) * share;
  const replacementItems = num(prop.replacementItems) * share; // replacement of domestic items relief
  const financeCosts = num(prop.financeCosts) * share;
  const financeCostsBroughtForward = num(prop.financeCostsBroughtForward); // unused relief from earlier years (already your share)
  const lossesBroughtForward = num(prop.lossesBroughtForward); // property losses from earlier years (already your share)
  // Rent a Room: a lodger in your own home. Up to the threshold is tax-free; above it, the excess
  // over the threshold is taxed with no expenses (the scheme's simple method).
  const lodgerIncome = num(prop.lodgerIncome);
  const rentARoomThreshold = prop.lodgerShared ? it.rentARoom.sharedThreshold : it.rentARoom.threshold;
  const lodgerTaxable = lodgerIncome > rentARoomThreshold ? lodgerIncome - rentARoomThreshold : 0;
  const rentARoomReliefUsed = Math.min(lodgerIncome, rentARoomThreshold);
  let usePropertyAllowance = prop.deduction === 'property_allowance';
  if (usePropertyAllowance && lodgerIncome > 0) {
    warnings.push('The £1,000 property allowance cannot be claimed in a year when Rent a Room relief applies, so expenses have been deducted instead.');
    usePropertyAllowance = false;
  }
  const propertyAllowanceUsed = usePropertyAllowance ? Math.min(it.propertyAllowance, rent) : 0;
  const propExpensesUsed = usePropertyAllowance ? 0 : propExpenses;
  const replacementItemsUsed = usePropertyAllowance ? 0 : replacementItems;
  const propertyResult = rent - propertyAllowanceUsed - propExpensesUsed - replacementItemsUsed; // may be a loss
  const propertyCurrentLoss = Math.max(0, -propertyResult);
  const propertyProfitBeforeLosses = Math.max(0, propertyResult) + lodgerTaxable;
  const propertyLossUsed = Math.min(lossesBroughtForward, propertyProfitBeforeLosses);
  const propertyProfit = propertyProfitBeforeLosses - propertyLossUsed;
  const propertyLossesCarriedForward = lossesBroughtForward - propertyLossUsed + propertyCurrentLoss;

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

  // Pension relief limits: gross contributions above the higher of relevant earnings and £3,600
  // get no relief, and the annual allowance (£60,000, ignoring carry forward and tapering) caps
  // the total that can go in without a charge.
  const relevantEarnings = grossPay + benefits + profit;
  const memberGross = (method === 'salary_sacrifice' ? 0 : pensionGross) + sePensionGross;
  const pn = rates.pensions || { annualAllowance: 60000, reliefMinimumGross: 3600 };
  if (memberGross > Math.max(pn.reliefMinimumGross, relevantEarnings) + 0.5) {
    warnings.push(`Tax relief on pension contributions is limited to 100% of your earnings (or £${pn.reliefMinimumGross.toLocaleString('en-GB')} gross if lower). Contributions above that get no relief - the calculation assumes they are within the limit.`);
  }
  if (pensionGross + sePensionGross > pn.annualAllowance + 0.5) {
    warnings.push(`Pension contributions exceed the £${pn.annualAllowance.toLocaleString('en-GB')} annual allowance. Unless you have unused allowance from the previous three years, the excess is taxed as income (not modelled).`);
  }

  const paStandard = it.personalAllowance;
  const paExcess = Math.max(0, adjustedNetIncome - it.personalAllowanceIncomeLimit);
  const paTaper = Math.min(paStandard, Math.floor(paExcess / 2));
  const personalAllowance = paStandard - paTaper;
  const blind = adj.blindPersonsAllowance ? it.blindPersonsAllowance : 0;
  const marriage = ['transfer', 'receive'].includes(adj.marriageAllowance) ? adj.marriageAllowance : 'none';
  const marriageTransfer = marriage === 'transfer' ? Math.min(it.marriageAllowanceTransfer, personalAllowance) : 0;
  if (marriage === 'transfer' && totalIncome > paStandard + (region === 'scotland' ? it.bands.scotland[2].upTo : it.bands.ruk[0].upTo)) {
    warnings.push('Marriage Allowance can only be transferred by someone who is not a higher-rate taxpayer. Your income looks too high to transfer it.');
  }
  const allowanceTotal = personalAllowance + blind - marriageTransfer;

  // ---------------------------------------------------------------- 5. Income tax
  const extension = rasGross + giftAidGross; // basic (and higher) rate limits extended
  const ukBands = buildBands(it.bands.ruk, extension);
  // Scottish taxpayers: the starter rate limit is not extended; the limits above it are.
  const nsBands = region === 'scotland' ? buildBands(it.bands.scotland, extension, { extendFrom: 1 }) : ukBands;

  // Allowances go against non-savings income first. ITA 2007 s25(2) lets the rest be set against
  // savings or dividends in whichever way gives the lowest tax, so every breakpoint of that split
  // is evaluated and the cheapest is used.
  const allowNS = Math.min(allowanceTotal, nonSavings);
  const taxableNS = nonSavings - allowNS;
  const remaining = allowanceTotal - allowNS;
  const startingRateAvail = Math.max(0, it.savings.startingRateBand - taxableNS);

  const taxSavingsAndDividends = (allowSav) => {
    const allowDiv = Math.min(remaining - allowSav, dividends);
    const taxableSav = savings - allowSav;
    const taxableDiv = dividends - allowDiv;
    const taxableTotal = taxableNS + taxableSav + taxableDiv;
    // Taxpayer level for the Personal Savings Allowance (ITA 2007 s12B): the highest UK-wide
    // rate any of the income reaches, counting the 0% savings and dividend bands at their
    // position. Scottish and Welsh taxpayers are assessed as if they were not (s12B(8)).
    const level = taxableTotal > 0 ? levelOfBand(bandAt(ukBands, Math.max(0, taxableTotal - 0.01)).id) : 'basic';
    const psa = it.savings.personalSavingsAllowance[level];
    const startingRateUsed = Math.min(startingRateAvail, taxableSav);
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
    const tax = savPieces.reduce((a, p) => a + p.tax, 0) + divPieces.reduce((a, p) => a + p.tax, 0);
    return { allowSav, allowDiv, taxableSav, taxableDiv, taxableTotal, level, psa, startingRateUsed, psaUsed, savPieces, divPieces, tax };
  };
  // Candidate splits: the default (savings first), all to dividends, and every point where a
  // 0% band or a rate band boundary is crossed. Tax is piecewise linear between them.
  const maxSav = Math.min(remaining, savings);
  const minSav = Math.max(0, remaining - dividends);
  const candidates = new Set([maxSav, minSav]); // default order first, so ties keep it
  const addCand = (x) => { if (Number.isFinite(x) && x > minSav && x < maxSav) candidates.add(x); };
  addCand(savings - startingRateAvail);
  for (const p of Object.values(it.savings.personalSavingsAllowance)) addCand(savings - startingRateAvail - p);
  addCand(remaining - (dividends - it.dividends.allowance));
  for (const b of ukBands) if (b.to !== Infinity) { addCand(taxableNS + savings - b.to); addCand(taxableNS + savings + dividends - remaining - b.to); }
  let best = null;
  for (const x of candidates) { const r = taxSavingsAndDividends(x); if (!best || r.tax < best.tax - 0.005) best = r; }
  const { allowSav, allowDiv, taxableSav, taxableDiv, taxableTotal, level, psa, startingRateUsed, psaUsed, savPieces, divPieces } = best;
  const allowanceUnused = allowanceTotal - allowNS - allowSav - allowDiv;
  const allowanceReordered = allowSav < maxSav - 0.005;

  const nsPieces = allocate(nsBands, 0, taxableNS, null, 'nonSavings');

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
  const financeCostsAvailable = financeCosts + financeCostsBroughtForward;
  let financeCostsCarriedForward = 0;
  if (financeCostsAvailable > 0 && !usePropertyAllowance) {
    financeCostReliefBase = Math.min(financeCostsAvailable, propertyProfit, taxableNS);
    financeCostReducer = Math.min(Math.max(0, taxBeforeReducers - marriageReducer), financeCostReliefBase * it.financeCostReliefRate);
    financeCostsCarriedForward = financeCostsAvailable - financeCostReliefBase;
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
  const slIncome = niablePay + profit + slUnearned;
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
  const propertyCashBeforeInterest = rent - propExpenses - replacementItems + lodgerIncome;
  const propertyCash = propertyCashBeforeInterest - financeCosts;
  const cashIncome = grossPay + profit + propertyCashBeforeInterest + savings + dividends + otherIncome;
  const totalDeductions = incomeTaxTotal + niTotal + studentLoanTotal + hicbcCharge;
  const takeHome = cashIncome - financeCosts - pensionCash - sePensionPaid - payrollGiving - totalDeductions + childBenefitReceived;

  // ---------------------------------------------------------------- 9b. How the tax is collected: PAYE vs Self Assessment
  // Payroll deducts tax on employment income alone (standard code), Class 1 NI and student loan
  // on pay. Everything else is settled through a Self Assessment return: the balance of income
  // tax, Class 4 NI, the Child Benefit charge and student loan on other income. Payments on
  // account for the following year are due when the SA bill is £1,000 or more and less than 80%
  // of the total was collected at source.
  const sa = rates.selfAssessment || { paymentsOnAccountMinimum: 1000, collectedAtSourceShare: 0.8 };
  const hasSelfAssessmentIncome = profit > 0 || rent > 0 || lodgerIncome > 0 || savings > 0 || dividends > 0 || otherIncome > 0 || hicbcCharge > 0 || turnover > 0;
  let collection = null;
  if (!nested && (grossPay > 0 || hasSelfAssessmentIncome)) {
    const payeRun = grossPay > 0 ? calculateOnce({ region, employment: input.employment, studentLoans: input.studentLoans, adjustments: { marriageAllowance: adj.marriageAllowance, blindPersonsAllowance: adj.blindPersonsAllowance } }, rates, true) : null;
    const payeTax = payeRun ? payeRun.incomeTax.total : 0;
    const payeSL = payeRun ? payeRun.studentLoans.total : 0;
    const saIncomeTax = round2(incomeTaxTotal - payeTax);
    const saStudentLoan = studentLoanTotal - payeSL;
    const totalLiability = incomeTaxTotal + class4 + hicbcCharge;
    const relevantAmount = round2(saIncomeTax + class4 + hicbcCharge);
    const balancingPayment = round2(relevantAmount + saStudentLoan);
    const poaRequired = relevantAmount >= sa.paymentsOnAccountMinimum && payeTax < sa.collectedAtSourceShare * totalLiability;
    const reasons = [];
    if (turnover > it.tradingAllowance) reasons.push('self-employed income over £1,000');
    if (rentTotal * share + lodgerIncome > it.propertyAllowance && (rent > 0 || lodgerTaxable > 0)) reasons.push('property income');
    if (dividends > 10000) reasons.push('dividends over £10,000');
    if (savings > 10000) reasons.push('savings interest over £10,000');
    if (hicbcCharge > 0) reasons.push('the High Income Child Benefit Charge');
    if (rasGross > 0 && level !== 'basic') reasons.push('higher-rate pension relief to claim');
    if (giftAidPaid > 0 && level !== 'basic') reasons.push('higher-rate Gift Aid relief to claim');
    collection = {
      paye: { incomeTax: round2(payeTax), nationalInsurance: round2(class1Employee), studentLoan: payeSL, total: round2(payeTax + class1Employee + payeSL) },
      selfAssessment: { incomeTax: saIncomeTax, class4: round2(class4), hicbc: hicbcCharge, studentLoan: saStudentLoan, balancingPayment, relevantAmount, paymentsOnAccountRequired: poaRequired, paymentOnAccount: poaRequired ? round2(relevantAmount / 2) : 0, likelyNeedsReturn: hasSelfAssessmentIncome && (reasons.length > 0 || balancingPayment > 0.5), reasons },
    };
  }

  // ---------------------------------------------------------------- 10. Charitable giving
  // Gift Aid: the charity reclaims basic-rate tax (25p per £1 given). Your basic and higher rate
  // limits are extended by the gross donation, and adjusted net income falls by it, so higher-rate
  // taxpayers save more tax and the Personal Allowance taper and Child Benefit charge ease.
  // You must have paid at least as much tax as the charities reclaim.
  let giving = null;
  if (!nested && (giftAidPaid > 0 || payrollGiving > 0)) {
    const without = calculateOnce({ ...input, employment: { ...(input.employment || {}), payrollGiving: 0 }, adjustments: { ...(input.adjustments || {}), giftAid: 0 } }, rates, true);
    const taxSaved = round2(without.totals.totalDeductions - totalDeductions);
    const charityClaims = round2(giftAidGross - giftAidPaid);
    const shortfall = Math.max(0, charityClaims - incomeTaxTotal);
    giving = {
      giftAidPaid, giftAidGross: round2(giftAidGross), charityClaims, payrollGiving,
      charityReceives: round2(giftAidGross + payrollGiving),
      bandExtension: round2(giftAidGross),
      taxSaved,
      netCost: round2(giftAidPaid + payrollGiving - taxSaved),
      taxCoverShortfall: round2(shortfall),
      incomeTaxWithout: without.incomeTax.total,
      hicbcWithout: without.totals.hicbc,
      personalAllowanceWithout: without.allowances.personalAllowance,
    };
    if (shortfall > 0.5) warnings.push(`Gift Aid: the charity reclaims ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(charityClaims)} but you only pay ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(incomeTaxTotal)} income tax. HMRC can ask you to pay the difference, so either give less under Gift Aid or do not tick the Gift Aid box.`);
  }
  const grossIncome = totalIncome + (method === 'salary_sacrifice' || method === 'net_pay' ? pensionGross : 0);

  const r = (v) => round2(v);
  const roundPieces = (arr) => arr.map((p) => ({ ...p, amount: r(p.amount), tax: r(p.tax) }));

  return {
    taxYear: rates.taxYear,
    region,
    warnings,
    income: {
      employment: { salary, bonus, grossPay, taxableBenefits: benefits, expenses: empExpenses, payrollGiving, pensionMethod: method, pensionGross: r(pensionGross), pensionCash: r(pensionCash), taxablePay: r(taxablePay), niablePay: r(niablePay), taxableIncome: r(employmentIncome) },
      selfEmployment: { turnover, expenses, deduction: useTradingAllowance ? 'trading_allowance' : 'expenses', tradingAllowanceUsed: r(tradingAllowanceUsed), expensesUsed: r(expensesUsed), profit: r(profit), pensionPaid: r(sePensionPaid), pensionGross: r(sePensionGross) },
      property: {
        rentalIncomeTotal: rentTotal, share, rentalIncome: r(rent), expenses: r(propExpenses), replacementItems: r(replacementItems), financeCosts: r(financeCosts), financeCostsBroughtForward,
        deduction: usePropertyAllowance ? 'property_allowance' : 'expenses', propertyAllowanceUsed: r(propertyAllowanceUsed), expensesUsed: r(propExpensesUsed), replacementItemsUsed: r(replacementItemsUsed),
        result: r(propertyResult), currentLoss: r(propertyCurrentLoss), lossesBroughtForward, lossUsed: r(propertyLossUsed), lossesCarriedForward: r(propertyLossesCarriedForward),
        lodgerIncome, rentARoomThreshold, rentARoomReliefUsed: r(rentARoomReliefUsed), lodgerTaxable: r(lodgerTaxable),
        profitBeforeLosses: r(propertyProfitBeforeLosses), profit: r(propertyProfit), cash: r(propertyCash),
      },
      savings, dividends, otherIncome,
      nonSavings: r(nonSavings), total: r(totalIncome), gross: r(grossIncome), cash: r(cashIncome),
    },
    allowances: {
      personalAllowanceStandard: paStandard, incomeLimit: it.personalAllowanceIncomeLimit,
      adjustedNetIncome: r(adjustedNetIncome), giftAidGross: r(giftAidGross), reliefAtSourceGross: r(rasGross),
      taper: paTaper, personalAllowance, blindPersonsAllowance: blind, marriageAllowance: marriage, marriageTransfer,
      total: allowanceTotal, unused: r(allowanceUnused),
      allocated: { nonSavings: r(allowNS), savings: r(allowSav), dividends: r(allowDiv) }, reordered: allowanceReordered,
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
      financeCostsAvailable: r(financeCostsAvailable), financeCostsCarriedForward: r(financeCostsCarriedForward),
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
    giving,
    collection,
    totals: {
      grossIncome: r(grossIncome), cashIncome: r(cashIncome), pensionCash: r(pensionCash + sePensionPaid),
      incomeTax: r(incomeTaxTotal), nationalInsurance: r(niTotal), studentLoans: studentLoanTotal, hicbc: hicbcCharge, childBenefitReceived: r(childBenefitReceived), financeCosts: r(financeCosts), payrollGiving: r(payrollGiving),
      totalDeductions: r(totalDeductions), takeHome: r(takeHome), takeHomeMonthly: r(takeHome / 12), takeHomeWeekly: r(takeHome / 52),
      effectiveRate: cashIncome > 0 ? totalDeductions / cashIncome : 0,
      employerCost: r(grossPay + class1Employer + (method === 'salary_sacrifice' ? pensionGross : 0)),
    },
  };
}

/**
 * Tax caused by adding a let property on top of someone's other income, using the full
 * calculation (Personal Allowance, band straddling, taper, Scottish rates, finance-cost credit
 * caps). Returns the extra tax, the credit actually given, and what the tax would have been if
 * mortgage interest were fully deductible.
 * @param {object} p { region, otherIncome, rentalIncome, expenses, financeCosts, deduction }
 */
export function propertyIncrementalTax(p, rates) {
  const base = calculate({ region: p.region, employment: { salary: num(p.otherIncome) } }, rates);
  const withProp = calculate({ region: p.region, employment: { salary: num(p.otherIncome) }, property: { rentalIncome: p.rentalIncome, expenses: p.expenses, financeCosts: p.financeCosts, deduction: p.deduction || 'auto' } }, rates);
  const oldRules = calculate({ region: p.region, employment: { salary: num(p.otherIncome) }, property: { rentalIncome: p.rentalIncome, expenses: num(p.expenses) + num(p.financeCosts), financeCosts: 0, deduction: 'expenses' } }, rates);
  const tax = round2(withProp.incomeTax.total - base.incomeTax.total);
  return {
    tax,
    taxBeforeCredit: round2(tax + withProp.incomeTax.financeCostReducer),
    credit: withProp.incomeTax.financeCostReducer,
    creditBase: withProp.incomeTax.financeCostReliefBase,
    creditRate: withProp.incomeTax.financeCostReliefRate,
    oldRulesTax: round2(oldRules.incomeTax.total - base.incomeTax.total),
    profit: withProp.income.property.profit,
    deductionUsed: withProp.income.property.deduction,
    allowanceUsed: withProp.income.property.propertyAllowanceUsed,
    personalAllowanceUnusedBefore: base.allowances.unused,
    hicbc: null,
    level: withProp.incomeTax.level,
    warnings: withProp.warnings,
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
