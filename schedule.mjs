const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const sourceTimezone = 'America/Los_Angeles';

function validDate(value) {
  if (typeof value !== 'string' || (!dateOnlyPattern.test(value) && !timestampPattern.test(value))) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value.replace(/Z$/, ''));
}

export function dateKey(value, timezone = sourceTimezone) {
  if (typeof value === 'string' && dateOnlyPattern.test(value)) return value;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function eventStatus(event, now = new Date()) {
  const day = dateKey(now);
  if (event.conflict) {
    return day > event.reviewThrough ? 'expired' : 'conflict';
  }
  const dateStart = dateOnlyPattern.test(event.start);
  const dateEnd = dateOnlyPattern.test(event.end);
  if (dateEnd ? day > event.end : now >= new Date(event.end)) return 'expired';
  if (dateStart ? day < event.start : now < new Date(event.start)) return 'upcoming';
  if (event.entryCloses && now >= new Date(event.entryCloses)) return 'entry-closed';
  if (dateStart || dateEnd) return day === event.start || day === event.end ? 'boundary' : 'scheduled';
  return 'live';
}

export function groupEvents(events, filters, now = new Date()) {
  const groups = { current: [], upcoming: [], conflicts: [] };
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
  for (const event of sorted) {
    if (filters.category !== 'all' && event.category !== filters.category) continue;
    if (filters.competitive && !event.competitive) continue;
    if (!`${event.name} ${event.format} ${event.match || ''}`.toLowerCase().includes(filters.search)) continue;
    const status = eventStatus(event, now);
    if (status === 'expired') continue;
    if (status === 'conflict') groups.conflicts.push(event);
    else if (status === 'upcoming') groups.upcoming.push(event);
    else groups.current.push(event);
  }

  return groups;
}

export function upcomingInWindow(events, windowDays, timezone, now = new Date()) {
  if (windowDays === 'all') return events;
  const today = Date.parse(`${dateKey(now, timezone)}T00:00:00Z`);
  return events.filter(event => {
    const start = Date.parse(`${dateKey(event.start, timezone)}T00:00:00Z`);
    return start <= today + Number(windowDays) * 86400000;
  });
}

export function sortEvents(events, sort, timezone) {
  return [...events].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name) || a.start.localeCompare(b.start);
    const first = a[sort] ? dateKey(a[sort], timezone) : '9999-12-31';
    const second = b[sort] ? dateKey(b[sort], timezone) : '9999-12-31';
    return first.localeCompare(second) || a.start.localeCompare(b.start) || a.name.localeCompare(b.name);
  });
}

export function formatDate(value, timezone, detailed = false) {
  const dateOnly = dateOnlyPattern.test(value);
  const options = { month: 'short', day: 'numeric', timeZone: dateOnly ? 'UTC' : timezone };
  if (detailed) {
    options.year = 'numeric';
    if (!dateOnly) Object.assign(options, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
  const text = new Intl.DateTimeFormat('en-US', options).format(new Date(value));
  return detailed && dateOnly ? `${text} (time not announced)` : text;
}

export function validateSchedule(data) {
  if (!data || !validDate(data.verifiedAt) || !timestampPattern.test(data.verifiedAt) || !data.sources || !Array.isArray(data.events)) {
    throw new Error('Invalid schedule metadata');
  }
  for (const source of Object.values(data.sources)) {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || !['magic.wizards.com', 'www.magic.wizards.com', 'magic.gg', 'www.magic.gg'].includes(url.hostname) || typeof source.title !== 'string') {
      throw new Error('Invalid official source');
    }
  }
  const ids = new Set();
  for (const event of data.events) {
    if (!event.id || ids.has(event.id) || typeof event.name !== 'string' || typeof event.format !== 'string'
      || !['limited', 'constructed'].includes(event.category) || !validDate(event.start)
      || !validDate(event.verifiedAt) || !timestampPattern.test(event.verifiedAt)
      || !Array.isArray(event.sources) || !event.sources.length || event.sources.some(id => !Object.hasOwn(data.sources, id))) {
      throw new Error(`Invalid event: ${event.id || 'missing ID'}`);
    }
    if (event.conflict) {
      if (!event.note || !validDate(event.reviewThrough) || !dateOnlyPattern.test(event.reviewThrough) || event.reviewThrough < event.start.slice(0, 10)) throw new Error(`Invalid conflict: ${event.id}`);
    } else if (!validDate(event.end) || event.end < event.start) {
      throw new Error(`Invalid end date: ${event.id}`);
    }
    if (event.entryCloses && (!validDate(event.entryCloses) || !timestampPattern.test(event.entryCloses)
      || dateOnlyPattern.test(event.start) || !event.end || dateOnlyPattern.test(event.end)
      || event.entryCloses < event.start || event.entryCloses > event.end)) {
      throw new Error(`Invalid entry cutoff: ${event.id}`);
    }
    ids.add(event.id);
  }
  return data;
}
