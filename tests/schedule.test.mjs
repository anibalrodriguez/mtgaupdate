import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dateKey, eventStatus, formatDate, groupEvents, sortEvents, upcomingInWindow, validateSchedule } from '../schedule.mjs';

const data = JSON.parse(await readFile(new URL('../events.json', import.meta.url), 'utf8'));
const filters = { category: 'all', search: '' };

test('curated data is valid and every event cites an official source', () => {
  assert.equal(validateSchedule(data), data);
});

test('date-only boundaries remain uncertain and use Pacific dates, not UTC midnight', () => {
  const event = data.events.find(event => event.id === 'quick-fra-oct');
  assert.equal(eventStatus(event, new Date('2026-10-19T02:00:00Z')), 'boundary');
  assert.equal(eventStatus(event, new Date('2026-10-19T07:00:00Z')), 'expired');
  assert.equal(formatDate('2026-10-20', 'America/Los_Angeles'), 'Oct 20');
  assert.equal(formatDate('2026-10-20', 'Asia/Tokyo'), 'Oct 20');
});

test('precise events distinguish upcoming, open, entry closed, and expired', () => {
  const event = data.events.find(event => event.id === 'play-in-bo1');
  assert.equal(eventStatus(event, new Date('2026-10-24T12:59:59Z')), 'upcoming');
  assert.equal(eventStatus(event, new Date(event.start)), 'live');
  assert.equal(eventStatus(event, new Date(event.entryCloses)), 'entry-closed');
  assert.equal(eventStatus(event, new Date(event.end)), 'expired');
});

test('filtering excludes expired events and keeps conflicts out of the current schedule', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const groups = groupEvents(data.events, filters, now);
  assert.equal(groups.current.some(event => event.id === 'quick-fra-oct'), false);
  assert.equal(groups.current.some(event => event.conflict), false);
  assert.equal(groups.conflicts.length, 2);
  const limited = groupEvents(data.events, { category: 'limited', search: 'innistrad' }, now);
  assert.equal(limited.current.length, 0);
  assert.equal(limited.upcoming.length, 2);
  assert.equal(groupEvents(data.events, filters, new Date('2026-11-12T12:00:00Z')).conflicts.length, 0);
});

test('timezone conversion reflects Pacific daylight saving changes', () => {
  assert.match(formatDate('2026-10-24T13:00:00Z', 'America/Los_Angeles', true), /6:00 AM PDT/);
  assert.match(formatDate('2026-11-02T16:00:00Z', 'America/Los_Angeles', true), /8:00 AM PST/);
});

test('published Arena Direct deadlines remain disputed instead of making the event live', () => {
  const event = data.events.find(event => event.id === 'direct-fra');
  const now = new Date('2026-10-24T18:00:00Z');
  assert.match(formatDate(event.entryCloses, 'America/Los_Angeles', true), /Nov 2, 2026, 8:00 AM PST/);
  assert.match(formatDate(event.end, 'America/Los_Angeles', true), /Nov 2, 2026, 11:00 AM PST/);
  assert.equal(eventStatus(event, now), 'conflict');
  const groups = groupEvents(data.events, { category: 'limited', search: 'arena direct' }, now);
  assert.ok(groups.conflicts.includes(event));
  assert.ok(!groups.current.includes(event));
});

test('competitive filter combines with format and search without promoting conflicting dates', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const groups = groupEvents(data.events, { ...filters, competitive: true }, now);
  assert.equal(groups.current.length, 0);
  assert.ok(groups.upcoming.some(event => event.id === 'play-in-bo1'));
  assert.equal(groups.upcoming.some(event => event.id === 'quick-aetherdrift'), false);
  assert.deepEqual(groups.conflicts.map(event => event.id), ['contender', 'direct-fra']);
  const limited = groupEvents(data.events, { category: 'limited', search: 'sealed', competitive: true }, now);
  assert.deepEqual(limited.upcoming.map(event => event.id), ['play-in-bonus', 'play-in-bo1-nov', 'play-in-bo3-nov', 'weekend-nov']);
  assert.deepEqual(limited.conflicts.map(event => event.id), ['direct-fra']);
  assert.equal(Object.values(groupEvents(data.events, filters, now)).flat().length, 28);
});

test('extended Premier Draft remains scheduled after the older end date and November qualifiers are discoverable', () => {
  const premier = data.events.find(event => event.id === 'premier-fra');
  assert.equal(eventStatus(premier, new Date('2026-11-10T20:00:00Z')), 'scheduled');
  assert.equal(eventStatus(premier, new Date('2026-12-01T20:00:00Z')), 'boundary');
  assert.equal(eventStatus(premier, new Date('2026-12-02T20:00:00Z')), 'expired');
  const groups = groupEvents(data.events, { category: 'limited', search: 'star trek', competitive: true }, new Date('2026-11-14T20:00:00Z'));
  assert.deepEqual(groups.current.map(event => event.id), ['play-in-bo1-nov']);
  assert.deepEqual(groups.upcoming.map(event => event.id), ['play-in-bo3-nov', 'weekend-nov']);
  assert.equal(groups.conflicts.length, 0);
});

test('invalid dates, duplicate IDs, unsafe source URLs, and invalid cutoffs fail explicitly', () => {
  for (const mutate of [
    copy => { copy.events[0].start = '2026-02-30'; },
    copy => { copy.events[0].end = '2026-01-01'; },
    copy => { copy.events.find(event => event.id === 'direct-fra').end = '2026-02-30'; },
    copy => { copy.events.find(event => event.id === 'direct-fra').end = '2026-01-01'; },
    copy => { copy.events[1].id = copy.events[0].id; },
    copy => { copy.sources.set.url = 'https://example.com'; },
    copy => { copy.events.find(event => event.id === 'play-in-bo1').entryCloses = '2026-10-26T13:00:00Z'; }
  ]) {
    const copy = structuredClone(data);
    mutate(copy);
    assert.throws(() => validateSchedule(copy));
  }
});

test('agenda day keys preserve date-only dates and convert exact starts to the chosen timezone', () => {
  assert.equal(dateKey('2026-10-20', 'America/Los_Angeles'), '2026-10-20');
  assert.equal(dateKey('2026-10-20T01:00:00Z', 'America/Los_Angeles'), '2026-10-19');
  assert.equal(dateKey('2026-10-20T01:00:00Z', 'Asia/Tokyo'), '2026-10-20');
});

test('upcoming windows include the final calendar day and preserve the source list', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const events = [
    { start: '2026-10-26T23:59:59Z' },
    { start: '2026-10-27' }
  ];
  assert.deepEqual(upcomingInWindow(events, '7', 'UTC', now), [events[0]]);
  assert.deepEqual(upcomingInWindow(events, 'all', 'UTC', now), events);
  assert.equal(events.length, 2);
});

test('ledger sorting keeps unconfirmed ends last without changing shared data', () => {
  const events = [
    { id: 'conflict', name: 'A', start: '2026-10-01', end: null },
    { id: 'later', name: 'Z', start: '2026-10-02', end: '2026-10-30' },
    { id: 'earlier', name: 'M', start: '2026-10-03', end: '2026-10-20' }
  ];
  assert.deepEqual(sortEvents(events, 'end', 'UTC').map(event => event.id), ['earlier', 'later', 'conflict']);
  assert.deepEqual(sortEvents(events, 'name', 'UTC').map(event => event.id), ['conflict', 'earlier', 'later']);
  assert.deepEqual(events.map(event => event.id), ['conflict', 'later', 'earlier']);
});
