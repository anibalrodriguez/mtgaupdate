import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectNewArticles, inspectSources, reviewBody, sourceFingerprint, updateReviewIssue } from '../scripts/check-sources.mjs';

const source = { title: 'Test official schedule', url: 'https://magic.wizards.com/en/news/mtg-arena/test' };
const text = 'A draft event starts October 20 and ends October 26. '.repeat(5);
const page = (content = text) => `<html><nav>Navigation</nav><main>${content}</main><footer>Footer</footer></html>`;
const response = html => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const baseline = html => ({ sources: { schedule: { url: source.url, ...sourceFingerprint(html, source) } } });

test('source fingerprints ignore page chrome, scripts, attributes, and formatting but detect date and link changes', () => {
  const first = page(`<p>${text}</p><a href="/en/news/mtg-arena/details">Details</a>`);
  const formatted = `<nav>New menu</nav><main class="changed"><script>randomData()</script><p>\n ${text} </p><a class="new" href="/en/news/mtg-arena/details">Details</a></main>`;
  assert.deepEqual(sourceFingerprint(first, source), sourceFingerprint(formatted, source));
  assert.notEqual(sourceFingerprint(first, source).fingerprint, sourceFingerprint(first.replace('October 26', 'October 27'), source).fingerprint);
  assert.notEqual(sourceFingerprint(first, source).fingerprint, sourceFingerprint(first.replace('href="/en/news/mtg-arena/details"', 'href="/en/news/mtg-arena/new-details"'), source).fingerprint);
  assert.deepEqual(sourceFingerprint(page(text + '&amp; &#38; &#x26; &nbsp;'), source), sourceFingerprint(page(text + '& & & '), source));
});

test('Arena news discovery detects new article URLs without flagging unrelated news or copied navigation', () => {
  const news = { url: 'https://magic.wizards.com/en/news', kind: 'arena-index' };
  const first = page('<a href="/en/news/mtg-arena/first">First article</a><a href="/en/news/magic-online/other">Other</a>');
  const unrelated = first.replace('Other', 'Unrelated change').replace('</html>', '<nav><a href="/en/news/mtg-arena/navigation">Menu</a></nav></html>');
  assert.deepEqual(sourceFingerprint(first, news), sourceFingerprint(unrelated, news));
  assert.notEqual(sourceFingerprint(first, news).fingerprint, sourceFingerprint(first.replace('</main>', '<a href="/en/news/mtg-arena/next">Next</a></main>'), news).fingerprint);
  assert.throws(() => sourceFingerprint(page('No articles'), news), /No Arena article links/);
});

test('Magic.gg rules articles are monitored without page chrome and detect format changes', async () => {
  const rules = { title: 'Official tournament rules', url: 'https://magic.gg/events/test-rules' };
  const html = `<nav>Navigation</nav><article><h2>Event Format</h2><p>Best-of-Three Draft. ${text}</p></article><footer>Footer</footer>`;
  const original = sourceFingerprint(html, rules);
  assert.deepEqual(original, sourceFingerprint(html.replace('Navigation', 'Updated navigation'), rules));
  assert.notEqual(original.fingerprint, sourceFingerprint(html.replace('Best-of-Three', 'Best-of-One'), rules).fingerprint);
  const [result] = await inspectSources({ rules }, { sources: {} }, async () => response(html));
  assert.equal(result.status, 'changed');
  assert.equal(result.fingerprint, original.fingerprint);
  assert.throws(() => sourceFingerprint(html, { url: 'https://magic.gg.example.com/events/test-rules' }), /official HTTPS/);
  assert.throws(() => sourceFingerprint(html, { url: 'https://user:password@magic.gg/events/test-rules' }), /official HTTPS/);
});

test('fetch comparison flags changed, new, and moved sources without mutating accepted fingerprints', async () => {
  const original = page();
  const saved = baseline(original);
  const before = structuredClone(saved);
  const sources = { schedule: source, new: source };
  const results = await inspectSources(sources, saved, async () => response(original));
  assert.deepEqual(results.map(result => result.status), ['unchanged', 'changed']);
  assert.deepEqual(saved, before);
  assert.equal((await inspectSources({ schedule: source }, saved, async () => response(page(text + ' New schedule.'))))[0].status, 'changed');
  saved.sources.schedule.url = 'https://magic.wizards.com/old';
  assert.equal((await inspectSources({ schedule: source }, saved, async () => response(original)))[0].status, 'changed');
});

test('schedule evidence retains conflicting headlines and detailed deadlines without copying whole articles', () => {
  const html = page(`
    <h2>Arena Direct: October 23-November 1</h2>
    <p><strong>Start</strong> : October 23, 2026, at 8 a.m. Pacific / 15:00 UTC</p>
    <p><strong>Signups End</strong> : November 2, 2026, at 8 a.m. Pacific / 16:00 UTC\u2014Matches may finish.</p>
    <p><strong>Event End</strong> : November 2, 2026, at 11 a.m. Pacific / 19:00 UTC or once the entry limit is reached.</p>
    <p>${'Unrelated article prose. '.repeat(30)}</p>
    <script>November 3 is not article content.</script>`);
  const result = sourceFingerprint(html, source);
  assert.ok(result.scheduleDetails.some(detail => detail === 'Arena Direct: October 23-November 1'));
  assert.ok(result.scheduleDetails.some(detail => detail.includes('Signups End : November 2, 2026') && detail.includes('16:00 UTC')));
  assert.ok(result.scheduleDetails.some(detail => detail.includes('Event End : November 2, 2026') && detail.includes('19:00 UTC')));
  assert.doesNotMatch(JSON.stringify(result.scheduleDetails), /Unrelated article prose|November 3|Matches may finish/);
});

test('review reports compare accepted date evidence with current evidence and disputed published listings', async () => {
  const original = page(`<h2>Arena Direct</h2><p>Event end: November 1, 2026, at 19:00 UTC</p><p>${text}</p>`);
  const saved = baseline(original);
  const events = [{ id: 'direct', name: 'Arena Direct', format: 'Sealed', start: '2026-10-23T15:00:00Z', end: null, conflict: true, note: 'Headlines disagree with detailed deadlines.', sources: ['schedule'] }];
  const before = structuredClone({ saved, events });
  const results = await inspectSources({ schedule: source }, saved, async (url, options) => {
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    return response(original.replace('November 1, 2026', 'November 2, 2026'));
  }, events);
  const report = reviewBody(results, 'now');
  assert.match(report, /Previously accepted: Arena Direct: Event end: November 1/);
  assert.match(report, /Currently published: Arena Direct: Event end: November 2/);
  assert.match(report, /\| Arena Direct - Sealed \(direct\) \| 2026-10-23T15:00:00Z \| Unconfirmed \| Unconfirmed \| Dates disputed \|/);
  assert.match(report, /Headlines disagree with detailed deadlines/);
  assert.match(report, /user approval/);
  assert.deepEqual({ saved, events }, before);
});

test('new article discovery fetches evidence, skips known links, and exposes articles beyond its request limit', async () => {
  const url = id => `https://magic.wizards.com/en/news/mtg-arena/${id}`;
  const links = ['old', 'tracked', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map(url);
  const news = { id: 'news', url: 'https://magic.wizards.com/en/news/mtg-arena', title: 'News', kind: 'arena-index', status: 'changed', links };
  const sources = { tracked: { url: url('tracked') } };
  const saved = { sources: { news: { links: [url('old')] } } };
  const calls = [];
  const results = await inspectNewArticles([news], sources, saved, async target => {
    calls.push(target);
    return response(page(`<h2>Qualifier Play-In</h2><ul><li>November 14: Best-of-One</li></ul><p>${text}</p>`));
  });
  assert.deepEqual(calls, ['first', 'second', 'third', 'fourth', 'fifth'].map(url));
  assert.deepEqual(news.deferredLinks, [url('sixth')]);
  assert.ok(results.every(result => result.discovered && result.scheduleDetails.some(detail => detail.includes('November 14'))));
  const report = reviewBody([news, ...results], 'now');
  assert.match(report, /Newly discovered article/);
  assert.match(report, /November 14/);
  assert.match(report, /not fetched/);
  assert.ok(report.includes(url('sixth')));
  assert.deepEqual(saved.sources.news.links, [url('old')]);
});

test('failed new article requests and missing or truncated evidence remain explicit in review reports', async () => {
  const news = { id: 'news', title: 'News', kind: 'arena-index', status: 'changed', url: source.url, links: [`${source.url}-new`] };
  const failed = await inspectNewArticles([news], {}, { sources: {} }, async () => new Response('Unavailable', { status: 503 }));
  assert.equal(failed[0].status, 'unavailable');
  assert.match(reviewBody(failed, 'now'), /HTTP 503/);
  const original = baseline(page());
  const [missing] = await inspectSources({ schedule: source }, original, async () => response(page('No dated details here. '.repeat(20))));
  assert.match(reviewBody([missing], 'now'), /No short dated schedule details could be extracted/);
  const html = page(`<h2>Draft dates</h2><ul>${Array.from({ length: 15 }, (_, i) => `<li>November ${i + 1}: Draft event</li>`).join('')}</ul>`);
  const [truncated] = await inspectSources({ schedule: source }, original, async () => response(html));
  assert.equal(truncated.scheduleDetails.length, 12);
  assert.equal(truncated.detailsTruncated, true);
  assert.match(reviewBody([truncated], 'now'), /first 12 matching details/);
});

test('unavailable, redirected, non-HTML, and empty pages require review instead of becoming accepted content', async () => {
  for (const request of [
    async () => { throw new Error('Connection failed'); },
    async () => new Response('Not found', { status: 404 }),
    async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    async () => response('<main>Access denied</main>'),
    async () => response('<html>No main content</html>'),
    async () => {
      const result = response(page());
      Object.defineProperty(result, 'url', { value: 'https://magic.wizards.com/en' });
      return result;
    }
  ]) {
    const [result] = await inspectSources({ schedule: source }, baseline(page()), request);
    assert.equal(result.status, 'unavailable');
    assert.ok(result.error);
  }
  assert.throws(() => sourceFingerprint(page(), { url: 'https://untrusted.example/test' }), /official HTTPS/);
});

test('review report contains actionable changes and errors, not full articles or unchanged sources', () => {
  const results = [
    { id: 'schedule', ...source, status: 'changed', fingerprint: 'changed' },
    { id: 'failed', title: 'Unavailable source', url: source.url, status: 'unavailable', error: 'HTTP 404' },
    { id: 'unchanged', ...source, status: 'unchanged' }
  ];
  const report = reviewBody(results, '2026-10-19T04:00:00Z');
  assert.match(report, /published schedule has not been updated/);
  assert.match(report, /HTTP 404/);
  assert.match(report, /--accept-baseline SOURCE_ID/);
  assert.doesNotMatch(report, /Source ID: `unchanged`|A draft event starts/);
  assert.equal(reviewBody([results[2]], 'now'), '');
  assert.equal(report.split('\n')[1], reviewBody(results, 'tomorrow').split('\n')[1]);
});

test('large review reports fit the GitHub issue limit and retain approval instructions', () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    ...source, id: `source-${index}`, status: 'changed',
    scheduleDetails: Array.from({ length: 12 }, (_, day) => `November ${day + 1}: ${'Draft event details. '.repeat(14)}`)
  }));
  const report = reviewBody(results, 'now');
  assert.ok(report.length <= 65536);
  assert.match(report, /Report truncated to fit GitHub/);
  assert.match(report, /user approval/);
  assert.ok(report.endsWith('full source articles are not copied.'));
});

test('review issues are created once, updated for new changes, and never opened when sources match', async () => {
  const body = reviewBody([{ id: 'schedule', ...source, status: 'changed', fingerprint: 'first' }], 'now');
  const calls = [];
  let issues = [];
  const request = async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'GET') return Response.json(issues);
    return Response.json({ html_url: 'https://github.com/example/repo/issues/1' });
  };
  await updateReviewIssue('', 'example/repo', 'test-token', request);
  assert.equal(calls.length, 0);
  await updateReviewIssue(body, 'example/repo', 'test-token', request);
  assert.equal(calls.at(-1).method, 'POST');
  issues = [{ number: 1, body }];
  calls.length = 0;
  await updateReviewIssue(body, 'example/repo', 'test-token', request);
  assert.deepEqual(calls.map(call => call.method), ['GET']);
  const updated = reviewBody([{ id: 'schedule', ...source, status: 'changed', fingerprint: 'second' }], 'later');
  await updateReviewIssue(updated, 'example/repo', 'test-token', request);
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.match(calls.at(-1).url, /\/issues\/1$/);
  await assert.rejects(updateReviewIssue(body, 'example/repo', 'test-token', async () => new Response('', { status: 403 })), /HTTP 403/);
});
