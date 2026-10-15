/**
 * Site-wide footer behaviour, loaded on every page: the About / Privacy modal and the
 * "tax rates updated" date. The modal is a native <dialog>, so the browser traps focus,
 * closes it on Esc and returns focus to the button that opened it.
 */
import { el, loadJSON } from './ui.js?v=bdf638f516';

const APP = 'UK Finance Tools';
const REPO = 'https://github.com/farhanmunim/finance';
let dialog = null;
let opener = null;

function link(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener' }, [text, el('span', { class: 'visually-hidden', text: ' (opens in a new tab)' })]);
}

function build() {
  const closeBtn = el('button', { type: 'button', class: 'btn', 'data-close': '', autofocus: true, text: 'Close' });
  const panel = el('div', { class: 'about-panel' }, [
    el('div', { class: 'about-head' }, [el('h2', { id: 'about-title', text: `About ${APP}` }), closeBtn]),
    el('p', { html: '<b>Clear answers to everyday UK money questions.</b> Free calculators for income tax and take-home pay, mortgages, and pensions, built on official GOV.UK rates for anyone who wants a straight answer. They are for guidance only and are not financial advice. Not affiliated with HMRC or GOV.UK.' }),
    el('section', { id: 'about-privacy', 'aria-labelledby': 'about-privacy-h' }, [
      el('h3', { id: 'about-privacy-h', text: 'Privacy' }),
      el('p', { text: 'Everything you type stays on your device. The maths runs in your browser, and nothing you enter is sent to a server, saved in a cookie or kept in local storage.' }),
      el('p', { text: 'Your inputs are written into the page address (the part after the ?) so you can bookmark or share a result. Anyone you send that link to will see those figures.' }),
      el('p', { text: 'We use Umami for aggregate, cookieless page-view statistics only. It sets no cookies, builds no profiles, and the part of the address that holds your inputs is excluded. No names, emails, accounts or financial details are ever collected.' }),
    ]),
    el('section', {}, [
      el('h3', { text: 'Source' }),
      el('p', {}, ['The code is open source under the MIT licence: ', link(REPO, 'github.com/farhanmunim/finance'), '.']),
    ]),
    el('section', {}, [
      el('h3', { text: 'Developer' }),
      el('p', {}, ['Built by ', link('https://farhan.app', 'Farhan Munim'), ' · ', link('https://farhan.app', 'farhan.app'), '.']),
    ]),
    el('section', {}, [
      el('h3', { text: 'Support' }),
      el('p', { text: 'Support the development of this free tool.' }),
      el('p', { style: 'margin-top:10px' }, el('a', { class: 'btn', href: 'https://buymeacoffee.com/farhan.app', target: '_blank', rel: 'noopener' }, ['☕ Buy me a coffee', el('span', { class: 'visually-hidden', text: ' (opens in a new tab)' })])),
    ]),
  ]);
  const d = el('dialog', { class: 'about-modal', 'aria-labelledby': 'about-title' }, panel);
  // A click on the backdrop lands on the <dialog> itself; the panel fills the rest of it.
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  d.addEventListener('close', () => { if (opener && document.contains(opener)) opener.focus(); opener = null; });
  document.body.append(d);
  return d;
}

function open(section, trigger) {
  dialog = dialog || build();
  opener = trigger;
  dialog.showModal();
  const target = section === 'privacy' ? dialog.querySelector('#about-privacy') : null;
  dialog.scrollTop = 0;
  if (target) target.scrollIntoView({ block: 'start' });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-about]');
  if (btn) open(btn.dataset.about, btn);
});

// "Tax rates updated" date, from the same data the calculators use
(async () => {
  const slot = document.getElementById('rates-updated');
  if (!slot) return;
  try {
    const index = await loadJSON('/data/tax-years/index.json');
    const meta = index.years.find((y) => y.id === index.default) || index.years[0];
    const data = await loadJSON(meta.file);
    const d = new Date(`${data.verified}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    slot.textContent = `Tax rates updated ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    slot.hidden = false;
  } catch { /* the footer simply omits the date */ }
})();
