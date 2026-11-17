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

test('reviewed Arena Direct exports its accepted schedule while Contender remains blocked', () => {
  const event = data.events.find(event => event.id === 'direct-fra');
  assert.equal(calendarUnavailableReason(event), '');
  const calendar = unfold(createCalendar(event, data.sources[event.sources[0]].url, now));
  assert.match(calendar, /DTSTART:20261023T150000Z\r\n/);
  assert.match(calendar, /DTEND:20261102T190000Z\r\n/);
  assert.match(calendar, /Entry closes: Nov 2\\, 2026\\, 4:00 PM UTC/);
  assert.match(calendar, /Matches in progress may finish/);
  const contender = data.events.find(event => event.id === 'contender');
  assert.match(calendarUnavailableReason(contender), /conflicting dates/);
  assert.throws(() => createCalendar(contender, data.sources.announcements.url, now), /conflicting dates/);
  const midnightHunt = data.events.find(event => event.id === 'flashback-mid');
  assert.throws(() => createCalendar(midnightHunt, data.sources.rankedSeason.url, now), /conflicting dates/);
});

test('Edge of Eternities Arena Direct export preserves the reviewed November 9 cutoff', () => {
  const event = data.events.find(event => event.id === 'direct-eoe');
  const calendar = unfold(createCalendar(event, data.sources[event.sources[0]].url, now));
  assert.match(calendar, /DTSTART:20261106T160000Z\r\n/);
  assert.match(calendar, /DTEND:20261109T190000Z\r\n/);
  assert.match(calendar, /Entry closes: Nov 9\\, 2026\\, 4:00 PM UTC/);
  assert.match(calendar, /SUMMARY:Arena Direct - Edge of Eternities Sealed\r\n/);
  assert.match(calendar, /Entry cost: 6\\,000 gems/);
  assert.match(calendar, /Matches in progress may finish/);
  assert.match(calendar, /URL:https:\/\/magic.wizards.com\/en\/news\/mtg-arena\/arena-direct-terms-and-conditions\r\n/);
});

test('Star Trek Arena Direct export includes its reviewed November 23 cutoff and Collector entry cost', () => {
  const event = data.events.find(event => event.id === 'direct-trk-collector');
  const calendar = unfold(createCalendar(event, data.sources[event.sources[0]].url, now));
  assert.match(calendar, /DTSTART:20261113T160000Z\r\n/);
  assert.match(calendar, /DTEND:20261123T190000Z\r\n/);
  assert.match(calendar, /Entry closes: Nov 23\\, 2026\\, 4:00 PM UTC/);
  assert.match(calendar, /Match structure: BO1/);
  assert.match(calendar, /Entry cost: 8\\,000 gems/);
  assert.match(calendar, /SUMMARY:Arena Direct - Magic: The Gathering \| Star Trek Sealed\r\n/);
  assert.match(calendar, /Matches in progress may finish/);
});

test('Star Trek Contender exports exact cross-year deadlines and the reviewed entry options', () => {
  const event = data.events.find(event => event.id === 'contender-trk-season');
  const calendar = unfold(createCalendar(event, data.sources[event.sources[0]].url, now));
  assert.match(calendar, /DTSTART:20261123T160000Z\r\n/);
  assert.match(calendar, /DTEND:20270202T190000Z\r\n/);
  assert.match(calendar, /Entry closes: Feb 2\\, 2027\\, 4:00 PM UTC/);
  assert.match(calendar, /Entry cost: 3\\,000 gems \/ 20\\,000 gold/);
  assert.match(calendar, /February 1 summary heading/);
  assert.match(calendar, /URL:https:\/\/magic.wizards.com\/en\/news\/mtg-arena\/announcements-november-16-2026\r\n/);
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
