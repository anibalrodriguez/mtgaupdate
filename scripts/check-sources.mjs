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

function scheduleEvidence(content) {
  const details = [];
  const date = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/i;
  const milestone = /^(?:event open|start|signups? (?:end|close)|entry (?:closes|window closes)|event end)\s*:/i;
  let heading = '';
  for (const match of content.matchAll(/<(h[1-6]|li|p|tr)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const text = decodeEntities(match[2].replace(/<\/(?:td|th)\s*>/gi, ' | ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    const isHeading = /^h/i.test(match[1]);
    if (isHeading) heading = text.slice(0, 120);
    const isMilestone = milestone.test(text);
    const candidate = isMilestone ? text.split(/\s*(?:\u2014|\bOR once\b)/i)[0].trim() : text;
    if (!date.test(candidate) || candidate.length > 300) continue;
    if (match[1].toLowerCase() === 'p' && !isMilestone && !/\b(?:draft|sealed|qualifier|cube)\b.*\b(?:until|through|extended|available)\b/i.test(candidate)) continue;
    const detail = heading && !isHeading ? `${heading}: ${candidate}` : candidate;
    if (!details.includes(detail)) details.push(detail);
  }
  return { scheduleDetails: details.slice(0, 12), detailsTruncated: details.length > 12 };
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
  return { fingerprint: fingerprint(JSON.stringify({ text, links: [...new Set(links)].sort() })), ...scheduleEvidence(content) };
}

export async function inspectSources(sources, baseline, request = fetch, events = []) {
  return Promise.all(Object.entries(sources).map(async ([id, source]) => {
    const listings = events.filter(event => event.sources.includes(id)).map(({ id, name, format, start, end, entryCloses, conflict, note }) => ({
      id, name, format, start, end, entryCloses, conflict, note
    }));
    try {
      const url = officialUrl(source.url);
      const response = await request(url.href, { signal: AbortSignal.timeout(45000), headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}`);
      if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Official source did not return HTML');
      const destination = officialUrl(response.url || url.href);
      if (destination.pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, '')) {
        throw new Error('Official source redirected to a different page; manual review required');
      }
      const current = sourceFingerprint(await response.text(), source);
      const previous = baseline.sources[id];
      const status = previous?.url === source.url && previous.fingerprint === current.fingerprint ? 'unchanged' : 'changed';
      return {
        id, ...source, ...current, status, listings,
        ...(previous?.url === source.url && Array.isArray(previous.scheduleDetails) ? { previousDetails: previous.scheduleDetails } : {})
      };
    } catch (error) {
      return { id, ...source, status: 'unavailable', error: error.message, listings };
    }
  }));
}

export async function inspectNewArticles(results, sources, baseline, request = fetch) {
  const news = results.find(source => source.kind === 'arena-index' && source.status === 'changed');
  if (!news) return [];
  const known = new Set(Object.values(sources).map(source => source.url));
  const accepted = new Set(baseline.sources[news.id]?.links || []);
  const added = news.links.filter(url => !accepted.has(url) && !known.has(url));
  news.deferredLinks = added.slice(5);
  const discovered = Object.fromEntries(added.slice(0, 5).map(url => [
    `discovered-${fingerprint(url).slice(0, 12)}`,
    { url, title: `New Arena article: ${new URL(url).pathname.split('/').pop()}`, discovered: true }
  ]));
  return inspectSources(discovered, { sources: {} }, request);
}

const markdownText = value => String(value).replace(/[\\`*_[\]<>|]/g, '\\$&').replace(/[\r\n]+/g, ' ');

export function reviewBody(results, checkedAt) {
  const pending = results.filter(result => result.status !== 'unchanged');
  if (!pending.length) return '';
  const signature = fingerprint(JSON.stringify(pending));
  const lines = [
    issueMarker, `<!-- source-check-signature:${signature} -->`,
    'Official Arena sources changed or could not be checked. **The published schedule has not been updated.**',
    '', `Detected at ${checkedAt}.`, '',
    'Flagged sources:', ...pending.map(source => `- ${markdownText(source.title)}: ${source.url}`), ''
  ];
  for (const source of pending) {
    lines.push(`### ${markdownText(source.title)}`, source.url, '');
    if (source.status === 'unavailable') {
      lines.push(`Check failed: ${source.error}`, '');
    } else {
      lines.push(`Content or links differ from the accepted baseline. Source ID: \`${source.id}\`.`, '');
      if (source.links) lines.push('Arena articles currently linked from the news index:', ...source.links.map(link => `- ${link}`), '');
      if (source.scheduleDetails) {
        lines.push('**Published schedule evidence (excerpts, not an approved update)**', '');
        if (source.previousDetails) {
          const removed = source.previousDetails.filter(detail => !source.scheduleDetails.includes(detail));
          const added = source.scheduleDetails.filter(detail => !source.previousDetails.includes(detail));
          lines.push(...removed.map(detail => `- Previously accepted: ${markdownText(detail)}`), ...added.map(detail => `- Currently published: ${markdownText(detail)}`));
          if (!removed.length && !added.length) lines.push('No change in the extracted date details; other page text or links changed.');
        } else {
          lines.push('No previously accepted excerpts are available for a historical date comparison.');
        }
        lines.push('', 'Current excerpts:', ...source.scheduleDetails.map(detail => `- ${markdownText(detail)}`), '');
        if (!source.scheduleDetails.length) lines.push('No short dated schedule details could be extracted. This does not mean there are no event changes.', '');
        if (source.detailsTruncated) lines.push('Only the first 12 matching details are shown; review the full source for additional dates.', '');
      }
      if (source.deferredLinks?.length) lines.push('Additional new articles not fetched (the checker inspects at most five per run):', ...source.deferredLinks.map(link => `- ${link}`), '');
      if (source.discovered) lines.push('Newly discovered article: no published listing cites this source yet. Review for event additions and updates.', '');
    }
    if (source.listings?.length) {
      lines.push('**Published listings citing this source (comparison only; not automatically changed)**', '',
        '| Event | Starts | Entry closes | Ends | Status |',
        '| --- | --- | --- | --- | --- |');
      for (const event of source.listings.slice(0, 10)) {
        lines.push(`| ${markdownText(`${event.name} - ${event.format} (${event.id})`)} | ${event.start} | ${event.entryCloses || 'Unconfirmed'} | ${event.end || 'Unconfirmed'} | ${event.conflict ? 'Dates disputed' : 'Published'} |`);
      }
      lines.push('');
      for (const event of source.listings.slice(0, 10)) {
        if (event.note) lines.push(`Retained note for ${markdownText(event.id)}: ${markdownText(event.note)}`, '');
      }
      if (source.listings.length > 10) lines.push('', `${source.listings.length - 10} additional listings cite this source; see events.json.`);
      lines.push('');
    }
  }
  const instructions = [
    '### Review and publish',
    '1. Have the reviewing assistant compare the extracted evidence, published listings, and linked detailed schedules or terms. A changed page does not necessarily change event dates; conflicting headlines and detailed deadlines must remain explicit.',
    '2. Present a proposed event-data diff for user approval. Only after approval, edit `events.json`, add relevant newly discovered sources and citations, retain date uncertainty, and update verification timestamps only for sources actually reviewed.',
    '3. Run `node --test tests/*.test.mjs`.',
    '4. After review, accept only the reviewed source fingerprints: `node scripts/check-sources.mjs --accept-baseline SOURCE_ID ...`.',
    '5. Commit and push the reviewed changes and `source-baselines.json`, then close this issue.',
    '',
    'Excerpts are bounded textual evidence, not semantic verification or resolved dates. Missing excerpts and unchanged fingerprints do not prove the schedule is accurate. No event edits or deployments happen automatically.',
    'Only fingerprints, official URLs, and short dated schedule excerpts are stored; full source articles are not copied.'
  ].join('\n');
  const report = lines.join('\n');
  return `${report.length > 58000 ? `${report.slice(0, 58000)}\n\n**Report truncated to fit GitHub. See all flagged source URLs above and review additional details manually.**\n\n` : report}${instructions}`;
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
  const results = await inspectSources(Object.fromEntries(selected.map(id => [id, sources[id]])), baseline, fetch, data.events);
  if (!accept) results.push(...await inspectNewArticles(results, sources, baseline));
  for (const result of results) console.log(`${result.status}: ${result.id} - ${result.url}${result.error ? ` - ${result.error}` : ''}`);
  const failed = results.some(result => result.status === 'unavailable');
  const checkedAt = new Date().toISOString();
  if (accept) {
    if (failed) throw new Error('Baseline not written because a selected official source could not be checked');
    for (const result of results) {
      baseline.sources[result.id] = {
        url: result.url, fingerprint: result.fingerprint, acceptedAt: checkedAt,
        ...(result.links ? { links: result.links } : {}),
        ...(result.scheduleDetails ? { scheduleDetails: result.scheduleDetails, detailsTruncated: result.detailsTruncated } : {})
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
