# UK Finance Tools

Two small, fast calculators built with plain HTML, CSS and JavaScript. No frameworks, no build step, no tracking. Designed for Cloudflare Pages (free tier) but any static host works.

| Tool | Path | What it does |
| --- | --- | --- |
| Take-home pay | `/income/` | Income tax, National Insurance, student loan and pension deductions for employees, the self-employed, or both, with every step shown. |
| Mortgage | `/mortgage/` | Monthly payment, total interest, fixed-rate periods, interest-only, and what overpayments save. |

## Deploying to Cloudflare Pages

1. Push this repository to GitHub.
2. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages → Connect to Git** and pick the repo.
3. Build settings: **Framework preset: None**, **Build command:** leave empty, **Build output directory:** `/` (the repo root).
4. Deploy. Every push to the production branch redeploys automatically.

`_headers` adds security headers and short caching for `/assets/*` and `/data/*`. `404.html` is served for unknown paths.

## Running locally

```bash
npm run serve        # http://localhost:8080
npm test             # unit tests for both calculation engines (node:test, no dependencies)
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

Implemented in `assets/js/tax-engine.js` (pure functions, unit-tested in `tests/`).

1. **Income.** Employment pay after salary sacrifice or net-pay pension contributions, plus taxable benefits; self-employed profit (turnover less expenses or the trading allowance); savings interest; dividends; other income.
2. **Adjusted net income** = total income less gross relief-at-source pension contributions and gross Gift Aid. Used for the Personal Allowance taper and the Child Benefit charge.
3. **Allowances.** Personal Allowance tapered by £1 for every £2 over the income limit; Blind Person's Allowance; Marriage Allowance (transfer reduces the allowance, receipt is a tax reducer for basic-rate taxpayers). Allowances are set against non-savings income first, then savings, then dividends.
4. **Income tax.** Non-savings income through the rUK or Scottish bands. Savings then dividends are stacked on top using UK-wide bands: starting rate for savings (£5,000 reduced by non-savings income over the allowance), Personal Savings Allowance by taxpayer level, dividend allowance, dividend rates. Relief-at-source pension and Gift Aid extend the band limits.
5. **National Insurance.** Class 1 employee contributions on an annual basis; employer contributions shown for information. Class 4 on profits, with the statutory annual-maximum interaction when someone also pays Class 1 (main-rate Class 4 is reduced by Class 1 already paid; displaced profits are charged at the upper rate). Class 2 is credited above the small profits threshold; voluntary contributions are shown but not deducted.
6. **Student loans.** 9% (Plan 1/2/4/5) over the lowest threshold of the selected plans and 6% (Postgraduate) over its threshold, on employment pay plus profits, plus unearned income when it exceeds £2,000.
7. **High Income Child Benefit Charge.** 1% of Child Benefit per £200 of adjusted net income over £60,000, all of it from £80,000.

Known simplifications: annual (not per-pay-period) NI and student loan calculation, no loss relief, no pension annual allowance or tapered annual allowance checks, no Married Couple's Allowance, no capital gains.

## Calculation method (mortgage tool)

Implemented in `assets/js/mortgage-engine.js`. Interest accrues monthly at one twelfth of the annual rate on the opening balance; the standard payment is the annuity amount that clears the balance over the term and is recalculated when the rate changes (initial deal → revert rate). Overpayments reduce the balance immediately and either shorten the term or reduce the payment. Interest-only runs to the end of the term and reports the outstanding balance. A user-entered payment derives the payoff time instead.

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
