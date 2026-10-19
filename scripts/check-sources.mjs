import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateSchedule } from '../schedule.mjs';

const baselineUrl = new URL('../source-baselines.json', import.meta.url);
const issueMarker = '<!-- mtga-source-review -->';
const fingerprint = value => createHash('sha256').update(value).digest('hex');

function officialUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://magic.wizards.com' || url.username || url.password) {
    throw new Error('Expected an official HTTPS Wizards source');
  }
  return url;
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()];
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

export function sourceFingerprint(html, source) {
  const url = officialUrl(source.url);
  const cleaned = html.replace(/<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const content = cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1];
  if (!content) throw new Error('Official page has no readable main content; review the source or checker');
  const links = [...content.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map(match => new URL(decodeEntities(match[1] ?? match[2]), url))
    .filter(link => link.protocol === 'https:')
    .map(link => {
      link.hash = '';
      return link.href;
    });
  if (source.kind === 'arena-index') {
    const arenaLinks = [...new Set(links.filter(link => {
      const candidate = new URL(link);
      return candidate.hostname === url.hostname && candidate.pathname.startsWith('/en/news/mtg-arena/');
    }))].sort();
    if (!arenaLinks.length) throw new Error('No Arena article links found; review the news index or checker');
    return { fingerprint: fingerprint(JSON.stringify(arenaLinks)), links: arenaLinks };
  }
  const text = decodeEntities(content.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (text.length < 200) throw new Error('Official page has unexpectedly little content; manual review required');
  return { fingerprint: fingerprint(JSON.stringify({ text, links: [...new Set(links)].sort() })) };
}

export async function inspectSources(sources, baseline, request = fetch) {
  return Promise.all(Object.entries(sources).map(async ([id, source]) => {
    try {
      const url = officialUrl(source.url);
      const response = await request(url.href, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}`);
      if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Official source did not return HTML');
      const destination = officialUrl(response.url || url.href);
      if (destination.pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, '')) {
        throw new Error('Official source redirected to a different page; manual review required');
      }
      const current = sourceFingerprint(await response.text(), source);
      const previous = baseline.sources[id];
      const status = previous?.url === source.url && previous.fingerprint === current.fingerprint ? 'unchanged' : 'changed';
      return { id, ...source, ...current, status };
    } catch (error) {
      return { id, ...source, status: 'unavailable', error: error.message };
    }
  }));
}

export function reviewBody(results, checkedAt) {
  const pending = results.filter(result => result.status !== 'unchanged');
  if (!pending.length) return '';
  const signature = fingerprint(JSON.stringify(pending));
  const lines = [
    issueMarker, `<!-- source-check-signature:${signature} -->`,
    'Official Arena sources changed or could not be checked. **The published schedule has not been updated.**',
    '', `Detected at ${checkedAt}.`, ''
  ];
  for (const source of pending) {
    lines.push(`### ${source.title}`, source.url, '');
    if (source.status === 'unavailable') {
      lines.push(`Check failed: ${source.error}`, '');
    } else {
      lines.push(`Content or links differ from the accepted baseline. Source ID: \`${source.id}\`.`, '');
      if (source.links) lines.push('Arena articles currently linked from the news index:', ...source.links.map(link => `- ${link}`), '');
    }
  }
  lines.push(
    '### Review and publish',
    '1. Read the official pages, including new Arena announcements. A changed page does not necessarily change event dates.',
    '2. If events changed, edit `events.json`, retain source links and date uncertainty, and update verification timestamps only for sources actually reviewed.',
    '3. Run `node --test tests/*.test.mjs`.',
    '4. After review, accept only the reviewed source fingerprints: `node scripts/check-sources.mjs --accept-baseline SOURCE_ID ...`.',
    '5. Commit and push the reviewed changes and `source-baselines.json`, then close this issue.',
    '',
    'The checker compares public page text and links, not event meaning. It does not parse events, verify the schedule, or publish automatically.',
    'Only fingerprints and official URLs are stored; full source articles are not copied.'
  );
  return lines.join('\n');
}

export async function updateReviewIssue(body, repository, token, request = fetch) {
  if (!body) return;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token) throw new Error('GitHub repository and token are required for review issues');
  const api = async (path, method = 'GET', payload) => {
    const response = await request(`https://api.github.com/repos/${repository}${path}`, {
      method,
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    if (!response.ok) throw new Error(`GitHub review issue request failed: ${method} ${path} (HTTP ${response.status})`);
    return response.json();
  };
  let existing;
  for (let page = 1; !existing; page++) {
    const issues = await api(`/issues?state=open&per_page=100&page=${page}`);
    existing = issues.find(issue => !issue.pull_request && issue.body?.startsWith(issueMarker));
    if (issues.length < 100) break;
  }
  const signature = body.split('\n')[1];
  if (existing?.body.includes(signature)) {
    console.log(`Review issue #${existing.number} already tracks these changes.`);
    return;
  }
  const issue = existing
    ? await api(`/issues/${existing.number}`, 'PATCH', { body })
    : await api('/issues', 'POST', { title: 'Review official MTGA source changes', body });
  console.log(`Review issue: ${issue.html_url}`);
}

async function main() {
  const args = process.argv.slice(2);
  const accept = args[0] === '--accept-baseline';
  if (args.length && !accept && (args.length !== 1 || args[0] !== '--github-issue')) {
    throw new Error('Usage: node scripts/check-sources.mjs [--github-issue | --accept-baseline SOURCE_ID ...]');
  }
  const data = validateSchedule(JSON.parse(await readFile(new URL('../events.json', import.meta.url), 'utf8')));
  const sources = {
    ...data.sources,
    news: { title: 'Official Arena news index - new articles', url: 'https://magic.wizards.com/en/news/mtg-arena', kind: 'arena-index' }
  };
  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselineUrl, 'utf8'));
  } catch (error) {
    if (accept && error.code === 'ENOENT') baseline = { version: 1, sources: {} };
    else throw error;
  }
  if (baseline.version !== 1 || !baseline.sources || typeof baseline.sources !== 'object') throw new Error('Invalid source baseline file');
  const selected = accept ? args.slice(1) : Object.keys(sources);
  if (!selected.length || selected.some(id => !Object.hasOwn(sources, id))) throw new Error('Specify valid source IDs to accept after manual review');
  const results = await inspectSources(Object.fromEntries(selected.map(id => [id, sources[id]])), baseline);
  for (const result of results) console.log(`${result.status}: ${result.id} - ${result.url}${result.error ? ` - ${result.error}` : ''}`);
  const failed = results.some(result => result.status === 'unavailable');
  const checkedAt = new Date().toISOString();
  if (accept) {
    if (failed) throw new Error('Baseline not written because a selected official source could not be checked');
    for (const result of results) {
      baseline.sources[result.id] = {
        url: result.url, fingerprint: result.fingerprint, acceptedAt: checkedAt,
        ...(result.links ? { links: result.links } : {})
      };
    }
    await writeFile(baselineUrl, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log('Accepted selected fingerprints. events.json and its verification timestamps were not changed.');
  } else {
    const body = reviewBody(results, checkedAt);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, body || `Checked ${results.length} official sources at ${checkedAt}. No changes detected against accepted fingerprints.\n\nThis check does not reverify event data.\n`);
    if (args[0] === '--github-issue') await updateReviewIssue(body, process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN);
    if (!body) console.log('No source changes detected. Published data and verification timestamps were not changed.');
    if (failed) throw new Error('One or more official sources could not be checked; manual review is required');
    if (body && !args.length) console.log(body);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Official source check failed:', error.message);
    process.exitCode = 1;
  });
}
