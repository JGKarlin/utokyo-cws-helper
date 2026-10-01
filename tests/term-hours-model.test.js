const test = require('node:test');
const assert = require('node:assert/strict');

let isFullDayPaidLeave, findMissingWorkdays, findScheduledWorkdays, planMissingEntries, advancePlannedEntryState, completedHoursMessage, countMonthEntries, plannedEntryProgress;
try {
  ({ isFullDayPaidLeave, findMissingWorkdays, findScheduledWorkdays, planMissingEntries, advancePlannedEntryState, completedHoursMessage, countMonthEntries, plannedEntryProgress } = require('../term-hours-model.js'));
} catch (_) {}

test('describes a fully verified month in recent history', () => {
  assert.equal(typeof completedHoursMessage, 'function');
  assert.equal(
    completedHoursMessage('2026-08', 20),
    '2026年8月分：勤務時間の入力完了（20勤務日）。出勤・退勤・勤務外時間数を確認済み。'
  );
  assert.equal(
    completedHoursMessage('2026-08', Number.NaN),
    '2026年8月分：勤務時間の入力完了（0勤務日）。出勤・退勤・勤務外時間数を確認済み。'
  );
});

test('excludes full-day paid leave from missing work time', () => {
  assert.equal(typeof findMissingWorkdays, 'function');
  const missing = findMissingWorkdays(
    ['2026-07-10'],
    [{ day: 10, hasArrival: false, hasDeparture: false, rowText: '7/10 金 年休（日） 年次有給休暇 全日' }]
  );
  assert.deepEqual(missing, []);
});

test('recognizes compact and full-width full-day paid-leave text', () => {
  assert.equal(typeof isFullDayPaidLeave, 'function');
  assert.equal(isFullDayPaidLeave('7/10（金）　年休（日）／年次有給休暇／全日'), true);
  assert.equal(isFullDayPaidLeave('7/10(金)年休（日）年次有給休暇全日'), true);
});

test('keeps a normal blank weekday missing', () => {
  assert.deepEqual(
    findMissingWorkdays(['2026-07-09'], [{ day: 9, hasArrival: false, hasDeparture: false, rowText: '7/9 木' }]),
    ['2026-07-09']
  );
});

test('does not classify partial-day leave as full-day paid leave', () => {
  assert.equal(isFullDayPaidLeave('年休（時間） 2時間'), false);
  assert.deepEqual(
    findMissingWorkdays(['2026-07-11'], [{ day: 11, hasArrival: false, hasDeparture: false, rowText: '7/11 土 年休（時間） 2時間' }]),
    ['2026-07-11']
  );
});

test('keeps an absent row missing', () => {
  assert.deepEqual(findMissingWorkdays(['2026-07-12'], []), ['2026-07-12']);
});

test('keeps a row with only one clock field missing', () => {
  assert.deepEqual(
    findMissingWorkdays(['2026-07-13'], [{ day: 13, hasArrival: true, hasDeparture: false, rowText: '7/13 月 9時00分' }]),
    ['2026-07-13']
  );
});

test('does not skip unrelated text that happens to contain 全日', () => {
  assert.equal(isFullDayPaidLeave('7/14 火 特記事項：全日対応'), false);
  assert.deepEqual(
    findMissingWorkdays(['2026-07-14'], [{ day: 14, hasArrival: false, hasDeparture: false, rowText: '7/14 火 特記事項：全日対応' }]),
    ['2026-07-14']
  );
});

test('excludes duplicate July 10 rows when full-day leave appears first or last', () => {
  const leave = { day: 10, hasArrival: false, hasDeparture: false, rowText: '7/10 金 年休（日） 年次有給休暇 全日' };
  const blank = { day: 10, hasArrival: false, hasDeparture: false, rowText: '7/10 金' };
  assert.deepEqual(findMissingWorkdays(['2026-07-10'], [leave, blank]), []);
  assert.deepEqual(findMissingWorkdays(['2026-07-10'], [blank, leave]), []);
});

test('treats any complete duplicate as date-level completion without leave', () => {
  const complete = { day: 10, hasArrival: true, hasDeparture: true, rowText: '7/10 金 9時00分 18時00分' };
  const blank = { day: 10, hasArrival: false, hasDeparture: false, rowText: '7/10 金' };
  assert.deepEqual(findMissingWorkdays(['2026-07-10'], [complete, blank]), []);
  assert.deepEqual(findMissingWorkdays(['2026-07-10'], [blank, complete]), []);
});

test('keeps a partial and blank duplicate missing without leave', () => {
  const partial = { day: 10, hasArrival: true, hasDeparture: false, rowText: '7/10 金 9時00分' };
  const blank = { day: 10, hasArrival: false, hasDeparture: false, rowText: '7/10 金' };
  assert.deepEqual(findMissingWorkdays(['2026-07-10'], [partial, blank]), ['2026-07-10']);
  assert.deepEqual(findMissingWorkdays(['2026-07-10'], [blank, partial]), ['2026-07-10']);
});

test('resumes only the missing break after an interrupted workday', () => {
  assert.equal(typeof planMissingEntries, 'function');
  assert.deepEqual(
    planMissingEntries(['2026-08-10'], [{
      day: 10,
      hasArrival: true,
      hasDeparture: true,
      hasBreak: false,
      rowText: '8/10 月 09時11分 18時04分'
    }]),
    [{ date: '2026-08-10', phase: 'break' }]
  );
});

test('plans every missing field for the remaining full month in date order', () => {
  assert.deepEqual(
    planMissingEntries(['2026-08-10', '2026-08-12'], [
      { day: 10, hasArrival: true, hasDeparture: true, hasBreak: false, rowText: '8/10 月 09時11分 18時04分' },
      { day: 12, hasArrival: false, hasDeparture: false, hasBreak: false, rowText: '8/12 水' }
    ]),
    [
      { date: '2026-08-10', phase: 'break' },
      { date: '2026-08-12', phase: 'clockin' },
      { date: '2026-08-12', phase: 'clockout' },
      { date: '2026-08-12', phase: 'break' }
    ]
  );
});

test('advances a resumable per-field plan without replaying completed fields', () => {
  assert.equal(typeof advancePlannedEntryState, 'function');
  const start = {
    phase: 'break',
    dates: ['2026-08-10', '2026-08-12', '2026-08-12', '2026-08-12'],
    taskPhases: ['break', 'clockin', 'clockout', 'break'],
    dateIndex: 0,
    config: { arriveRange: {}, departRange: {} }
  };
  const next = advancePlannedEntryState(start);
  assert.equal(next.dateIndex, 1);
  assert.equal(next.phase, 'clockin');
  assert.equal(next.dates[next.dateIndex], '2026-08-12');
  assert.equal(advancePlannedEntryState({ ...start, dateIndex: 3, phase: 'break' }), null);
});

test('derives scheduled dates from live 勤務表 day classes', () => {
  assert.equal(typeof findScheduledWorkdays, 'function');
  assert.deepEqual(
    findScheduledWorkdays('2026-07', [
      { day: 3, dayClass: 'mg_normal' },
      { day: 4, dayClass: 'mg_dh_sat' },
      { day: 5, dayClass: 'mg_dh_sun' },
      { day: 20, dayClass: 'mg_dh_holiday' },
      { day: 21, dayClass: 'mg_normal' }
    ]),
    ['2026-07-03', '2026-07-21']
  );
});

test('includes the entire current month when run before month end', () => {
  assert.deepEqual(
    findScheduledWorkdays('2026-08', [
      { day: 3, dayClass: 'mg_normal' },
      { day: 7, dayClass: 'mg_normal' },
      { day: 10, dayClass: 'mg_dh_holiday' },
      { day: 11, dayClass: 'mg_normal' }
    ]),
    ['2026-08-03', '2026-08-07', '2026-08-11']
  );
});

test('fails closed on unknown day classes', () => {
  assert.deepEqual(
    findScheduledWorkdays('2026-08', [
      { day: 3, dayClass: '' },
      { day: 4, dayClass: 'new_unknown_class' },
      { day: 5, dayClass: 'mg_normal extra' }
    ]),
    ['2026-08-05']
  );
});

test('fails closed on impossible calendar dates', () => {
  assert.deepEqual(
    findScheduledWorkdays('2026-02', [
      { day: 28, dayClass: 'mg_normal' },
      { day: 29, dayClass: 'mg_normal' },
      { day: 31, dayClass: 'mg_normal' }
    ]),
    ['2026-02-28']
  );
  assert.deepEqual(findScheduledWorkdays('2026-13', [{ day: 1, dayClass: 'mg_normal' }]), []);
});

// October 2026: 21 scheduled workdays (10/12 スポーツの日 excluded) = 63 entries.
const OCTOBER = ['01', '02', '05', '06', '07', '08', '09', '13', '14', '15', '16',
  '19', '20', '21', '22', '23', '26', '27', '28', '29', '30'].map(d => `2026-10-${d}`);

test('counts the whole month of entries, skipping full-day paid leave', () => {
  assert.equal(typeof countMonthEntries, 'function');
  assert.equal(countMonthEntries(OCTOBER, []), 63);
  // Filled days still count toward the month — they are progress already made.
  const filled = { day: 1, hasArrival: true, hasDeparture: true, hasBreak: true, rowText: '10/1 木' };
  assert.equal(countMonthEntries(OCTOBER, [filled]), 63);
  const leave = { day: 2, hasArrival: false, hasDeparture: false, rowText: '10/2 金 年休（日） 年次有給休暇 全日' };
  assert.equal(countMonthEntries(OCTOBER, [leave]), 60);
});

test('resumes progress from the month already done instead of restarting at 0%', () => {
  assert.equal(typeof plannedEntryProgress, 'function');
  // Stopped after 10/21 (14 workdays = 42 entries done); 7 workdays = 21 entries remain.
  const remaining = OCTOBER.slice(14);
  const tasks = remaining.flatMap(date => ['clockin', 'clockout', 'break'].map(phase => ({ date, phase })));
  const state = {
    phase: 'clockin',
    dates: tasks.map(t => t.date),
    taskPhases: tasks.map(t => t.phase),
    dateIndex: 0,
    monthEntries: 63,
  };
  assert.deepEqual(plannedEntryProgress(state), { current: 43, total: 63, percent: 67 });
  assert.deepEqual(plannedEntryProgress({ ...state, dateIndex: 20 }), { current: 63, total: 63, percent: 98 });
  // A fresh month counts from 1 of the same 63.
  const fresh = OCTOBER.flatMap(date => ['clockin', 'clockout', 'break'].map(phase => ({ date, phase })));
  assert.deepEqual(
    plannedEntryProgress({ ...state, dates: fresh.map(t => t.date), taskPhases: fresh.map(t => t.phase), dateIndex: 4 }),
    { current: 5, total: 63, percent: 6 }
  );
  // A run planned before this change (no monthEntries) keeps counting its own tasks.
  const { monthEntries, ...legacy } = state;
  assert.deepEqual(plannedEntryProgress(legacy), { current: 1, total: 21, percent: 0 });
});
