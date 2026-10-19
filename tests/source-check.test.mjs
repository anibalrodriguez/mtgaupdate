import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSources, reviewBody, sourceFingerprint, updateReviewIssue } from '../scripts/check-sources.mjs';

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
  assert.doesNotMatch(report, /unchanged|A draft event starts/);
  assert.equal(reviewBody([results[2]], 'now'), '');
  assert.equal(report.split('\n')[1], reviewBody(results, 'tomorrow').split('\n')[1]);
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
