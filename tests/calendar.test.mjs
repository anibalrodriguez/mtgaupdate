import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calendarUnavailableReason, createCalendar } from '../schedule.mjs';

const data = JSON.parse(await readFile(new URL('../events.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-19T03:30:00Z');
const source = data.sources.set.url;
const unfold = value => value.replace(/\r\n /g, '');

test('exact-time export preserves UTC instants, entry deadline, official URL, and stable identity', () => {
  const event = data.events.find(event => event.id === 'play-in-bo1');
  const calendar = unfold(createCalendar(event, source, now));
  assert.match(calendar, /DTSTART:20261024T130000Z\r\n/);
  assert.match(calendar, /DTEND:20261025T160000Z\r\n/);
  assert.match(calendar, /DTSTAMP:20261019T033000Z\r\n/);
  assert.match(calendar, /UID:play-in-bo1@anibalrodriguez.github.io\r\n/);
  assert.match(calendar, /Entry closes: Oct 25\\, 2026\\, 1:00 PM UTC/);
  assert.ok(calendar.includes(`URL:${source}\r\n`));
  assert.match(calendar, /future schedule changes will not sync/);
});

test('date-only ranges export as all-day dates with the last published date included', () => {
  const event = data.events.find(event => event.id === 'quick-aetherdrift');
  const calendar = unfold(createCalendar(event, source, now));
  assert.match(calendar, /DTSTART;VALUE=DATE:20261019\r\n/);
  assert.match(calendar, /DTEND;VALUE=DATE:20261027\r\n/);
  assert.match(calendar, /All-day listing: exact times are not announced/);
  const sameDay = unfold(createCalendar({ ...event, start: '2026-12-31', end: '2026-12-31' }, source, now));
  assert.match(sameDay, /DTEND;VALUE=DATE:20270101\r\n/);
});

test('conflicts and incompatible or invalid dates fail instead of inventing a calendar interval', () => {
  const event = data.events[0];
  for (const invalid of [
    data.events.find(event => event.conflict),
    { ...event, end: null },
    { ...event, end: '2026-10-20T12:00:00Z' },
    { ...event, start: '2026-02-30' },
    { ...event, end: '2026-01-01' },
    { ...event, start: '2026-10-20T12:00:00Z', end: '2026-10-20T12:00:00Z' }
  ]) {
    assert.ok(calendarUnavailableReason(invalid));
    assert.throws(() => createCalendar(invalid, source, now));
  }
});

test('published detailed deadlines do not enable calendar export for a disputed event', () => {
  const event = data.events.find(event => event.id === 'direct-fra');
  assert.match(calendarUnavailableReason(event), /conflicting dates/);
  assert.throws(() => createCalendar(event, data.sources.direct.url, now), /conflicting dates/);
});

test('text escaping, UTF-8 folding, and CRLF endings preserve content without injected properties', () => {
  const name = 'Draft, sealed; café 漢字 🧙\\test\r\nBEGIN:VEVENT ' + 'é'.repeat(100);
  const calendar = createCalendar({ ...data.events[0], name }, source, now);
  assert.ok(calendar.split('\r\n').every(line => Buffer.byteLength(line, 'utf8') <= 75));
  assert.equal(calendar.replaceAll('\r\n', '').includes('\n'), false);
  const plain = unfold(calendar);
  assert.ok(plain.includes('Draft\\, sealed\\; café 漢字 🧙\\\\test\\nBEGIN:VEVENT'));
  assert.equal((plain.match(/^BEGIN:VEVENT$/gm) || []).length, 1);
  assert.ok(plain.includes('é'.repeat(100)));
});
