import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dateKey, eventStatus, formatDate, groupEvents, sortEvents, upcomingInWindow, validateSchedule } from '../schedule.mjs';

const data = JSON.parse(await readFile(new URL('../events.json', import.meta.url), 'utf8'));
const filters = { category: 'all', search: '' };

test('curated data is valid and every event cites an official source', () => {
  assert.equal(validateSchedule(data), data);
});

test('optional season rewards keep schedules backward compatible and convert the distribution instant', () => {
  const withoutRewards = structuredClone(data);
  delete withoutRewards.seasonRewards;
  assert.equal(validateSchedule(withoutRewards), withoutRewards);
  const rewards = data.seasonRewards;
  assert.match(formatDate(rewards.distributedAt, 'America/Los_Angeles', true), /Oct 31, 2026, 12:05 PM PDT/);
  assert.match(formatDate(rewards.distributedAt, 'UTC', true), /Oct 31, 2026, 7:05 PM UTC/);
  const now = new Date('2026-10-19T12:00:00Z');
  assert.deepEqual(groupEvents(data.events, filters, now), groupEvents(withoutRewards.events, filters, now));
});

test('season rewards reject invalid distribution times, incomplete ranks, missing sources, and unsafe previews', () => {
  for (const mutate of [
    rewards => { rewards.distributedAt = '2026-10-31'; },
    rewards => { rewards.distributedAt = '2026-02-30T19:05:00Z'; },
    rewards => { rewards.season = '2026-13'; },
    rewards => { rewards.ranks.pop(); },
    rewards => { rewards.ranks[1].rank = 'Bronze'; },
    rewards => { rewards.ranks[0].gold = -1; },
    rewards => { rewards.ranks[0].packs = 1.5; },
    rewards => { rewards.ranks[0].styles = ['missing-style']; },
    rewards => { rewards.styles[1].id = rewards.styles[0].id; },
    rewards => { rewards.styles[0].imageUrl = 'https://example.com/card.webp'; },
    rewards => { rewards.sources = ['missing-source']; }
  ]) {
    const copy = structuredClone(data);
    mutate(copy.seasonRewards);
    assert.throws(() => validateSchedule(copy));
  }
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
  assert.deepEqual(groups.conflicts.map(event => event.id), ['contender']);
  const limited = groupEvents(data.events, { category: 'limited', search: 'innistrad' }, now);
  assert.equal(limited.current.length, 0);
  assert.deepEqual(limited.upcoming.map(event => event.id), ['flashback-vow', 'flashback-mid', 'flashback-sir']);
  assert.equal(groupEvents(data.events, filters, new Date('2026-11-12T12:00:00Z')).conflicts.length, 0);
});

test('timezone conversion reflects Pacific daylight saving changes', () => {
  assert.match(formatDate('2026-10-24T13:00:00Z', 'America/Los_Angeles', true), /6:00 AM PDT/);
  assert.match(formatDate('2026-11-02T16:00:00Z', 'America/Los_Angeles', true), /8:00 AM PST/);
});

test('reviewed Arena Direct moves to the schedule while Contender retains its disputed range', () => {
  const event = data.events.find(event => event.id === 'direct-fra');
  const now = new Date('2026-10-24T18:00:00Z');
  assert.match(formatDate(event.entryCloses, 'America/Los_Angeles', true), /Nov 2, 2026, 8:00 AM PST/);
  assert.match(formatDate(event.end, 'America/Los_Angeles', true), /Nov 2, 2026, 11:00 AM PST/);
  assert.equal(eventStatus(event, new Date('2026-10-19T18:00:00Z')), 'upcoming');
  assert.equal(eventStatus(event, now), 'live');
  assert.equal(eventStatus(event, new Date(event.entryCloses)), 'entry-closed');
  assert.equal(eventStatus(event, new Date(event.end)), 'expired');
  const groups = groupEvents(data.events, { category: 'limited', search: 'arena direct' }, now);
  assert.ok(groups.current.includes(event));
  assert.ok(!groups.conflicts.includes(event));
  const contender = data.events.find(event => event.id === 'contender');
  assert.equal(eventStatus(contender, now), 'conflict');
  assert.equal(formatDate(contender.end, 'UTC'), 'Nov 11');
  assert.equal(contender.entryCloses, undefined);
});

test('competitive filter combines with format and search without promoting conflicting dates', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const groups = groupEvents(data.events, { ...filters, competitive: true }, now);
  assert.equal(groups.current.length, 0);
  assert.ok(groups.upcoming.some(event => event.id === 'play-in-bo1'));
  assert.equal(groups.upcoming.some(event => event.id === 'quick-aetherdrift'), false);
  assert.deepEqual(groups.conflicts.map(event => event.id), ['contender']);
  const limited = groupEvents(data.events, { category: 'limited', search: 'sealed', competitive: true }, now);
  assert.deepEqual(limited.upcoming.map(event => event.id), ['direct-fra', 'play-in-bonus', 'play-in-bo1-nov', 'play-in-bo3-nov', 'weekend-nov', 'play-in-bonus-jan']);
  assert.deepEqual(limited.conflicts.map(event => event.id), []);
  assert.equal(Object.values(groupEvents(data.events, filters, now)).flat().length, 94);
});

test('extended Premier Draft remains scheduled after the older end date and November qualifiers are discoverable', () => {
  const premier = data.events.find(event => event.id === 'premier-fra');
  assert.equal(eventStatus(premier, new Date('2026-11-10T20:00:00Z')), 'scheduled');
  assert.equal(eventStatus(premier, new Date('2026-12-01T20:00:00Z')), 'scheduled');
  assert.equal(eventStatus(premier, new Date('2026-12-02T20:00:00Z')), 'boundary');
  assert.equal(eventStatus(premier, new Date('2026-12-03T20:00:00Z')), 'expired');
  const groups = groupEvents(data.events, { category: 'limited', search: 'star trek', competitive: true }, new Date('2026-11-14T20:00:00Z'));
  assert.deepEqual(groups.current.map(event => event.id), ['direct-trk-collector', 'play-in-bo1-nov']);
  assert.deepEqual(groups.upcoming.map(event => event.id), ['play-in-bo3-nov', 'weekend-nov', 'contender-trk-season', 'direct-trk-play', 'limited-championship-jan', 'play-in-bonus-jan']);
  assert.equal(groups.conflicts.length, 0);
});

test('Star Trek calendar extensions and cross-year events retain date-only boundaries', () => {
  const pioneer = data.events.find(event => event.id === 'flashback-pioneer');
  assert.equal(eventStatus(pioneer, new Date('2026-11-11T20:00:00Z')), 'scheduled');
  assert.equal(eventStatus(pioneer, new Date('2026-11-12T20:00:00Z')), 'boundary');
  assert.equal(eventStatus(pioneer, new Date('2026-11-13T20:00:00Z')), 'expired');
  const cube = groupEvents(data.events, { category: 'limited', search: 'cube' }, new Date('2027-01-02T20:00:00Z'));
  assert.deepEqual(cube.current.map(event => event.id), ['cube-dec', 'cube-pick-two']);
  const premier = data.events.find(event => event.id === 'premier-trk');
  assert.equal(eventStatus(premier, new Date('2027-02-02T20:00:00Z')), 'boundary');
  assert.equal(eventStatus(premier, new Date('2027-02-03T20:00:00Z')), 'expired');
  const playIn = data.events.find(event => event.id === 'play-in-bo3-jan');
  assert.equal(playIn.entryCloses, undefined);
  assert.equal(playIn.start, '2027-01-22');
  assert.match(playIn.note, /not a confirmed finish date/);
});

test('invalid dates, duplicate IDs, unsafe source URLs, and invalid cutoffs fail explicitly', () => {
  for (const mutate of [
    copy => { copy.events[0].start = '2026-02-30'; },
    copy => { copy.events[0].end = '2026-01-01'; },
    copy => { copy.events.find(event => event.id === 'contender').end = '2026-02-30'; },
    copy => { copy.events.find(event => event.id === 'contender').end = '2026-01-01'; },
    copy => { copy.events[1].id = copy.events[0].id; },
    copy => { copy.sources.set.url = 'https://example.com'; },
    copy => { copy.events.find(event => event.id === 'play-in-bo1').entryCloses = '2026-10-26T13:00:00Z'; }
  ]) {
    const copy = structuredClone(data);
    mutate(copy);
    assert.throws(() => validateSchedule(copy));
  }
});

test('January Limited Championship is discoverable by its reviewed draft formats without inventing a finish time', () => {
  const now = new Date('2027-01-16T18:00:00Z');
  for (const search of ['reality fracture', 'star trek']) {
    const groups = groupEvents(data.events, { category: 'limited', search, competitive: true }, now);
    const championship = groups.current.find(event => event.id === 'limited-championship-jan');
    assert.ok(championship);
    assert.equal(championship.match, 'BO3');
    assert.equal(championship.cost, 'Qualification required');
    assert.equal(championship.start, '2027-01-16');
    assert.equal(championship.end, '2027-01-17');
    assert.equal(championship.entryCloses, undefined);
    assert.ok(championship.sources.includes('limitedChampionshipRules'));
  }
});

test('agenda day keys preserve date-only dates and convert exact starts to the chosen timezone', () => {
  assert.equal(dateKey('2026-10-20', 'America/Los_Angeles'), '2026-10-20');
  assert.equal(dateKey('2026-10-20T01:00:00Z', 'America/Los_Angeles'), '2026-10-19');
  assert.equal(dateKey('2026-10-20T01:00:00Z', 'Asia/Tokyo'), '2026-10-20');
});

test('2027 Arena Championships are discoverable by format and retain uncertain date-only boundaries', () => {
  for (const [id, format, start, end] of [
    ['arena-championship-14', 'Pioneer', '2027-03-13', '2027-03-14'],
    ['arena-championship-15', 'Standard', '2027-07-10', '2027-07-11'],
    ['arena-championship-16', 'Historic', '2027-10-16', '2027-10-17']
  ]) {
    const groups = groupEvents(data.events, { category: 'constructed', search: format.toLowerCase(), competitive: true }, new Date('2026-10-29T19:00:00Z'));
    const event = groups.upcoming.find(event => event.id === id);
    assert.ok(event);
    assert.equal(event.start, start);
    assert.equal(event.end, end);
    assert.equal(event.cost, 'Qualification required');
    assert.equal(event.entryCloses, undefined);
    assert.equal(event.match, undefined);
    assert.ok(event.sources.includes('qualifiers'));
    assert.equal(eventStatus(event, new Date(`${start}T20:00:00Z`)), 'boundary');
    assert.equal(eventStatus(event, new Date(`${end}T20:00:00Z`)), 'boundary');
    assert.equal(eventStatus(event, new Date(Date.parse(`${end}T20:00:00Z`) + 86400000)), 'expired');
  }
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
