# UK Finance Tools

Three small, fast calculators built with plain HTML, CSS and JavaScript. No frameworks, no build step, no tracking. Designed for Cloudflare Pages (free tier) but any static host works.

| Tool | Path | What it does |
| --- | --- | --- |
| Income tax | `/income/` | Income tax, National Insurance, student loan and pension deductions for employees, the self-employed, or both, plus property income, Child Benefit and every rate editable, with each step shown. |
| Mortgage | `/mortgage/` | Monthly payment, total interest, fixed-rate periods, interest-only, overpayments, overpay-vs-save break-even, rate sensitivity, LTV tiers and buy-to-let tax. |
| Pension | `/pension/` | Projected pot, monthly retirement income after tax (drawdown or annuity), State Pension, tax relief, employer contributions, a target income, and what paying in more, retiring earlier or later or lower growth would change. |

## Deploying to Cloudflare Pages

1. Push this repository to GitHub.
2. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages → Connect to Git** and pick the repo.
3. Build settings: **Framework preset: None**, **Build command:** leave empty, **Build output directory:** `/` (the repo root).
4. Deploy. Every push to the production branch redeploys automatically.

`_headers` adds security headers and short caching for `/assets/*` and `/data/*`. `404.html` is served for unknown paths.

## Running locally

```bash
npm run serve        # http://localhost:8080
npm test             # unit tests for the calculation engines and page checks (node:test, no dependencies)
```

Node 20+ is required for the scripts and tests. The site itself needs only a browser.

## How tax rates are kept accurate

All rates, thresholds and allowances live in `data/tax-years/<year>.json`, one file per tax year, with a `sources` list linking every figure to the official GOV.UK page it came from. The pages fetch the file for the selected year at runtime, so updating a JSON file updates the site.

`scripts/update-rates.mjs` fetches those GOV.UK pages through the GOV.UK Content API and compares the published figures with the stored ones:

```bash
npm run rates:check                     # report differences (exit 1 if any)
npm run rates:update                    # write GOV.UK's figures into the JSON
node scripts/update-rates.mjs --check --year 2025-26
```

The `check-rates` GitHub Action runs this on the 1st of each month and opens an issue if anything has changed or a page could not be read. A new tax year is added by copying the latest file, adding it to `data/tax-years/index.json`, and running `rates:update` against it once GOV.UK publishes the employer rates page for that year.

Figures currently covered by the automatic check: Personal Allowance and its income limit, England/NI and Scottish bands, Blind Person's Allowance, Marriage Allowance, dividend allowance and rates, starting rate for savings, Personal Savings Allowance, trading allowance, Class 1 NI thresholds and rates, employer NI and Employment Allowance, Class 2 and Class 4, student loan thresholds and rates, Child Benefit rates and the High Income Child Benefit Charge thresholds.

## Calculation method (income tool)

The form is organised by how the tax is collected: **Employment (PAYE)** and the **Self Assessment** sources (self-employment SA103, property SA105, savings and dividends, pension or other income). You tick which income you have. The results show the full liability, then split it into what payroll deducts (tax on salary alone with a standard code, Class 1 NI, student loan on pay) and the Self Assessment balancing payment (remaining income tax, Class 4 NI, Child Benefit charge, student loan on other income), with payments on account when the bill is £1,000 or more and under 80% was collected at source.

Implemented in `assets/js/tax-engine.js` (pure functions, unit-tested in `tests/`).

1. **Income.** Employment pay after salary sacrifice or net-pay pension contributions, plus taxable benefits, less allowable expenses; self-employed profit (turnover less expenses or the trading allowance, chosen automatically unless overridden); property profit; savings interest; dividends; other income.
2. **Adjusted net income** = total income less gross relief-at-source pension contributions and gross Gift Aid. Used for the Personal Allowance taper and the Child Benefit charge.
3. **Allowances.** Personal Allowance tapered by £1 for every £2 over the income limit; Blind Person's Allowance; Marriage Allowance (transfer reduces the allowance, receipt is a tax reducer for basic-rate taxpayers). Allowances are set against non-savings income first; the remainder is split between savings and dividends in whichever way gives the lowest tax (ITA 2007 s25(2)), evaluated at every breakpoint.
4. **Income tax.** Non-savings income through the rUK or Scottish bands. Savings then dividends are stacked on top using UK-wide bands: starting rate for savings (£5,000 reduced by non-savings income over the allowance), Personal Savings Allowance by taxpayer level (decided on UK bands for everyone, including Scottish taxpayers, per s12B(8)), dividend allowance, dividend rates. Relief-at-source pension and Gift Aid extend the band limits. Warnings flag pension contributions above 100% of earnings or the £60,000 annual allowance.
5. **National Insurance.** Class 1 employee contributions on an annual basis; employer contributions shown for information. Class 4 on profits, with the statutory annual-maximum interaction when someone also pays Class 1 (main-rate Class 4 is reduced by Class 1 already paid; displaced profits are charged at the upper rate). Class 2 is credited above the small profits threshold; voluntary contributions are shown but not deducted.
6. **Student loans.** 9% (Plan 1/2/4/5) over the lowest threshold of the selected plans and 6% (Postgraduate) over its threshold, on employment pay plus profits, plus unearned income when it exceeds £2,000.
7. **Property income (SA105).** Your share of rent from all UK lets less allowable expenses (itemisable into the SA105 categories) and replacement of domestic items relief, or the £1,000 property allowance instead. Losses are carried forward against future property profits only (ITA 2007 s118/119, verified against PIM4210's example). Mortgage interest and other finance costs are not deductible; a tax reducer of 20% × the lower of finance costs (including any brought forward), property profits after losses and non-savings income after allowances is given instead (ITTOIA 2005 s272A/s274A), with the unused amount carried forward. Rent a Room relief for a lodger in your own home (£7,500, or £3,750 if shared) with the excess taxed; it blocks the property allowance. Verified against HMRC's published case studies.
8. **High Income Child Benefit Charge.** 1% of Child Benefit per £200 of adjusted net income over £60,000, all of it from £80,000. Child Benefit received is shown as tax-free income and the charge deducted; opting out of payments removes both.
9. **Allowable employment expenses** reduce taxable pay but not NI.
10. **Charitable giving.** Gift Aid donations are grossed up at the basic rate (the charity reclaims 25p per £1); the gross donation extends the basic and higher rate limits and reduces adjusted net income (so it can restore the Personal Allowance and reduce the Child Benefit charge). The tool shows the tax saved, the net cost, and warns when not enough tax has been paid to cover the charity's reclaim. Payroll Giving is deducted from pay before tax (no gross-up, NI unaffected).

### Custom rates

"Customise tax rates and thresholds" in the form exposes every figure in the tax-year file (allowances, each band's rate and limit for the selected region, savings and dividend rules, NI thresholds and rates, student loan plans, Child Benefit). Edits are applied as overrides on top of the official file (`applyOverrides` in the engine), highlighted in the form, encoded in the shareable URL (`ov` parameter) and flagged in the results.

Known simplifications: annual (not per-pay-period) NI and student loan calculation, no loss relief, no pension annual allowance or tapered annual allowance checks, no Married Couple's Allowance, no capital gains.

## Calculation method (mortgage tool)

Implemented in `assets/js/mortgage-engine.js`. Interest accrues monthly at one twelfth of the annual rate on the opening balance; the standard payment is the annuity amount that clears the balance over the term and is recalculated when the rate changes (initial deal → revert rate). Overpayments reduce the balance immediately and either shorten the term or reduce the payment. Interest-only runs to the end of the term and reports the outstanding balance. A user-entered payment derives the payoff time instead.

Analysis on top of the schedule:

- **Overpay or save?** Both strategies spend identical cash each month (standard payment plus planned overpayment). Strategy A overpays, and once the mortgage is cleared the freed payments go into savings; strategy B pays the mortgage as normal and saves the overpayment money at the entered rate, compounding monthly. Interest is credited gross and taxed at the user's band only above the Personal Savings Allowance for each tax year. Net position (savings − balance) is compared at the end of the original term and the break-even gross savings rate is found by bisection.
- **Rate sensitivity.** Monthly payment and total interest at −2 to +3 percentage points.
- **Loan-to-value tiers.** Extra deposit needed to reach 95/90/85/80/75/60% LTV.
- **Buy-to-let.** The tax on the rent is the difference between the full income-tax calculation with and without the property, given the user's other income and region, so the Personal Allowance, band straddling, the allowance taper, Scottish rates and the finance-cost credit caps are all applied. The property allowance is used instead of costs when that is cheaper. Shows cash after mortgage and tax, gross yield, and the extra tax versus full deductibility.

## Design

The look is benchmarked on app-blueprint.farhan.app: a shadcn-style neutral palette (near-black primary, zinc greys, 1px borders, 6–8px radii, subtle shadows), Geist type (self-hosted in `assets/fonts/`, so no third-party font requests), compact 40px controls, uppercase 11px section labels, a dotted canvas background and a slim footer. Tokens live at the top of `assets/css/style.css` as HSL triplets, so a dark theme can be added by redefining them.

## Project layout

```
index.html               landing page
income/index.html        take-home pay calculator
mortgage/index.html      mortgage calculator
assets/css/style.css     shared design system (light theme)
assets/js/tax-engine.js  income tax / NI / student loan engine
assets/js/mortgage-engine.js
assets/js/income.js      income page UI
assets/js/mortgage.js    mortgage page UI (includes the SVG chart)
assets/js/ui.js          formatting, money inputs, URL state helpers
data/tax-years/          rates per tax year + index
scripts/update-rates.mjs GOV.UK checker/updater
scripts/serve.mjs        local static server
tests/                   node:test suites
```

## Disclaimer

These tools are for guidance only and are not financial or tax advice. Always check your own position with HMRC or a qualified adviser.
