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

export function calendarUnavailableReason(event) {
  if (event.conflict || !event.end) return 'Calendar export is unavailable until the conflicting dates are resolved.';
  if (!validDate(event.start) || !validDate(event.end) || event.end < event.start) return 'Calendar export is unavailable because the event dates are invalid.';
  const dateOnly = dateOnlyPattern.test(event.start);
  if (dateOnly !== dateOnlyPattern.test(event.end)) return 'Calendar export needs a consistent start and end time; this event has a mixture of date-only and exact times.';
  if (!dateOnly && event.end === event.start) return 'Calendar export needs an end time after the start time.';
  return '';
}

export function createCalendar(event, sourceUrl, now = new Date()) {
  const reason = calendarUnavailableReason(event);
  if (reason) throw new Error(reason);
  const dateOnly = dateOnlyPattern.test(event.start);
  const timestamp = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const escapeText = value => String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  const description = [
    'MTGA Update - MTG Arena event schedule.',
    dateOnly ? 'All-day listing: exact times are not announced. The published end date is included.' : 'Event start and finish are shown at their published exact times.',
    event.match ? `Match structure: ${event.match}` : 'Match structure: not confirmed.',
    event.cost ? `Entry cost: ${event.cost}` : 'Entry cost: not confirmed.',
    event.entryCloses ? `Entry closes: ${formatDate(event.entryCloses, 'UTC', true)}.` : 'Entry cutoff: not confirmed.',
    event.note || '',
    'Confirm details in Arena before entering. This is a one-time copy; future schedule changes will not sync.'
  ].filter(Boolean).join('\n');
  // iCalendar end dates are exclusive; our published date-only ranges include the last day.
  const end = dateOnly ? new Date(`${event.end}T00:00:00Z`) : null;
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MTGA Update//Arena Event Schedule//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeText(event.id)}@anibalrodriguez.github.io`,
    `DTSTAMP:${timestamp(now)}`,
    dateOnly ? `DTSTART;VALUE=DATE:${event.start.replaceAll('-', '')}` : `DTSTART:${timestamp(event.start)}`,
    dateOnly ? `DTEND;VALUE=DATE:${end.toISOString().slice(0, 10).replaceAll('-', '')}` : `DTEND:${timestamp(event.end)}`,
    `SUMMARY:${escapeText(`${event.name} - ${event.format}`)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${new URL(sourceUrl).href}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  const encoder = new TextEncoder();
  const fold = line => {
    let folded = '';
    let bytes = 0;
    for (const character of line) {
      const size = encoder.encode(character).length;
      if (bytes + size > 75) {
        folded += '\r\n ';
        bytes = 1;
      }
      folded += character;
      bytes += size;
    }
    return folded;
  };
  return `${lines.map(fold).join('\r\n')}\r\n`;
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
