// Structural checks for SEO and accessibility basics on every page. No browser needed: the
// pages are static HTML, so the things that matter to crawlers and assistive tech are in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
