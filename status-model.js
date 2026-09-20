(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HRStatusModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

  function monthIndex(month) {
    const match = MONTH_PATTERN.exec(String(month || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const number = Number(match[2]);
    if (number < 1 || number > 12) return null;
    return year * 12 + number - 1;
  }

  function monthFromIndex(index) {
    const year = Math.floor(index / 12);
    const month = index % 12 + 1;
    return year + '-' + String(month).padStart(2, '0');
  }

  function monthMinus(month, amount) {
    const index = monthIndex(month);
    return index === null ? null : monthFromIndex(index - amount);
  }

  function monthEntries(months) {
    if (Array.isArray(months)) {
      return months.filter(entry => entry && entry.month).map(entry => [entry.month, entry]);
    }
    if (!months || typeof months !== 'object') return [];
    return Object.keys(months)
      .filter(month => months[month] && (months[month].month || month))
      .map(month => [month, Object.assign({ month }, months[month])]);
  }

  function isApprovedApproval(approval) {
    const value = String(approval || '').toLowerCase();
    return value === 'approved' || value === 'final' || value === 'complete';
  }

  // 最終承認 is terminal at CWS — a month can never leave it. Once a month has been
  // observed approved it is recorded as confirmed and is never scanned or re-derived
  // again, which is what keeps the backward walk out of settled months.
  function isConfirmedMonth(entry) {
    return !!(entry && entry.confirmed === true);
  }

  function confirmMonths(months, now) {
    const at = Number(now) || Date.now();
    // Approval is only ever written from a live 【処理状況】 reading, so an entry that
    // carries it is real evidence no matter how old the surrounding cache row is.
    const stamp = entry => {
      if (!entry || isConfirmedMonth(entry) || !isApprovedApproval(entry.approval)) return entry;
      return Object.assign({}, entry, { confirmed: true, confirmedAt: at });
    };
    if (Array.isArray(months)) return months.map(stamp);
    if (!months || typeof months !== 'object') return {};
    return Object.keys(months).reduce((result, month) => {
      result[month] = stamp(months[month]);
      return result;
    }, {});
  }

  function confirmedMonthKeys(months) {
    return monthEntries(months)
      .filter(pair => isConfirmedMonth(pair[1]))
      .map(pair => pair[0])
      .sort();
  }

  function stateFromLiveEntry(entry, autoSubmitEnabled) {
    const value = entry || {};
    if (isConfirmedMonth(value)) return 'approved';
    const approval = String(value.approval || '').toLowerCase();
    if (isApprovedApproval(approval)) return 'approved';
    if (approval === 'returned' || approval === 'rejected') return 'returned';
    if (value.submitted === true && (approval === 'pending' || approval === 'none' || !approval)) {
      return 'submitted-pending';
    }
    if (approval === 'pending') return 'submitted-pending';
    if (value.submittable === true) return autoSubmitEnabled === false ? 'ready' : 'ready-auto';
    return 'not-eligible';
  }

  function stateFromEntry(entry, autoSubmitEnabled) {
    return stateFromLiveEntry(entry, autoSubmitEnabled);
  }

  function hasAuthoritativeLiveStatus(entry) {
    const value = entry || {};
    if (isConfirmedMonth(value)) return true;
    if (value.stale === true || value.staleFallback === true || value.fresh === false || value.source === 'stale') return false;
    if (value.fresh === true || value.source === 'live') return true;
    const approval = String(value.approval || '').toLowerCase();
    return value.submitted === true || (approval !== '' && approval !== 'none');
  }

  function isSubmittedOrFinalState(state) {
    return state === 'submitted-pending' || state === 'approved' || state === 'returned';
  }

  function monthlySubmissionAlreadyHandled(entry) {
    const value = entry || {};
    if (value.submitted === true) return true;
    const approval = String(value.approval || '').toLowerCase();
    return approval === 'pending' || approval === 'approved' || approval === 'final' || approval === 'complete';
  }

  function historyMessageBody(month, message) {
    const text = String(message || '');
    const match = MONTH_PATTERN.exec(String(month || ''));
    if (!match) return text;
    const label = `${match[1]}年${Number(match[2])}月分`;
    if (text.startsWith(label + '：')) return text.slice(label.length + 1);
    if (text.startsWith(label + '（')) {
      const close = text.indexOf('）：', label.length);
      if (close !== -1) return text.slice(close + 2);
    }
    return text;
  }

  function markMonthsStale(months) {
    // A confirmed month is settled, not stale: a failed scan says nothing new about
    // a period that has already been finally approved.
    if (Array.isArray(months)) {
      return months.filter(entry => entry && entry.month).map(entry => isConfirmedMonth(entry) ? entry : Object.assign({}, entry, {
        stale: true,
        staleFallback: true,
        fresh: false,
        source: 'stale'
      }));
    }
    if (!months || typeof months !== 'object') return {};
    return Object.keys(months).reduce((result, month) => {
      const entry = months[month];
      if (isConfirmedMonth(entry)) {
        result[month] = Object.assign({}, entry, { month: entry.month || month });
      } else if (entry) {
        result[month] = Object.assign({}, entry, {
          month: entry.month || month,
          stale: true,
          staleFallback: true,
          fresh: false,
          source: 'stale'
        });
      }
      return result;
    }, {});
  }

  function formatMonthLabel(month) {
    const match = MONTH_PATTERN.exec(String(month || ''));
    return match ? match[1] + '年' + Number(match[2]) + '月' : String(month || '');
  }

  // Where the month sits relative to today. Only 今月 and 前月 carry a tag; anything
  // older reads as its own month name without one.
  function monthPositionLabel(month, currentMonth) {
    if (!currentMonth) return '';
    if (month === currentMonth) return '今月';
    if (month === monthMinus(currentMonth, 1)) return '前月';
    return '';
  }

  function stateQualifier(state) {
    switch (state) {
      case 'submitted-pending':
      case 'waiting-approval': return '承認待ち';
      case 'returned': return '差戻し';
      case 'processing': return '処理中';
      case 'ready-auto':
      case 'ready': return '進行中';
      case 'user-action-required': return '要確認';
      default: return '';
    }
  }

  function monthTag(month, state, currentMonth) {
    const position = monthPositionLabel(month, currentMonth);
    if (!position) return '';
    const qualifier = stateQualifier(state);
    return '（' + (qualifier ? position + '・' + qualifier : position) + '）';
  }

  function messageForState(month, state, pending, userAction, currentMonth) {
    const label = formatMonthLabel(month) + '分' + monthTag(month, state, currentMonth);
    const previous = pending && pending.targetMonth === month && pending.prevMonth
      ? formatMonthLabel(pending.prevMonth) + '分' : '';
    switch (state) {
      case 'submitted-pending': return label + '：提出済み（承認待ち）';
      case 'approved': return label + '：最終承認済み';
      case 'returned': return label + '：差戻しです。自動処理を確認中です。';
      case 'waiting-approval': return previous
        ? label + '：' + previous + 'の承認待ち。承認後に自動申請します。'
        : label + '：前月の承認待ち。承認後に自動申請します。';
      case 'processing': return label + '：自動申請を処理中です。';
      case 'ready-auto': return label + '：自動申請の準備ができました。';
      case 'ready': return label + '：申請の準備ができました。';
      case 'user-action-required': return label + '：' + ((userAction && userAction.message) || '確認が必要です。');
      default: return label + '：申請対象外です。';
    }
  }

  function referenceMonths(input) {
    const references = [];
    if (input && input.pending) {
      if (input.pending.targetMonth) references.push(input.pending.targetMonth);
      if (input.pending.prevMonth) references.push(input.pending.prevMonth);
    }
    if (input && input.activeRun && input.activeRun.month) references.push(input.activeRun.month);
    if (input && input.userAction && input.userAction.month) references.push(input.userAction.month);
    return references;
  }

  function isBlockedByPreviousApproval(pending, entries, month, state) {
    const explicitPending = pending.targetMonth === month && pending.prevMonth && pending.prevMonth !== month;
    const readyForAutomaticSubmission = state === 'ready-auto' || state === 'ready';
    if (!explicitPending && !readyForAutomaticSubmission) return false;
    const previousMonth = explicitPending ? pending.prevMonth : monthMinus(month, 1);
    const previous = entries.get(previousMonth);
    if (!previous) return explicitPending;
    if (!explicitPending && !hasAuthoritativeLiveStatus(previous)) return false;
    const approval = String(previous && previous.approval || '').toLowerCase();
    return approval !== 'approved' && approval !== 'final' && approval !== 'complete';
  }

  function buildMonthRows(input) {
    const options = input || {};
    const autoSubmitEnabled = options.autoSubmitEnabled !== false;
    const entries = new Map(monthEntries(options.months));
    const currentIndex = monthIndex(options.currentMonth);
    const oldestIndex = currentIndex === null ? null : currentIndex - 11;
    if (oldestIndex !== null) {
      Array.from(entries.keys()).forEach(month => {
        const index = monthIndex(month);
        if (index !== null && (index < oldestIndex || index > currentIndex)) entries.delete(month);
      });
    }
    referenceMonths(options).forEach(month => {
      const index = monthIndex(month);
      if (index === null || oldestIndex === null || (index >= oldestIndex && index <= currentIndex)) {
        if (!entries.has(month)) entries.set(month, { month });
      }
    });

    const pending = options.pending || {};
    const activeRun = options.activeRun || {};
    const userAction = options.userAction || {};
    const rows = Array.from(entries.values()).map(entry => {
      const month = entry.month;
      let state = stateFromEntry(entry, autoSubmitEnabled);
      const persistedMayOverride = !hasAuthoritativeLiveStatus(entry);

      if (persistedMayOverride && userAction.month === month) {
        state = 'user-action-required';
      } else if (persistedMayOverride && activeRun.month === month && activeRun.state !== 'completed' && activeRun.state !== 'failed') {
        state = 'processing';
      } else if (isBlockedByPreviousApproval(pending, entries, month, state) && !isSubmittedOrFinalState(state)) {
        state = 'waiting-approval';
      }

      const row = Object.assign({}, entry, {
        month,
        state,
        message: messageForState(month, state, pending, userAction, options.currentMonth)
      });
      if (state === 'user-action-required') {
        row.actionMonth = month;
        row.actionMessage = userAction.message || '';
      }
      return row;
    });

    return rows.sort((left, right) => {
      const leftIndex = monthIndex(left.month);
      const rightIndex = monthIndex(right.month);
      if (leftIndex === null && rightIndex === null) return String(right.month).localeCompare(String(left.month));
      if (leftIndex === null) return 1;
      if (rightIndex === null) return -1;
      return rightIndex - leftIndex;
    });
  }

  function eventTypeForState(state) {
    switch (state) {
      case 'submitted-pending': return 'submitted';
      case 'approved': return 'approved';
      case 'returned': return 'returned';
      case 'waiting-approval': return 'waiting-approval';
      case 'processing': return 'processing';
      case 'ready-auto':
      case 'ready': return 'ready';
      case 'user-action-required': return 'action-required';
      case 'failed': return 'failed';
      default: return 'state-changed';
    }
  }

  function statusEventsFromSnapshot(previous, next, observedAt) {
    const before = new Map(monthEntries(previous));
    const after = new Map(monthEntries(next));
    const months = new Set(Array.from(before.keys()).concat(Array.from(after.keys())));
    return Array.from(months).sort().reduce((events, month) => {
      const previousState = before.has(month) ? stateFromEntry(before.get(month), true) : null;
      const nextEntry = after.get(month);
      if (!nextEntry) return events;
      const nextState = stateFromEntry(nextEntry, true);
      if (previousState !== nextState) {
        events.push({
          id: month + ':' + eventTypeForState(nextState) + ':' + nextState,
          month,
          type: eventTypeForState(nextState),
          state: nextState,
          at: observedAt
        });
      }
      return events;
    }, []);
  }

  function appendHistoryEvent(history, event, currentMonth) {
    const source = Array.isArray(history) ? history : [];
    const candidate = Object.assign({}, event || {});
    if (!candidate.month || !candidate.type || !candidate.state) return source.slice();
    candidate.id = candidate.month + ':' + candidate.type + ':' + candidate.state;
    const result = source.map(item => {
      if (!item || typeof item !== 'object') return item;
      if (item.month && item.type && item.state) {
        return Object.assign({}, item, { id: item.month + ':' + item.type + ':' + item.state });
      }
      return item;
    });
    if (!result.some(item => item && item.id === candidate.id)) result.push(candidate);

    const oldest = monthMinus(currentMonth, 11);
    if (oldest === null) return result;
    const oldestIndex = monthIndex(oldest);
    return result.filter(item => {
      const itemIndex = monthIndex(item && item.month);
      return itemIndex !== null && itemIndex >= oldestIndex && itemIndex <= monthIndex(currentMonth);
    });
  }

  function classifyBackgroundOutcome(month, progress) {
    const value = progress || {};
    if (value.retryable || value.infrastructure) return { completed: false, retryable: true, userAction: null };
    if (value.error || value.timeout) {
      return {
        completed: false,
        userAction: {
          month,
          message: value.message || (value.timeout ? '自動申請が時間内に完了しませんでした。' : '自動申請を完了できませんでした。')
        }
      };
    }
    if (value.waitingApproval || value.done) return { completed: true, userAction: null };
    return { completed: false, userAction: null };
  }

  function planBackgroundRun(existingRun, now, timeoutMs) {
    const startedAt = Number(existingRun && existingRun.startedAt || 0);
    const active = !!(existingRun && existingRun.month && startedAt > 0 && now - startedAt < timeoutMs);
    return {
      start: !active,
      ownsRun: !active,
      staleMonth: active || !existingRun || !existingRun.month ? null : existingRun.month
    };
  }

  function shouldClearBackgroundAction(action, month, outcome) {
    return !!(action && action.month === month && outcome && (outcome.completed || outcome.retryable));
  }

  function cwsAutomationActive(sessionState) {
    const state = sessionState || {};
    return !!(state.hrSubmitState || state.hrAutoState);
  }

  function cwsScanActive(sessionState) {
    return !!(sessionState && sessionState.hrScanActive);
  }

  function shouldRunStatusScan(options) {
    const value = options || {};
    return !value.autoEntryEnabled && !value.automationActive;
  }

  function cwsAutomationStartupCleanupKeys() {
    return ['hrAutoProgress', 'hrScanNavStep', 'hrTermScan', 'hrScanActive', 'hrScanStartedAt'];
  }

  function planCwsScanLock(sessionState, now, maxAgeMs) {
    const state = sessionState || {};
    if (!state.hrScanActive) return { defer: false, stale: false };
    const startedAt = Number(state.hrScanStartedAt || 0);
    const fresh = startedAt > 0 && Number(now) - startedAt >= 0 && Number(now) - startedAt < Number(maxAgeMs);
    return { defer: fresh, stale: !fresh };
  }

  // One stop decision for the backward 勤務表 walk. Beyond the original rules — a past
  // month whose submission window has closed, and the lookback ceiling — the walk now
  // refuses to descend into a month already confirmed 最終承認済み.
  function termScanShouldStop(options) {
    const value = options || {};
    const confirmed = new Set(Array.isArray(value.confirmedMonths) ? value.confirmedMonths : []);
    if (confirmed.has(value.month)) return { stop: true, reason: 'confirmed' };

    const currentIndex = monthIndex(value.current);
    const thisIndex = monthIndex(value.month);
    if (currentIndex !== null && thisIndex !== null && thisIndex < currentIndex && value.submittable !== true) {
      return { stop: true, reason: 'closed' };
    }

    const maxSteps = Number(value.maxSteps) || 12;
    if ((Number(value.steps) || 0) >= maxSteps) return { stop: true, reason: 'max-steps' };

    const previousMonth = monthMinus(value.month, 1);
    if (previousMonth && confirmed.has(previousMonth)) return { stop: true, reason: 'confirmed-previous' };
    return { stop: false, reason: '' };
  }

  // The one case where visiting CWS cannot tell us anything new: the current month is
  // itself finally approved, so every older month is settled by definition.
  function termScanNeeded(options) {
    const value = options || {};
    const entries = new Map(monthEntries(value.months));
    return !isConfirmedMonth(entries.get(value.currentMonth));
  }

  function backgroundAutomationTimeoutMs() {
    // A full month is roughly 20 workdays × three separate CWS submissions.
    // The live site can take more than twenty minutes for the full sequence plus
    // the final return to 勤務表. Keep the watchdog below CWS's 60-minute session
    // limit while leaving enough time for the extension-owned completion check.
    return 45 * 60 * 1000;
  }

  function terminalEntryProgress(progress) {
    const value = progress || {};
    if (value.timeout) {
      return {
        running: false,
        error: true,
        retryable: true,
        timeout: true,
        message: '勤務時間の自動入力が時間内に完了しませんでした。次回の自動確認で再試行します。'
      };
    }
    if (value.error) {
      return {
        running: false,
        error: true,
        retryable: true,
        message: value.message || '勤務時間の自動入力中にエラーが発生しました。次回の自動確認で再試行します。'
      };
    }
    return null;
  }

  function chooseReusableCwsTab(trackedTabId, tabs) {
    const cwsTabs = (Array.isArray(tabs) ? tabs : []).filter(tab =>
      tab && Number.isInteger(tab.id) &&
      String(tab.url || '').startsWith('https://ut-ppsweb.adm.u-tokyo.ac.jp/')
    );
    const tracked = cwsTabs.find(tab => tab.id === trackedTabId);
    if (tracked) return tracked;
    return cwsTabs.slice().sort((left, right) =>
      Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0)
    )[0] || null;
  }

  return {
    buildMonthRows,
    statusEventsFromSnapshot,
    appendHistoryEvent,
    markMonthsStale,
    classifyBackgroundOutcome,
    planBackgroundRun,
    shouldClearBackgroundAction,
    cwsAutomationActive,
    cwsScanActive,
    shouldRunStatusScan,
    cwsAutomationStartupCleanupKeys,
    planCwsScanLock,
    backgroundAutomationTimeoutMs,
    chooseReusableCwsTab,
    monthlySubmissionAlreadyHandled,
    terminalEntryProgress,
    historyMessageBody,
    isConfirmedMonth,
    confirmMonths,
    confirmedMonthKeys,
    termScanShouldStop,
    termScanNeeded
  };
});
