#!/usr/bin/env node
/**
 * Fetches the official GOV.UK pages that publish UK tax and National Insurance rates and
 * compares them with the figures stored in data/tax-years/<year>.json.
 *
 *   node scripts/update-rates.mjs --check            # report differences, exit 1 if any
 *   node scripts/update-rates.mjs --write            # update the JSON with GOV.UK's figures
 *   node scripts/update-rates.mjs --check --year 2025-26
 *
 * Uses the GOV.UK Content API (https://www.gov.uk/api/content/<path>) which returns the page
 * body as HTML. Tables are flattened to "cell | cell |" text and read with regular expressions.
 * No third-party dependencies.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const yearArg = args[args.indexOf('--year') + 1];
const indexPath = resolve('data/tax-years/index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const yearId = args.includes('--year') && yearArg ? yearArg : index.default;
const meta = index.years.find((y) => y.id === yearId);
if (!meta) { console.error(`Unknown tax year ${yearId}`); process.exit(2); }
const filePath = resolve('.' + meta.file);
const data = JSON.parse(readFileSync(filePath, 'utf8'));
const [y1, y2] = yearId.split('-');
const yearStart = Number(y1);
const yearEnd = yearStart + 1;
const yearLabel = `${yearStart} to ${yearEnd}`; // GOV.UK's "2026 to 2027"
const isCurrent = yearId === index.default;

// ------------------------------------------------------------------ fetch helpers
function strip(html) {
  return html
    .replace(/<\/(p|tr|h\d|li|div)>/g, '\n').replace(/<\/t[dh]>/g, ' | ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|’/g, "'").replace(/\s+/g, ' ');
}
function collectHtml(o, out = []) {
  if (!o) return out;
  if (typeof o === 'string') { if (/<(p|table|h2)[\s>]/.test(o)) out.push(o); return out; }
  if (Array.isArray(o)) o.forEach((x) => collectHtml(x, out));
  else if (typeof o === 'object') Object.values(o).forEach((v) => collectHtml(v, out));
  return out;
}
async function page(path) {
  const url = `https://www.gov.uk/api/content/${path}`;
  const res = await fetch(url, { headers: { 'user-agent': 'uk-finance-tools rate checker' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const json = await res.json();
  return { text: collectHtml(json.details).map(strip).join(' '), updated: json.public_updated_at, url: `https://www.gov.uk/${path}` };
}
const money = (s) => Number(String(s).replace(/[£,]/g, ''));
const pct = (s) => Math.round(Number(String(s).replace('%', '')) * 10000) / 1000000;
const m = (text, re, conv = money) => { const r = text.match(re); return r ? conv(r[1]) : undefined; };

/** Column lookup for the HMRC "current and past years" tables: header "2026 to 2027 | 2025 to 2026 | ..." */
function column(text, rowLabelRe, headerRe = /(\d{4} to \d{4} \|(?: \d{4} to \d{4} \|)+)/) {
  const h = text.match(headerRe);
  if (!h) return undefined;
  const years = h[1].split('|').map((s) => s.trim()).filter(Boolean);
  const idx = years.indexOf(yearLabel);
  if (idx < 0) return undefined;
  const row = text.match(rowLabelRe);
  if (!row) return undefined;
  const cells = row[1].split('|').map((s) => s.trim()).filter(Boolean);
  return cells[idx];
}

// ------------------------------------------------------------------ extract
const found = {}; // path -> { value, source }
const set = (path, value, source) => { if (value !== undefined && !Number.isNaN(value)) found[path] = { value, source }; };
const problems = [];

async function run() {
  // 1. Employer rates & thresholds page for the year (bands, NI, student loans)
  try {
    const p = await page(`guidance/rates-and-thresholds-for-employers-${yearStart}-to-${yearEnd}`);
    const t = p.text;
    set('incomeTax.personalAllowance', m(t, /personal allowance for the \d{4} to \d{4} tax year is: [^£]*£[\d,]+ per week [^£]*£[\d,]+ per month [^£]*£([\d,]+) per year/i), p.url);
    // England / NI bands (first occurrence)
    const ruk = t.match(/Basic tax rate \| 20% \| Up to £([\d,]+) \| Higher tax rate \| 40% \| From £[\d,]+ to £([\d,]+) \| Additional tax rate \| (\d+)%/);
    if (ruk) {
      set('incomeTax.bands.ruk.0.upTo', money(ruk[1]), p.url);
      set('incomeTax.bands.ruk.1.upTo', money(ruk[2]), p.url);
      set('incomeTax.bands.ruk.2.rate', pct(ruk[3]), p.url);
    } else problems.push('Could not read England/NI bands from employer page');
    const scot = t.match(/Starter tax rate \| ([\d.]+)% \| Up to £([\d,]+) \| Basic tax rate \| ([\d.]+)% \| From £[\d,]+ to £([\d,]+) \| Intermediate tax rate \| ([\d.]+)% \| From £[\d,]+ to £([\d,]+) \| Higher tax rate \| ([\d.]+)% \| From £[\d,]+ to £([\d,]+) \| Advanced tax rate \| ([\d.]+)% \| From £[\d,]+ to £([\d,]+) \| Top tax rate \| ([\d.]+)%/);
    if (scot) {
      const s = 'incomeTax.bands.scotland';
      set(`${s}.0.rate`, pct(scot[1]), p.url); set(`${s}.0.upTo`, money(scot[2]), p.url);
      set(`${s}.1.rate`, pct(scot[3]), p.url); set(`${s}.1.upTo`, money(scot[4]), p.url);
      set(`${s}.2.rate`, pct(scot[5]), p.url); set(`${s}.2.upTo`, money(scot[6]), p.url);
      set(`${s}.3.rate`, pct(scot[7]), p.url); set(`${s}.3.upTo`, money(scot[8]), p.url);
      set(`${s}.4.rate`, pct(scot[9]), p.url); set(`${s}.4.upTo`, money(scot[10]), p.url);
      set(`${s}.5.rate`, pct(scot[11]), p.url);
    } else problems.push('Could not read Scottish bands from employer page');
    const thr = (label) => m(t, new RegExp(`${label} \\|[^|]*?£([\\d,]+) per year`, 'i'));
    set('nationalInsurance.class1.lowerEarningsLimit', thr('Lower earnings limit'), p.url);
    set('nationalInsurance.class1.primaryThreshold', thr('Primary threshold'), p.url);
    set('nationalInsurance.class1.secondaryThreshold', thr('Secondary threshold'), p.url);
    set('nationalInsurance.class1.upperEarningsLimit', thr('Upper earnings limit'), p.url);
    const emp = t.match(/Balance of earnings above upper earnings limit \| A \| (\d+)% \| (\d+)% \| (\d+)% \|/);
    if (emp) { set('nationalInsurance.class1.employeeMainRate', pct(emp[2]), p.url); set('nationalInsurance.class1.employeeUpperRate', pct(emp[3]), p.url); }
    else problems.push('Could not read employee NI rates');
    set('nationalInsurance.class1.employerRate', m(t, /apprentices and veterans \| ([\d.]+)% \|/, pct), p.url);
    set('nationalInsurance.class1.employmentAllowance', m(t, /Employment Allowance for \d{4} to \d{4} is £([\d,]+)/), p.url);
    for (const [k, plan] of [['plan1', 'plan 1'], ['plan2', 'plan 2'], ['plan4', 'plan 4'], ['plan5', 'plan 5']]) {
      set(`studentLoans.${k}.threshold`, m(t, new RegExp(`student loan ${plan} \\|\\s*£([\\d,]+) per year`, 'i')), p.url);
    }
    set('studentLoans.postgraduate.threshold', m(t, /postgraduate loan \|\s*£([\d,]+) per year/i), p.url);
    set('studentLoans.plan2.rate', m(t, /Student loan deductions \| (\d+)%/i, pct), p.url);
    set('studentLoans.postgraduate.rate', m(t, /Postgraduate loan deductions \| (\d+)%/i, pct), p.url);
  } catch (e) { problems.push(`Employer rates page: ${e.message}`); }

  // 2. HMRC NI rates and allowances (Class 2 / Class 4 by year)
  try {
    const p = await page('government/publications/rates-and-allowances-national-insurance-contributions/rates-and-allowances-national-insurance-contributions');
    const t = p.text;
    const cls = t.slice(t.indexOf('Class 2 and Class 4'));
    set('nationalInsurance.class2.smallProfitsThreshold', money(column(cls, /Small Profits Threshold amount per year \|((?: £[\d,]+ \|)+)/)), p.url);
    set('nationalInsurance.class2.weeklyRate', money(column(cls, /Rate per week \|((?: £[\d.]+ \|)+)/)), p.url);
    set('nationalInsurance.class4.lowerProfitsLimit', money(column(cls, /Lower Profits Limit[^|]*\|((?: £[\d,]+ \|)+)/)), p.url);
    set('nationalInsurance.class4.upperProfitsLimit', money(column(cls, /Upper Profits Limit[^|]*\|((?: £[\d,]+ \|)+)/)), p.url);
    set('nationalInsurance.class4.mainRate', pct(column(cls, /Rate between Lower Profits Limit to the Upper Profits Limit \|((?: \d+% \|)+)/)), p.url);
    set('nationalInsurance.class4.upperRate', pct(column(cls, /Rate above Upper Profits Limit \|((?: \d+% \|)+)/)), p.url);
  } catch (e) { problems.push(`NI rates page: ${e.message}`); }

  // 3. HMRC income tax rates and allowances (PA, BPA, dividend allowance and rates, savings)
  try {
    const p = await page('government/publications/rates-and-allowances-income-tax/income-tax-rates-and-allowances-current-and-past');
    const t = p.text;
    set('incomeTax.personalAllowanceIncomeLimit', money(column(t, /Income limit for Personal Allowance \|((?: £[\d,]+ \|)+)/)), p.url);
    set('incomeTax.blindPersonsAllowance', money(column(t, /Blind Person's Allowance \|((?: £[\d,]+ \|)+)/)), p.url);
    set('incomeTax.dividends.allowance', money(column(t, /Dividend allowance \|((?: £[\d,]+ \|)+)/)), p.url);
    const dv = t.slice(t.indexOf('Dividend tax rates'));
    const dh = /(Dividend tax rates \d{4} to \d{4} \|(?: Dividend tax rates \d{4} to \d{4} \|)+)/;
    const col = (re) => { const h = dv.match(dh); const row = dv.match(re); if (!h || !row) return undefined; const years = h[1].split('|').map((s) => s.replace('Dividend tax rates', '').trim()).filter(Boolean); const cells = row[1].split('|').map((s) => s.trim()).filter(Boolean); const i = years.indexOf(yearLabel); return i < 0 ? undefined : cells[i]; };
    set('incomeTax.dividends.rates.basic', pct(col(/Basic rate \|((?: [\d.]+% \|)+)/)), p.url);
    set('incomeTax.dividends.rates.higher', pct(col(/Higher rate \|((?: [\d.]+% \|)+)/)), p.url);
    set('incomeTax.dividends.rates.additional', pct(col(/Additional rate \|((?: [\d.]+% \|)+)/)), p.url);
    set('incomeTax.savings.startingRateBand', money(column(t, /Starting rate for savings \| 0% \|((?: Up to £[\d,]+ \|)+)/)?.replace('Up to ', '')), p.url);
  } catch (e) { problems.push(`Income tax rates page: ${e.message}`); }

  // 4. Current-year-only pages (they describe the current tax year)
  if (isCurrent) {
    try {
      const p = await page('marriage-allowance');
      set('incomeTax.marriageAllowanceTransfer', m(p.text, /transfer £([\d,]+) of your Personal Allowance/), p.url);
    } catch (e) { problems.push(`Marriage allowance page: ${e.message}`); }
    try {
      const p = await page('apply-tax-free-interest-on-savings');
      const psa = p.text.match(/Basic rate \| £([\d,]+) \| Higher rate \| £([\d,]+) \| Additional rate \| £([\d,]+)/);
      if (psa) { set('incomeTax.savings.personalSavingsAllowance.basic', money(psa[1]), p.url); set('incomeTax.savings.personalSavingsAllowance.higher', money(psa[2]), p.url); set('incomeTax.savings.personalSavingsAllowance.additional', money(psa[3]), p.url); }
      else problems.push('Could not read Personal Savings Allowance table');
    } catch (e) { problems.push(`Savings page: ${e.message}`); }
    try {
      const p = await page('child-benefit/what-youll-get');
      set('childBenefit.weeklyEldest', m(p.text, /Eldest or only child \| £([\d.]+)/), p.url);
      set('childBenefit.weeklyOther', m(p.text, /Additional children \| £([\d.]+)/), p.url);
    } catch (e) { problems.push(`Child benefit page: ${e.message}`); }
    try {
      const p = await page('child-benefit-tax-charge');
      set('childBenefit.hicbc.threshold', m(p.text, /earn more than £([\d,]+) a year, you'll have to pay some/), p.url);
      set('childBenefit.hicbc.fullWithdrawal', m(p.text, /earn £([\d,]+) or more, you'll have to pay all/), p.url);
    } catch (e) { problems.push(`HICBC page: ${e.message}`); }
    try {
      const p = await page('rent-room-in-your-home/the-rent-a-room-scheme');
      set('incomeTax.rentARoom.threshold', m(p.text, /threshold of £([\d,]+) per year tax-free/), p.url);
      set('incomeTax.rentARoom.sharedThreshold', m(p.text, /halved to £([\d,]+)/), p.url);
    } catch (e) { problems.push(`Rent a Room page: ${e.message}`); }
    try {
      const p = await page('guidance/tax-free-allowances-on-property-and-trading-income');
      set('incomeTax.tradingAllowance', m(p.text, /up to £([\d,]+) each tax year in tax-free allowances for property or trading income/), p.url);
    } catch (e) { problems.push(`Trading allowance page: ${e.message}`); }
  }

  // ------------------------------------------------------------------ compare
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const setPath = (obj, path, v) => { const ks = path.split('.'); let o = obj; for (const k of ks.slice(0, -1)) o = o[k]; o[ks[ks.length - 1]] = v; };
  const diffs = [];
  const rows = [];
  for (const [path, { value, source }] of Object.entries(found).sort()) {
    const current = get(data, path);
    const same = typeof value === 'number' && typeof current === 'number' ? Math.abs(value - current) < 1e-9 : value === current;
    rows.push({ figure: path, stored: current, govuk: value, status: same ? 'ok' : 'DIFFERENT' });
    if (!same) diffs.push({ path, current, value, source });
  }
  console.log(`\nTax year ${data.label} - ${rows.length} figures checked against GOV.UK\n`);
  console.table(rows);
  if (problems.length) { console.log('\nWarnings (could not verify):'); problems.forEach((p) => console.log(' - ' + p)); }
  if (diffs.length) {
    console.log(`\n${diffs.length} figure(s) differ from GOV.UK:`);
    diffs.forEach((d) => console.log(` - ${d.path}: stored ${d.current}, GOV.UK ${d.value}  (${d.source})`));
    if (WRITE) {
      diffs.forEach((d) => setPath(data, d.path, d.value));
      data.verified = new Date().toISOString().slice(0, 10);
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      console.log(`\nUpdated ${filePath}. Review the diff and run the tests before committing.`);
      process.exit(0);
    }
    process.exit(1);
  }
  if (WRITE) { data.verified = new Date().toISOString().slice(0, 10); writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n'); }
  console.log('\nAll checked figures match GOV.UK.');
}

run().catch((e) => { console.error(e); process.exit(2); });
