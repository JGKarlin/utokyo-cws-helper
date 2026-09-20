const test = require('node:test');
const assert = require('node:assert/strict');

let buildMonthRows, statusEventsFromSnapshot, appendHistoryEvent, markMonthsStale, classifyBackgroundOutcome, planBackgroundRun, shouldClearBackgroundAction, cwsAutomationActive, cwsScanActive, shouldRunStatusScan, cwsAutomationStartupCleanupKeys, planCwsScanLock, backgroundAutomationTimeoutMs, chooseReusableCwsTab, monthlySubmissionAlreadyHandled, terminalEntryProgress, historyMessageBody, confirmMonths, isConfirmedMonth, confirmedMonthKeys, termScanShouldStop, termScanNeeded;
try {
  ({ buildMonthRows, statusEventsFromSnapshot, appendHistoryEvent, markMonthsStale, classifyBackgroundOutcome, planBackgroundRun, shouldClearBackgroundAction, cwsAutomationActive, cwsScanActive, shouldRunStatusScan, cwsAutomationStartupCleanupKeys, planCwsScanLock, backgroundAutomationTimeoutMs, chooseReusableCwsTab, monthlySubmissionAlreadyHandled, terminalEntryProgress, historyMessageBody, confirmMonths, isConfirmedMonth, confirmedMonthKeys, termScanShouldStop, termScanNeeded } = require('../status-model.js'));
} catch (_) {}

test('renders a stored completion message with exactly one month label', () => {
  assert.equal(typeof historyMessageBody, 'function');
  assert.equal(
    historyMessageBody('2026-08', '2026年8月分：勤務時間の入力完了（20勤務日）。出勤・退勤・勤務外時間数を確認済み。'),
    '勤務時間の入力完了（20勤務日）。出勤・退勤・勤務外時間数を確認済み。'
  );
  assert.equal(historyMessageBody('2026-08', '自動処理が完了しました。'), '自動処理が完了しました。');
});

test('skips monthly submission checks once the cached month is submitted or approved', () => {
  assert.equal(typeof monthlySubmissionAlreadyHandled, 'function');
  assert.equal(monthlySubmissionAlreadyHandled({ submitted: true, approval: 'pending' }), true);
  assert.equal(monthlySubmissionAlreadyHandled({ submitted: false, approval: 'approved' }), true);
  assert.equal(monthlySubmissionAlreadyHandled({ approval: 'final' }), true);
  assert.equal(monthlySubmissionAlreadyHandled({ approval: 'complete' }), true);
  assert.equal(monthlySubmissionAlreadyHandled({ approval: 'pending' }), true);
  assert.equal(monthlySubmissionAlreadyHandled({ approval: 'returned' }), false);
  assert.equal(monthlySubmissionAlreadyHandled(null), false);
});

test('reuses the tracked automation tab before any other CWS tab', () => {
  assert.equal(typeof chooseReusableCwsTab, 'function');
  const tabs = [
    { id: 10, url: 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws', lastAccessed: 1 },
    { id: 20, url: 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws', lastAccessed: 2 }
  ];
  assert.equal(chooseReusableCwsTab(10, tabs).id, 10);
  assert.equal(chooseReusableCwsTab(999, tabs).id, 20);
  assert.equal(chooseReusableCwsTab(30, [{ id: 30, url: 'https://example.com/' }]), null);
  assert.equal(chooseReusableCwsTab(null, []), null);
});

test('allows enough time for a complete full-month background entry run', () => {
  assert.equal(typeof backgroundAutomationTimeoutMs, 'function');
  assert.equal(backgroundAutomationTimeoutMs(), 45 * 60 * 1000);
});

test('replaces stale running progress when entry-only work times out or fails', () => {
  assert.equal(typeof terminalEntryProgress, 'function');
  assert.deepEqual(terminalEntryProgress({ timeout: true }), {
    running: false,
    error: true,
    retryable: true,
    timeout: true,
    message: '勤務時間の自動入力が時間内に完了しませんでした。次回の自動確認で再試行します。'
  });
  assert.deepEqual(terminalEntryProgress({ error: true, message: 'hidden tab closed' }), {
    running: false,
    error: true,
    retryable: true,
    message: 'hidden tab closed'
  });
  assert.equal(terminalEntryProgress({ done: true }), null);
});

test('serializes CWS status scans and automation runs', () => {
  assert.equal(cwsAutomationActive({ hrSubmitState: { phase: 'submit-nav' } }), true);
  assert.equal(cwsAutomationActive({ hrAutoState: { phase: 'clockin' } }), true);
  assert.equal(cwsAutomationActive({}), false);
  assert.equal(cwsScanActive({ hrScanActive: true }), true);
  assert.equal(cwsScanActive({ hrScanActive: false }), false);
  assert.equal(shouldRunStatusScan({ autoEntryEnabled: true, automationActive: false }), false);
  assert.equal(shouldRunStatusScan({ autoEntryEnabled: false, automationActive: true }), false);
  assert.equal(shouldRunStatusScan({ autoEntryEnabled: false, automationActive: false }), true);
  assert.deepEqual(cwsAutomationStartupCleanupKeys(), [
    'hrAutoProgress', 'hrScanNavStep', 'hrTermScan', 'hrScanActive', 'hrScanStartedAt'
  ]);
  assert.deepEqual(planCwsScanLock({ hrScanActive: true, hrScanStartedAt: 950 }, 1000, 100), { defer: true, stale: false });
  assert.deepEqual(planCwsScanLock({ hrScanActive: true, hrScanStartedAt: 800 }, 1000, 100), { defer: false, stale: true });
  assert.deepEqual(planCwsScanLock({ hrScanActive: true }, 1000, 100), { defer: false, stale: true });
});

test('keeps June visible as submitted and awaiting approval', () => {
  assert.equal(typeof buildMonthRows, 'function');
  const rows = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-05': { month: '2026-05', approval: 'approved', submittable: false },
      '2026-06': { month: '2026-06', approval: 'pending', submitted: true, submittable: false },
      '2026-07': { month: '2026-07', approval: 'none', submittable: true }
    },
    pending: { targetMonth: '2026-07', prevMonth: '2026-06' },
    autoSubmitEnabled: true
  });
  assert.equal(rows.find(r => r.month === '2026-06').state, 'submitted-pending');
  assert.equal(rows.find(r => r.month === '2026-07').state, 'waiting-approval');
});

test('only user-action-required exposes a manual action', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-08',
    months: { '2026-07': { month: '2026-07', submittable: true, approval: 'none' } },
    autoSubmitEnabled: true,
    userAction: { month: '2026-07', message: '自動申請を完了できませんでした' }
  });
  assert.equal(rows[0].state, 'user-action-required');
  assert.equal(rows[0].actionMonth, '2026-07');
});

test('deduplicates unchanged events and retains only 12 months', () => {
  const existing = [{ id: '2026-07:submitted:submitted-pending', month: '2026-07', type: 'submitted', state: 'submitted-pending', at: 1 }];
  const same = appendHistoryEvent(existing, { month: '2026-07', type: 'submitted', state: 'submitted-pending', at: 2 }, '2026-08');
  assert.equal(same.length, 1);

  const pruned = appendHistoryEvent(same, { month: '2025-07', type: 'approved', state: 'approved', at: 3 }, '2026-08');
  assert.equal(pruned.some(e => e.month === '2025-07'), false);
});

test('records a live correction without deleting earlier history', () => {
  const events = statusEventsFromSnapshot(
    { '2026-06': { month: '2026-06', approval: 'none', submittable: true } },
    { '2026-06': { month: '2026-06', approval: 'pending', submitted: true, submittable: false } },
    10
  );
  assert.deepEqual(events.map(e => [e.month, e.state]), [['2026-06', 'submitted-pending']]);
});

test('newer live approval outranks stale persisted action state', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'approved', submitted: true, submittable: false },
      '2026-07': { month: '2026-07', approval: 'approved', submitted: true, submittable: false }
    },
    pending: { targetMonth: '2026-07', prevMonth: '2026-06' },
    activeRun: { month: '2026-07', state: 'processing' },
    userAction: { month: '2026-07', message: '古い失敗' },
    autoSubmitEnabled: true
  });
  const july = rows.find(row => row.month === '2026-07');
  assert.equal(july.state, 'approved');
  assert.equal(july.actionMonth, undefined);
});

test('drops future history events outside the current 12-month window', () => {
  const retained = appendHistoryEvent(
    [{ id: '2026-08:approved:approved', month: '2026-08', type: 'approved', state: 'approved', at: 1 }],
    { month: '2026-09', type: 'submitted', state: 'submitted-pending', at: 2 },
    '2026-08'
  );
  assert.equal(retained.some(event => event.month === '2026-09'), false);
  assert.equal(retained.some(event => event.month === '2026-08'), true);
});

test('provides explicit Japanese copy for submitted June and waiting July', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'pending', submitted: true, submittable: false },
      '2026-07': { month: '2026-07', approval: 'none', submittable: true }
    },
    pending: { targetMonth: '2026-07', prevMonth: '2026-06' },
    autoSubmitEnabled: true
  });

  assert.equal(rows.find(row => row.month === '2026-06').message, '2026年6月分：提出済み（承認待ち）');
  assert.match(rows.find(row => row.month === '2026-07').message, /2026年6月分の承認待ち/);
});

test('uses a fresh CWS-ready month instead of stale persisted action state', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'approved', submitted: true, submittable: false, fresh: true },
      '2026-07': { month: '2026-07', approval: 'none', submittable: true, fresh: true }
    },
    pending: { targetMonth: '2026-07', prevMonth: '2026-06' },
    userAction: { month: '2026-07', message: '古い失敗' },
    autoSubmitEnabled: true
  });

  const july = rows.find(row => row.month === '2026-07');
  assert.equal(july.state, 'ready-auto');
  assert.equal(july.message, '2026年7月分（前月・進行中）：自動申請の準備ができました。');
});

test('treats the actual pending CWS scan shape as submitted and awaiting approval', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'pending', submittable: false, fresh: true }
    },
    autoSubmitEnabled: true
  });

  const june = rows.find(row => row.month === '2026-06');
  assert.equal(june.state, 'submitted-pending');
  assert.equal(june.message, '2026年6月分：提出済み（承認待ち）');
});

test('holds a fresh July until its fresh June dependency is finally approved', () => {
  const waiting = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'pending', submittable: false, fresh: true },
      '2026-07': { month: '2026-07', approval: 'none', submittable: true, fresh: true }
    },
    pending: { targetMonth: '2026-07', prevMonth: '2026-06' },
    autoSubmitEnabled: true
  });
  assert.equal(waiting.find(row => row.month === '2026-06').state, 'submitted-pending');
  assert.equal(waiting.find(row => row.month === '2026-07').state, 'waiting-approval');

  const ready = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'approved', submittable: false, fresh: true },
      '2026-07': { month: '2026-07', approval: 'none', submittable: true, fresh: true }
    },
    pending: { targetMonth: '2026-07', prevMonth: '2026-06' },
    autoSubmitEnabled: true
  });
  assert.equal(ready.find(row => row.month === '2026-07').state, 'ready-auto');
});

test('derives the July approval gate from fresh June without persisted pending state', () => {
  const waiting = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'pending', submittable: false, fresh: true },
      '2026-07': { month: '2026-07', approval: 'none', submittable: true, fresh: true }
    },
    autoSubmitEnabled: true
  });
  assert.equal(waiting.find(row => row.month === '2026-07').state, 'waiting-approval');

  const ready = buildMonthRows({
    currentMonth: '2026-08',
    months: {
      '2026-06': { month: '2026-06', approval: 'approved', submittable: false, fresh: true },
      '2026-07': { month: '2026-07', approval: 'none', submittable: true, fresh: true }
    },
    autoSubmitEnabled: true
  });
  assert.equal(ready.find(row => row.month === '2026-07').state, 'ready-auto');
});

test('marks failed-scan rows stale before persisted action state is resolved', () => {
  assert.equal(typeof markMonthsStale, 'function');
  const rows = buildMonthRows({
    currentMonth: '2026-08',
    months: markMonthsStale({
      '2026-07': { month: '2026-07', approval: 'none', submittable: true, fresh: true }
    }),
    userAction: { month: '2026-07', message: '確認が必要です。' },
    autoSubmitEnabled: true
  });

  const july = rows.find(row => row.month === '2026-07');
  assert.equal(july.stale, true);
  assert.equal(july.fresh, false);
  assert.equal(july.state, 'user-action-required');
});

test('requires user action for an error but not an approval wait', () => {
  assert.equal(typeof classifyBackgroundOutcome, 'function');
  assert.deepEqual(
    classifyBackgroundOutcome('2026-07', { error: true, message: '確認してください' }),
    { completed: false, userAction: { month: '2026-07', message: '確認してください' } }
  );
  assert.deepEqual(
    classifyBackgroundOutcome('2026-07', { done: true, waitingApproval: true }),
    { completed: true, userAction: null }
  );
});

test('keeps an active persisted background run owned by its original worker', () => {
  assert.equal(typeof planBackgroundRun, 'function');
  assert.deepEqual(
    planBackgroundRun({ month: '2026-07', state: 'processing', startedAt: 5000 }, 6000, 180000),
    { start: false, ownsRun: false, staleMonth: null }
  );
});

test('treats an operational failure as retryable without a manual action', () => {
  assert.deepEqual(
    classifyBackgroundOutcome('2026-07', {
      error: true,
      retryable: true,
      message: '本人用実績入力ページへ移動できませんでした。'
    }),
    { completed: false, retryable: true, userAction: null }
  );
});

test('classifies worker infrastructure exceptions as retryable', () => {
  assert.deepEqual(
    classifyBackgroundOutcome('2026-07', { error: true, infrastructure: true, message: 'hidden tab closed' }),
    { completed: false, retryable: true, userAction: null }
  );
});

test('clears only the matching stale action after a retryable outcome', () => {
  assert.equal(typeof shouldClearBackgroundAction, 'function');
  const retryable = { completed: false, retryable: true, userAction: null };
  assert.equal(shouldClearBackgroundAction({ month: '2026-07' }, '2026-07', retryable), true);
  assert.equal(shouldClearBackgroundAction({ month: '2026-06' }, '2026-07', retryable), false);
});

// ── Confirmed-month ledger ────────────────────────────────────────────────────
// 最終承認 is terminal at CWS: a month can never leave it. Once observed, the
// month is recorded as confirmed and is never scanned or re-derived again.

test('stamps a finally approved month as confirmed exactly once', () => {
  assert.equal(typeof confirmMonths, 'function');
  const first = confirmMonths({
    '2026-07': { month: '2026-07', approval: 'approved', submittable: false },
    '2026-08': { month: '2026-08', approval: 'pending', submitted: true, submittable: false },
    '2026-09': { month: '2026-09', approval: 'none', submittable: true }
  }, 1000);

  assert.equal(first['2026-07'].confirmed, true);
  assert.equal(first['2026-07'].confirmedAt, 1000);
  assert.equal(first['2026-08'].confirmed, undefined);
  assert.equal(first['2026-09'].confirmed, undefined);

  const second = confirmMonths(first, 2000);
  assert.equal(second['2026-07'].confirmedAt, 1000, 'keeps the original confirmation time');
});

test('confirms an approved month even after the cache marked it stale', () => {
  const confirmed = confirmMonths(markMonthsStale({
    '2026-05': { month: '2026-05', approval: 'approved', submittable: false, fresh: true }
  }), 1000);
  assert.equal(confirmed['2026-05'].confirmed, true);
});

test('never confirms a month without approval evidence', () => {
  const confirmed = confirmMonths({
    '2026-07': { month: '2026-07', submittable: false },
    '2026-08': { month: '2026-08', approval: 'returned', submittable: true }
  }, 1000);
  assert.equal(confirmed['2026-07'].confirmed, undefined);
  assert.equal(confirmed['2026-08'].confirmed, undefined);
});

test('a confirmed month is settled, never stale', () => {
  assert.equal(typeof isConfirmedMonth, 'function');
  const stale = markMonthsStale(confirmMonths({
    '2026-07': { month: '2026-07', approval: 'approved', submittable: false },
    '2026-08': { month: '2026-08', approval: 'none', submittable: true }
  }, 1000));

  assert.equal(stale['2026-07'].stale, undefined);
  assert.equal(stale['2026-07'].fresh, undefined);
  assert.equal(isConfirmedMonth(stale['2026-07']), true);
  assert.equal(stale['2026-08'].stale, true, 'unconfirmed months still go stale');
});

test('a confirmed month outranks pending, processing and action state', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-09',
    months: confirmMonths({
      '2026-07': { month: '2026-07', approval: 'approved', submittable: false }
    }, 1000),
    pending: { targetMonth: '2026-07', prevMonth: '2026-06' },
    activeRun: { month: '2026-07', state: 'processing' },
    userAction: { month: '2026-07', message: '古い失敗' },
    autoSubmitEnabled: true
  });
  const july = rows[0];
  assert.equal(july.state, 'approved');
  assert.equal(july.confirmed, true);
  assert.equal(july.actionMonth, undefined);
});

test('lists the confirmed months a scan may skip', () => {
  assert.equal(typeof confirmedMonthKeys, 'function');
  const months = confirmMonths({
    '2026-05': { month: '2026-05', approval: 'approved' },
    '2026-07': { month: '2026-07', approval: 'approved' },
    '2026-08': { month: '2026-08', approval: 'pending', submitted: true }
  }, 1000);
  assert.deepEqual(confirmedMonthKeys(months), ['2026-05', '2026-07']);
  assert.deepEqual(confirmedMonthKeys(null), []);
});

// ── Backward scan walk ───────────────────────────────────────────────────────

test('stops the backward walk before stepping into a confirmed month', () => {
  assert.equal(typeof termScanShouldStop, 'function');
  const options = { current: '2026-09', maxSteps: 12, confirmedMonths: ['2026-08', '2026-07', '2026-06'] };

  const atCurrent = termScanShouldStop(Object.assign({ month: '2026-09', submittable: true, steps: 1 }, options));
  assert.equal(atCurrent.stop, true);
  assert.equal(atCurrent.reason, 'confirmed-previous');
});

test('stops immediately when the walk lands on a confirmed month', () => {
  const landed = termScanShouldStop({
    month: '2026-08', current: '2026-09', submittable: false, steps: 1,
    maxSteps: 12, confirmedMonths: ['2026-08']
  });
  assert.equal(landed.stop, true);
  assert.equal(landed.reason, 'confirmed');
});

test('keeps walking while unconfirmed months remain', () => {
  const keepGoing = termScanShouldStop({
    month: '2026-09', current: '2026-09', submittable: true, steps: 1,
    maxSteps: 12, confirmedMonths: []
  });
  assert.equal(keepGoing.stop, false);
});

test('retains the closed-window and lookback limits', () => {
  const closed = termScanShouldStop({
    month: '2026-08', current: '2026-09', submittable: false, steps: 1,
    maxSteps: 12, confirmedMonths: []
  });
  assert.equal(closed.stop, true);
  assert.equal(closed.reason, 'closed');

  const exhausted = termScanShouldStop({
    month: '2026-09', current: '2026-09', submittable: true, steps: 12,
    maxSteps: 12, confirmedMonths: []
  });
  assert.equal(exhausted.stop, true);
  assert.equal(exhausted.reason, 'max-steps');
});

test('skips the scan entirely once the current month itself is confirmed', () => {
  assert.equal(typeof termScanNeeded, 'function');
  const months = confirmMonths({ '2026-09': { month: '2026-09', approval: 'approved' } }, 1000);
  assert.equal(termScanNeeded({ currentMonth: '2026-09', months }), false);
  assert.equal(termScanNeeded({ currentMonth: '2026-09', months: {} }), true);
});

// ── Relative-position labels ─────────────────────────────────────────────────

test('tags the current month and the previous month by position', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-09',
    months: confirmMonths({
      '2026-07': { month: '2026-07', approval: 'approved', submittable: false },
      '2026-08': { month: '2026-08', approval: 'approved', submittable: false },
      '2026-09': { month: '2026-09', approval: 'none', submittable: true, fresh: true }
    }, 1000),
    autoSubmitEnabled: true
  });

  assert.equal(rows.find(row => row.month === '2026-09').message,
    '2026年9月分（今月・進行中）：自動申請の準備ができました。');
  assert.equal(rows.find(row => row.month === '2026-08').message,
    '2026年8月分（前月）：最終承認済み');
  assert.equal(rows.find(row => row.month === '2026-07').message,
    '2026年7月分：最終承認済み', 'older months carry no position tag');
});

test('tags an unapproved previous month as awaiting approval', () => {
  const rows = buildMonthRows({
    currentMonth: '2026-09',
    months: {
      '2026-08': { month: '2026-08', approval: 'pending', submitted: true, submittable: false, fresh: true }
    },
    autoSubmitEnabled: true
  });
  assert.equal(rows[0].message, '2026年8月分（前月・承認待ち）：提出済み（承認待ち）');
});

test('strips a tagged month label from a stored history message', () => {
  assert.equal(
    historyMessageBody('2026-09', '2026年9月分（今月・進行中）：自動申請の準備ができました。'),
    '自動申請の準備ができました。'
  );
});
