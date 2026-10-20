import { calendarUnavailableReason, createCalendar, dateKey, eventStatus, formatDate, groupEvents, sortEvents, upcomingInWindow, validateSchedule } from './schedule.mjs';

const $ = selector => document.querySelector(selector);
const requestedDesign = new URLSearchParams(location.search).get('design');
const design = ['list', 'agenda', 'ledger'].includes(requestedDesign) ? requestedDesign : 'schedule';
const state = { category: 'all', search: '', competitive: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, window: 'all', status: 'all', sort: 'start' };
let data;

document.documentElement.dataset.design = design;
document.querySelectorAll('[data-design-link]').forEach(link => {
  if (link.dataset.designLink === design) link.setAttribute('aria-current', 'page');
});
if (design === 'schedule') {
  $('.brand').textContent = 'MTGA Update';
  $('.heading-line').append($('#timezone').closest('label'));
  $('header').append($('#today'));
  $('.toolbar').insertBefore($('.filter-options'), $('.search'));
  $('#search').placeholder = 'Search by event name or format';
  $('#upcoming-caption').textContent = '';
  document.querySelectorAll('[data-category]').forEach(button => {
    const count = element('span', 'tab-count');
    count.dataset.categoryCount = button.dataset.category;
    button.append(count);
  });
} else if (design !== 'list') {
  const agenda = design === 'agenda';
  document.title = `MTGA Update - ${agenda ? 'Day planner' : 'Event ledger'}`;
  $('#design-description').hidden = false;
  $('#design-description').textContent = agenda
    ? '02 / DAY PLANNER - Current events as cards. Upcoming events grouped by their start day.'
    : '03 / EVENT LEDGER - A denser, sortable view with dates and data certainty side by side.';
  $(`#${design}-controls`).hidden = false;
  if (agenda) {
    $('#upcoming-label').textContent = 'Starting next';
    $('#current-caption').textContent = 'Scheduled dates, not guaranteed availability';
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fact(list, label, value) {
  const row = element('div');
  row.append(element('dt', '', label), element('dd', '', value));
  list.append(row);
}

function renderSeasonRewards(rewards) {
  const section = $('#season-rewards');
  section.hidden = !rewards;
  if (!rewards) return;
  const season = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${rewards.season}-01T00:00:00Z`));
  $('#season-rewards-heading').textContent = `${season} season rewards`;
  $('#season-rewards-eligibility').textContent = rewards.eligibility;
  $('#season-rewards-packs').textContent = `All packs are ${rewards.packSet}. Card styles are cosmetic rewards, not additional card copies.`;
  const rows = rewards.ranks.map(reward => {
    const row = element('tr');
    const rank = element('th', '', reward.rank);
    rank.scope = 'row';
    const value = element('td');
    value.append(element('span', 'reward-amount', `${reward.packs} ${reward.packs === 1 ? 'pack' : 'packs'}${reward.gold ? ` + ${reward.gold.toLocaleString('en-US')} gold` : ''}`));
    if (reward.styles.length) {
      value.append(element('span', 'reward-styles', reward.styles.map(id => rewards.styles.find(style => style.id === id).name).join(' + ')));
    }
    row.append(rank, value);
    return row;
  });
  $('#season-rewards-ranks').replaceChildren(...rows);
  const previews = rewards.styles.map(style => {
    const figure = element('figure', 'reward-preview');
    const link = element('a');
    link.href = style.imageUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open ${style.name} card-style preview`);
    const image = element('img');
    image.src = style.imageUrl;
    image.alt = `${style.name} depth-art card style`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.width = 250;
    image.height = 350;
    image.addEventListener('error', () => {
      console.error(`Unable to load season reward preview: ${style.imageUrl}`);
      link.replaceChildren(element('span', 'reward-image-error', 'Preview unavailable. Open the official image.'));
    }, { once: true });
    link.append(image);
    const caption = element('figcaption');
    const firstRank = rewards.ranks.find(reward => reward.styles.includes(style.id));
    caption.append(element('strong', '', style.name), element('span', '', firstRank ? `${firstRank.rank} rank and above` : 'Card-style preview'));
    figure.append(link, caption);
    return figure;
  });
  $('#season-rewards-previews').replaceChildren(...previews);
  const sources = rewards.sources.map((id, index) => {
    const link = element('a', '', index ? 'Additional official source' : 'Official rewards announcement');
    link.href = data.sources[id].url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  });
  $('#season-rewards-sources').replaceChildren(...sources);
}

function statusLabel(event, now) {
  const status = eventStatus(event, now);
  if (event.conflict) return { text: design === 'schedule' ? 'Needs confirmation' : 'Dates disagree', style: 'warning' };
  if (status === 'entry-closed') return { text: 'Entry closed', style: 'warning' };
  if (status === 'live') return { text: 'Live now', style: 'live' };
  if (status === 'boundary') return { text: 'Time unconfirmed', style: '' };
  if (design === 'ledger') {
    return { text: event.start.length === 10 || event.end?.length === 10 ? 'Date only' : 'Exact times', style: '' };
  }
  return { text: event.competitive ? 'Competitive' : '', style: '' };
}

function eventRow(event, now) {
  const details = element('details', 'event');
  details.dataset.event = event.id;
  const summary = element('summary');
  const dateRange = `${formatDate(event.start, state.timezone)}${event.end ? ` - ${formatDate(event.end, state.timezone)}` : ' onward'}${event.conflict && event.end ? ' (disputed)' : ''}`;
  const name = element('span');
  name.className = 'event-name';
  const heading = element('span', 'event-heading');
  heading.append(element('span', 'event-title', event.name));
  if (design === 'schedule' && event.match) heading.append(element('span', 'match-type', event.match));
  name.append(heading, element('span', 'event-format', [event.format, design === 'schedule' ? (event.competitive ? 'Competitive' : '') : event.match].filter(Boolean).join(' / ')));
  if (design === 'schedule') {
    const category = element('span', 'event-category', event.category === 'limited' ? 'Limited' : 'Constructed');
    const dates = element('span', 'schedule-dates');
    dates.append(element('span', 'date-range', dateRange));
    if (event.start.length !== 10) {
      dates.append(element('span', 'exact-start', `Starts ${formatDate(event.start, state.timezone, true)}`));
    }
    dates.append(element('span', `entry-cutoff${event.conflict ? ' date-warning' : ''}`, event.entryCloses
      ? `Entry closes ${formatDate(event.entryCloses, state.timezone, true)}`
      : event.conflict ? 'End date needs confirmation'
        : event.start.length === 10 || event.end?.length === 10 ? 'Exact times not announced' : 'Expand for end time'));
    if (event.conflict && event.end) dates.append(element('span', 'date-warning', 'Published dates disagree; see details'));
    if (eventStatus(event, now) === 'entry-closed') dates.append(element('span', 'date-warning', 'Entry closed'));
    summary.append(name, category, dates);
  } else if (design === 'ledger') {
    const start = element('span', 'ledger-date', formatDate(event.start, state.timezone));
    const end = element('span', 'ledger-date', event.end ? formatDate(event.end, state.timezone) : 'Unconfirmed');
    start.dataset.label = 'Starts';
    end.dataset.label = 'Ends';
    start.setAttribute('aria-label', `Starts ${formatDate(event.start, state.timezone, true)}`);
    end.setAttribute('aria-label', event.end ? `Ends ${formatDate(event.end, state.timezone, true)}` : 'End date unconfirmed');
    summary.append(name, start, end);
  } else {
    summary.append(element('span', 'event-dates', dateRange), name);
  }
  if (design !== 'schedule') {
    const badge = statusLabel(event, now);
    if (badge.text) summary.append(element('span', `badge ${badge.style}`, badge.text));
    else summary.append(element('span', 'badge-placeholder'));
  }
  const expand = element('span', 'expand', design === 'schedule' ? '⌄' : '+');
  expand.setAttribute('aria-hidden', 'true');
  summary.append(expand);
  details.append(summary);

  const body = element('div', 'event-body');
  const facts = element('dl');
  fact(facts, 'Starts', formatDate(event.start, state.timezone, true));
  fact(facts, event.conflict && event.end ? 'Published end (disputed)' : 'Ends', event.end ? formatDate(event.end, state.timezone, true) : 'Conflicting official dates');
  fact(facts, 'Entry closes', event.entryCloses ? formatDate(event.entryCloses, state.timezone, true) : 'Not confirmed in the reviewed sources');
  fact(facts, 'Entry cost', event.cost || 'Not confirmed in the reviewed sources');
  fact(facts, 'Match structure', event.match || 'Not confirmed in the reviewed sources');
  body.append(facts);
  if (event.start.length === 10 || event.end?.length === 10) {
    body.append(element('p', 'event-note', 'Dates are published without exact times. They are shown as written, not converted to midnight or shifted to your timezone. Confirm availability in Arena.'));
  }
  if (event.note) body.append(element('p', `event-note${event.conflict ? ' conflict' : ''}`, event.note));
  const calendar = element('div', 'calendar-action');
  const calendarButton = element('button', 'calendar-button', 'Add to calendar');
  calendarButton.type = 'button';
  calendarButton.setAttribute('aria-label', `Add ${event.name} - ${event.format} to calendar`);
  const unavailable = calendarUnavailableReason(event);
  calendarButton.disabled = Boolean(unavailable);
  const calendarNote = element('p', 'calendar-note', unavailable || `${event.start.length === 10 ? 'Added as an all-day event. ' : ''}Downloads an .ics file. Future changes will not sync.`);
  calendarNote.id = `calendar-note-${event.id}`;
  calendarButton.setAttribute('aria-describedby', calendarNote.id);
  const downloadCalendar = () => {
    try {
      const content = createCalendar(event, data.sources[event.sources[0]].url);
      const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
      const link = element('a');
      link.href = url;
      link.download = `${event.id.replace(/[^a-z0-9_-]/gi, '-')}.ics`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Unable to export the Arena event:', error);
      calendarNote.textContent = 'The calendar file could not be created. Please reload the page and try again.';
      calendarNote.setAttribute('role', 'alert');
      details.open = true;
    }
  };
  if (!unavailable) calendarButton.addEventListener('click', downloadCalendar);
  if (design === 'schedule') {
    const quickCalendar = element('button', 'calendar-quick');
    quickCalendar.type = 'button';
    quickCalendar.setAttribute('aria-label', calendarButton.getAttribute('aria-label'));
    quickCalendar.setAttribute('aria-describedby', calendarNote.id);
    quickCalendar.setAttribute('aria-disabled', String(Boolean(unavailable)));
    quickCalendar.title = unavailable || `Add to calendar. ${calendarNote.textContent}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [attribute, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
      icon.setAttribute(attribute, value);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m7 9v6m-3-3h6');
    icon.append(path);
    quickCalendar.append(icon);
    quickCalendar.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!unavailable) downloadCalendar();
    });
    summary.insertBefore(quickCalendar, expand);
  }
  calendar.append(calendarButton, calendarNote);
  body.append(calendar);
  const links = element('div', 'source-links');
  event.sources.forEach((id, index) => {
    const source = data.sources[id];
    const link = element('a', '', index === 0 ? 'Official source' : 'Additional official source');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = source.title;
    links.append(link);
  });
  body.append(links, element('p', 'event-verified', `Source reviewed ${formatDate(event.verifiedAt, state.timezone, true)}`));
  details.append(body);
  return details;
}

function renderRows(events, now, expanded) {
  return events.map(event => {
    const row = eventRow(event, now);
    row.open = expanded.has(event.id);
    return row;
  });
}

function agendaDays(events, now, expanded) {
  const days = new Map();
  for (const event of sortEvents(events, 'start', state.timezone)) {
    const key = dateKey(event.start, state.timezone);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(event);
  }
  return [...days].map(([key, events]) => {
    const day = element('div', 'agenda-day');
    const label = element('div', 'agenda-day-label');
    const date = new Date(`${key}T12:00:00Z`);
    label.append(element('span', '', new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date)));
    label.append(element('strong', '', new Intl.DateTimeFormat('en-US', { day: '2-digit', timeZone: 'UTC' }).format(date)));
    label.append(element('span', '', new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(date)));
    const list = element('div', 'agenda-day-events');
    list.append(...renderRows(events, now, expanded));
    day.append(label, list);
    return day;
  });
}

function render() {
  if (!data) return;
  const now = new Date();
  const expanded = new Set([...document.querySelectorAll('.event[open]')].map(node => node.dataset.event));
  const groups = groupEvents(data.events, state, now);
  if (design === 'agenda') groups.upcoming = upcomingInWindow(groups.upcoming, state.window, state.timezone, now);
  const targets = { current: '#current-events', upcoming: '#upcoming-events', conflicts: '#conflict-events' };
  for (const [group, selector] of Object.entries(targets)) {
    let nodes = design === 'agenda' && group === 'upcoming'
      ? agendaDays(groups[group], now, expanded)
      : renderRows(design === 'ledger' ? sortEvents(groups[group], state.sort, state.timezone) : groups[group], now, expanded);
    if (!nodes.length) nodes.push(element('p', 'empty', state.search || state.competitive || state.category !== 'all' ? 'No events match these filters.' : 'No verified listings in this section. Check the official schedule for updates.'));
    if (['ledger', 'schedule'].includes(design) && groups[group].length) {
      const headings = element('div', design === 'schedule' ? 'schedule-columns' : 'ledger-headings');
      headings.setAttribute('aria-hidden', 'true');
      (design === 'schedule' ? ['EVENT / FORMAT', 'CATEGORY', 'DATES / ENTRY CUTOFF', '', ''] : ['EVENT / FORMAT', 'STARTS', 'ENDS', 'DATA STATUS', '']).forEach(text => headings.append(element('span', '', text)));
      nodes.unshift(headings);
    }
    $(selector).replaceChildren(...nodes);
    $(`#${group === 'conflicts' ? 'conflicts' : group}-count`).textContent = groups[group].length;
    const section = document.querySelector(`[data-schedule-group="${group}"]`);
    section.hidden = (group === 'conflicts' && !groups[group].length) || (design === 'ledger' && state.status !== 'all' && state.status !== group);
  }
  if (design === 'schedule') {
    const available = Object.values(groupEvents(data.events, { ...state, category: 'all' }, now)).flat();
    document.querySelectorAll('[data-category-count]').forEach(label => {
      label.textContent = label.dataset.categoryCount === 'all' ? available.length : available.filter(event => event.category === label.dataset.categoryCount).length;
      label.closest('button').title = `${label.textContent} current, upcoming, and needs-confirmation listings matching the search and competitive filter`;
    });
  }
  if (design === 'agenda') $('#upcoming-caption').textContent = state.window === 'all' ? 'Grouped by start day' : `Next ${state.window} calendar days / current events unchanged`;
  if (design === 'ledger') {
    for (const group of ['all', 'current', 'upcoming', 'conflicts']) {
      $(`[data-status-count="${group}"]`).textContent = group === 'all' ? Object.values(groups).reduce((sum, events) => sum + events.length, 0) : groups[group].length;
    }
    // Keep empty filtered views explicit rather than leaving a blank ledger.
    if (state.status === 'conflicts') $('#conflicts-section').hidden = false;
  }
  $('#today').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: state.timezone }).format(now);
  if (data.seasonRewards) {
    const previousSeason = now >= new Date(data.seasonRewards.distributedAt);
    $('#season-rewards-label').textContent = previousSeason ? 'Ranked play / Previous season' : 'Ranked play';
    $('#season-rewards-status').hidden = !previousSeason;
    $('#season-rewards-time').textContent = `${previousSeason ? 'Distribution was scheduled for' : 'Distribution scheduled for'} ${formatDate(data.seasonRewards.distributedAt, state.timezone, true)}`;
    const reviewedAt = data.seasonRewards.verifiedAt;
    const staleRewards = now.getTime() - new Date(reviewedAt).getTime() > 7 * 86400000;
    $('#season-rewards-verified').textContent = `Source reviewed ${formatDate(reviewedAt, state.timezone, true)}.${staleRewards ? ' Rewards have not been reviewed in more than 7 days; check the official announcement.' : ''}`;
  }
  $('#verified').textContent = `Sources last reviewed: ${formatDate(data.verifiedAt, state.timezone, true)}. Updates are manual.`;
  const stale = now.getTime() - new Date(data.verifiedAt).getTime() > 7 * 86400000;
  $('#freshness').textContent = stale ? 'This schedule has not been reviewed in more than 7 days. Check official sources before making plans.' : '';
  $('#results').textContent = design === 'ledger' && state.status !== 'all'
    ? `${groups[state.status].length} events in the selected ${state.status} view.`
    : `${groups.current.length} current, ${groups.upcoming.length} upcoming, and ${groups.conflicts.length} events needing confirmation.`;
}

document.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
  state.category = button.dataset.category;
  document.querySelectorAll('[data-category]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  render();
}));
$('#search').addEventListener('input', event => {
  state.search = event.target.value.trim().toLowerCase();
  render();
});
$('#competitive').addEventListener('change', event => {
  state.competitive = event.target.checked;
  render();
});
$('#timezone').options[0].textContent = state.timezone.replaceAll('_', ' ');
$('#timezone').addEventListener('change', event => {
  state.timezone = event.target.value === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : event.target.value;
  render();
});
$('#upcoming-window').addEventListener('change', event => {
  state.window = event.target.value;
  render();
});
$('#event-sort').addEventListener('change', event => {
  state.sort = event.target.value;
  render();
});
document.querySelectorAll('[data-status]').forEach(button => button.addEventListener('click', () => {
  state.status = button.dataset.status;
  document.querySelectorAll('[data-status]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
  render();
}));
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

async function loadSchedule() {
  try {
    const response = await fetch('./events.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Schedule request failed (${response.status})`);
    data = validateSchedule(await response.json());
    renderSeasonRewards(data.seasonRewards);
    render();
    $('#schedule').hidden = false;
    $('#load-status').hidden = true;
    setInterval(render, 60000);
  } catch (error) {
    console.error('Unable to load the Arena schedule:', error);
    $('#load-status').textContent = 'The schedule could not be loaded. Please reload the page. If this continues, check the official Arena announcements.';
    $('#load-status').className = 'error';
    const link = element('a', '', ' Official Arena announcements');
    link.href = 'https://magic.wizards.com/en/news/mtg-arena';
    $('#load-status').append(link);
  }
}
loadSchedule();
