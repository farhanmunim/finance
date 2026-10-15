// Structural checks for SEO and accessibility basics on every page. No browser needed: the
// pages are static HTML, so the things that matter to crawlers and assistive tech are in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const pages = { 'index.html': '/', 'income/index.html': '/income/', 'mortgage/index.html': '/mortgage/', 'pension/index.html': '/pension/', '404.html': null };
const read = (f) => readFileSync(resolve(root, f), 'utf8');
const attr = (html, re) => html.match(re)?.[1];

for (const [file, path] of Object.entries(pages)) {
  const html = read(file);
  const indexable = path !== null;

  test(`${file}: head metadata`, () => {
    assert.match(html, /<html lang="en-GB">/);
    const title = attr(html, /<title>([^<]+)<\/title>/);
    assert.ok(title, 'has a <title>');
    assert.ok(title.length <= 65, `title is ${title.length} chars (keep it within what search results show)`);
    const desc = attr(html, /<meta name="description" content="([^"]+)"/);
    assert.ok(desc && desc.length >= 50 && desc.length <= 165, `meta description length ${desc?.length}`);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta property="og:image:alt" content="[^"]+">/);
    assert.match(html, /<meta name="twitter:image:alt" content="[^"]+">/);
    if (indexable) {
      assert.equal(attr(html, /<link rel="canonical" href="([^"]+)"/), `https://finance.farhan.app${path}`);
      assert.equal(attr(html, /<meta property="og:title" content="([^"]+)"/), title, 'og:title matches the title');
    } else {
      assert.match(html, /<meta name="robots" content="noindex">/);
    }
  });

  test(`${file}: structured data is valid JSON`, () => {
    for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) assert.doesNotThrow(() => JSON.parse(m[1]));
  });

  test(`${file}: landmarks, skip link and single h1`, () => {
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
    assert.equal((html.match(/<main[\s>]/g) || []).length, 1, 'exactly one main');
    assert.match(html, /<a class="skip-link" href="#main">/);
    assert.match(html, /<main [^>]*id="main"/);
    assert.match(html, /<header[\s>]/);
    assert.match(html, /<footer[\s>]/);
    assert.equal((html.match(/<nav[\s>]/g) || []).length, (html.match(/<nav [^>]*aria-label="[^"]+"/g) || []).length, 'every nav is labelled');
  });

  test(`${file}: ids are unique and references resolve`, () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate ids');
    for (const m of html.matchAll(/\s(?:for|aria-labelledby|aria-describedby|href)="#?([^"]+)"/g)) {
      if (m[0].trim().startsWith('href') && !m[0].includes('href="#')) continue;
      for (const id of m[1].split(/\s+/)) assert.ok(ids.includes(id), `reference to missing id "${id}"`);
    }
  });

  test(`${file}: external links open safely and say so`, () => {
    for (const m of html.matchAll(/<a [^>]*target="_blank"[^>]*>(.*?)<\/a>/gs)) {
      assert.match(m[0], /rel="noopener"/);
      assert.match(m[1], /opens in a new tab/);
    }
  });

  test(`${file}: no ARIA role misuse or title-only names`, () => {
    assert.doesNotMatch(html, /role="listitem"|role="list"/, 'use real ul/li');
    assert.doesNotMatch(html, /class="brand"[^>]*title=/, 'redundant title on brand link');
  });
}

for (const file of ['income/index.html', 'mortgage/index.html', 'pension/index.html']) {
  test(`${file}: every form control has a label and groups use fieldset/legend`, () => {
    const html = read(file);
    const labelled = new Set([...html.matchAll(/<label [^>]*for="([^"]+)"/g)].map((m) => m[1])); // explicit
    for (const m of html.matchAll(/<label\b[^>]*>(.*?)<\/label>/gs)) for (const i of m[1].matchAll(/<input\b[^>]*\bid="([^"]+)"/g)) labelled.add(i[1]); // wrapping
    for (const m of html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      assert.ok(labelled.has(m[1]), `control #${m[1]} has no label`);
    }
    assert.equal((html.match(/<fieldset/g) || []).length, (html.match(/<legend/g) || []).length, 'each fieldset has a legend');
    assert.doesNotMatch(html, /<span class="label">.*?<\/span>\s*<div class="(?:segmented|chips)/s, 'visible group labels should be legends');
    assert.match(html, /id="sr-status"[^>]*role="status"/, 'persistent live region present');
  });

  test(`${file}: has crawlable explanatory copy`, () => {
    const html = read(file);
    const about = attr(html, /<section class="card about"[^>]*>(.*?)<\/section>/s);
    assert.ok(about, 'about section');
    assert.ok(about.replace(/<[^>]+>/g, ' ').split(/\s+/).length > 120, 'at least ~120 words of real content');
  });
}

test('sitemap lists every indexable page', () => {
  const sm = read('sitemap.xml');
  for (const p of ['/', '/income/', '/mortgage/', '/pension/']) assert.ok(sm.includes(`<loc>https://finance.farhan.app${p}</loc>`), p);
});

// ---- Baseline SEO, social and accessibility standards, checked across every page together

const indexable = Object.entries(pages).filter(([, path]) => path !== null);
const meta = (html, re) => attr(html, re);

test('titles and descriptions are unique across pages', () => {
  const titles = Object.keys(pages).map((f) => meta(read(f), /<title>([^<]+)<\/title>/));
  const descs = Object.keys(pages).map((f) => meta(read(f), /<meta name="description" content="([^"]+)"/));
  assert.equal(new Set(titles).size, titles.length, 'duplicate titles');
  assert.equal(new Set(descs).size, descs.length, 'duplicate descriptions');
});

for (const [file, path] of Object.entries(pages)) {
  test(`${file}: social cards are complete and use absolute HTTPS URLs`, () => {
    const html = read(file);
    const title = meta(html, /<title>([^<]+)<\/title>/);
    const desc = meta(html, /<meta name="description" content="([^"]+)"/);
    assert.equal(meta(html, /<meta property="og:site_name" content="([^"]+)"/), 'UK Finance Tools');
    assert.equal(meta(html, /<meta property="og:type" content="([^"]+)"/), 'website');
    assert.equal(meta(html, /<meta property="og:image" content="([^"]+)"/), 'https://finance.farhan.app/assets/og.png');
    assert.equal(meta(html, /<meta name="twitter:image" content="([^"]+)"/), 'https://finance.farhan.app/assets/og.png');
    assert.equal(meta(html, /<meta property="og:image:width" content="([^"]+)"/), '1200');
    assert.equal(meta(html, /<meta property="og:image:height" content="([^"]+)"/), '630');
    assert.equal(meta(html, /<meta name="twitter:card" content="([^"]+)"/), 'summary_large_image');
    assert.equal(meta(html, /<meta name="twitter:title" content="([^"]+)"/), title);
    assert.ok(meta(html, /<meta property="og:description" content="([^"]+)"/), 'og:description');
    assert.ok(meta(html, /<meta name="twitter:description" content="([^"]+)"/), 'twitter:description');
    assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}">/);
    assert.match(html, /<link rel="icon" href="\/assets\/favicon\.svg" type="image\/svg\+xml">/);
    if (path !== null) assert.equal(meta(html, /<meta property="og:url" content="([^"]+)"/), `https://finance.farhan.app${path}`);
    else assert.doesNotMatch(html, /og:url/, 'the 404 page has no real URL to share');
    assert.ok(desc.length > 0);
    assert.doesNotMatch(html, /localhost|example\.com|lorem ipsum|127\.0\.0\.1/i, 'no placeholder or development URLs');
  });

  test(`${file}: native HTML before ARIA`, () => {
    const html = read(file);
    assert.doesNotMatch(html, /role="(switch|radiogroup|note|navigation|main|banner|contentinfo)"/, 'a native element already carries this meaning');
    assert.doesNotMatch(html, /<div[^>]*onclick=|<span[^>]*onclick=/, 'interactive elements must be native');
    for (const m of html.matchAll(/(<[a-z]+\b[^>]*>\s*)?<svg\b[^>]*>/g)) assert.match(m[0], /aria-hidden="true"|role="img"/, 'svg is decorative (hidden from assistive tech) or labelled');
  });

  test(`${file}: stylesheet, scripts and preload resolve to real files`, () => {
    const html = read(file);
    for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)(?:\?[^"]*)?"/g)) assert.ok(existsSync(resolve(root, '.' + m[1])), `missing asset ${m[1]}`);
  });
}

test('every internal link points at a page that exists', () => {
  const known = new Set(Object.values(pages).filter(Boolean));
  for (const file of Object.keys(pages)) {
    for (const m of read(file).matchAll(/<a [^>]*href="(\/[^"#?]*)"/g)) assert.ok(known.has(m[1]), `${file} links to unknown page ${m[1]}`);
  }
});

test('structured data matches the page it is on', () => {
  for (const [file, path] of indexable) {
    const blocks = [...read(file).matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
    assert.ok(blocks.length >= 1, `${file} has structured data`);
    for (const b of blocks) {
      assert.equal(b['@context'], 'https://schema.org');
      assert.ok(['WebSite', 'WebApplication', 'BreadcrumbList'].includes(b['@type']), `unexpected type ${b['@type']}`);
      if (b['@type'] !== 'BreadcrumbList') assert.equal(b.url.replace(/\/$/, ''), `https://finance.farhan.app${path}`.replace(/\/$/, ''));
      assert.doesNotMatch(JSON.stringify(b), /aggregateRating|review|ratingValue/i, 'no invented ratings or reviews');
    }
  }
});

test('every page has a descriptive h1 and no skipped heading levels in the static HTML', () => {
  for (const file of Object.keys(pages)) {
    const levels = [...read(file).matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    assert.equal(levels[0], 1, `${file} starts with h1`);
    levels.forEach((l, i) => { if (i) assert.ok(l - levels[i - 1] <= 1, `${file} skips from h${levels[i - 1]} to h${l}`); });
  }
});

test('the social image is a 1200 x 630 PNG', () => {
  const d = readFileSync(resolve(root, 'assets/og.png'));
  assert.equal(d.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([d.readUInt32BE(16), d.readUInt32BE(20)], [1200, 630]);
  assert.ok(d.length < 300 * 1024, 'keep the share image small');
});

test('robots.txt allows crawling and points at the sitemap; sitemap dates are valid', () => {
  const robots = read('robots.txt');
  assert.match(robots, /Allow: \//); assert.doesNotMatch(robots, /Disallow: \/\s*$/m);
  assert.match(robots, /Sitemap: https:\/\/finance\.farhan\.app\/sitemap\.xml/);
  for (const m of read('sitemap.xml').matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) assert.ok(!Number.isNaN(Date.parse(m[1])) && /^\d{4}-\d{2}-\d{2}$/.test(m[1]), `bad lastmod ${m[1]}`);
});
