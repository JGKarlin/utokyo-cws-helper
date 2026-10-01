(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HRTermHours = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeRowText(rowText) {
    return String(rowText == null ? '' : rowText)
      .normalize('NFKC')
      .replace(/\s+/g, '');
  }

  function isFullDayPaidLeave(rowText) {
    const text = normalizeRowText(rowText);
    if (!text.includes('全日')) return false;
    return text.includes('年休(日)') || text.includes('年次有給休暇');
  }

  function dayFromWorkday(workday) {
    const match = String(workday == null ? '' : workday).match(/(?:^|-)(\d{1,2})$/);
    return match ? Number(match[1]) : null;
  }

  function factsByDay(rowFacts) {
    const result = new Map();
    (Array.isArray(rowFacts) ? rowFacts : []).forEach(fact => {
      if (!fact || fact.day == null) return;
      const day = Number(fact.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) return;
      const facts = result.get(day) || [];
      facts.push(fact);
      result.set(day, facts);
    });
    return result;
  }

  function planMissingEntries(workdays, rowFacts) {
    const byDay = factsByDay(rowFacts);
    const tasks = [];

    (Array.isArray(workdays) ? workdays : []).forEach(workday => {
      const date = String(workday || '');
      const day = dayFromWorkday(date);
      const facts = day === null ? [] : (byDay.get(day) || []);
      if (facts.some(fact => isFullDayPaidLeave(fact.rowText))) return;

      if (!facts.length) {
        tasks.push(
          { date, phase: 'clockin' },
          { date, phase: 'clockout' },
          { date, phase: 'break' }
        );
        return;
      }

      const hasArrival = facts.some(fact => fact.hasArrival === true);
      const hasDeparture = facts.some(fact => fact.hasDeparture === true);
      const breakObserved = facts.some(fact => typeof fact.hasBreak === 'boolean');
      const hasBreak = facts.some(fact => fact.hasBreak === true);
      if (!hasArrival) tasks.push({ date, phase: 'clockin' });
      if (!hasDeparture) tasks.push({ date, phase: 'clockout' });
      if (breakObserved && !hasBreak) tasks.push({ date, phase: 'break' });
    });

    return tasks;
  }

  function findMissingWorkdays(workdays, rowFacts) {
    return Array.from(new Set(planMissingEntries(workdays, rowFacts).map(task => task.date)));
  }

  // Every entry the month needs (出勤・退勤・休憩 per workday, full-day paid leave
  // excluded), filled or not — the fixed 100% that progress is measured against.
  function countMonthEntries(workdays, rowFacts) {
    const byDay = factsByDay(rowFacts);
    let days = 0;
    (Array.isArray(workdays) ? workdays : []).forEach(workday => {
      const day = dayFromWorkday(String(workday || ''));
      const facts = day === null ? [] : (byDay.get(day) || []);
      if (!facts.some(fact => isFullDayPaidLeave(fact.rowText))) days += 1;
    });
    return days * 3;
  }

  // Progress of a planned (missing-entries-only) run across the whole month, so a resumed
  // run continues from the entries already done instead of restarting at 0%. A plan made
  // without monthEntries counts its own tasks.
  function plannedEntryProgress(state) {
    const tasks = (state && Array.isArray(state.taskPhases)) ? state.taskPhases.length : 0;
    const total = Math.max(1, tasks, Number(state && state.monthEntries) || 0);
    const completed = (total - tasks) + Number((state && state.dateIndex) || 0);
    return { current: completed + 1, total, percent: Math.round((completed / total) * 100) };
  }

  function advancePlannedEntryState(state) {
    if (!state || !Array.isArray(state.taskPhases)) return undefined;
    const nextIndex = Number(state.dateIndex || 0) + 1;
    if (nextIndex >= state.taskPhases.length || nextIndex >= (state.dates || []).length) return null;
    return Object.assign({}, state, {
      dateIndex: nextIndex,
      phase: state.taskPhases[nextIndex],
      config: Object.assign({}, state.config || {})
    });
  }

  function completedHoursMessage(monthKey, workdayCount) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
    const label = match ? `${match[1]}年${Number(match[2])}月分` : `${String(monthKey || '')}分`;
    const numericCount = Number(workdayCount);
    const count = Number.isFinite(numericCount) ? Math.max(0, Math.floor(numericCount)) : 0;
    return `${label}：勤務時間の入力完了（${count}勤務日）。出勤・退勤・勤務外時間数を確認済み。`;
  }

  function findScheduledWorkdays(monthKey, rowFacts) {
    if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return [];
    const [year, month] = String(monthKey).split('-').map(Number);
    if (month < 1 || month > 12) return [];
    const dates = new Set();

    (Array.isArray(rowFacts) ? rowFacts : []).forEach(fact => {
      if (!fact || fact.day == null) return;
      const day = Number(fact.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) return;
      const classes = String(fact.dayClass || '').split(/\s+/).filter(Boolean);
      if (!classes.includes('mg_normal')) return;
      const calendarDate = new Date(year, month - 1, day);
      if (calendarDate.getFullYear() !== year || calendarDate.getMonth() !== month - 1 || calendarDate.getDate() !== day) return;
      const date = `${monthKey}-${String(day).padStart(2, '0')}`;
      dates.add(date);
    });

    return Array.from(dates).sort();
  }

  return {
    isFullDayPaidLeave,
    findMissingWorkdays,
    findScheduledWorkdays,
    planMissingEntries,
    advancePlannedEntryState,
    countMonthEntries,
    plannedEntryProgress,
    completedHoursMessage
  };
});
