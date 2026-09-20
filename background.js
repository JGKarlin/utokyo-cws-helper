'use strict';

// Share the pure status/history rules with the service worker. This is a classic
// MV3 worker, so importScripts keeps the module dependency-free and restart-safe.
try { importScripts('status-model.js'); } catch (_) {}

// Allow content scripts to access chrome.storage.session.
// Without this, only extension pages (popup, service worker) can use it,
// so the content script's persist/resume flow for multi-month automation
// silently fails.
chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
});

// Clicking the toolbar icon opens the UI in the side panel, which stays docked and
// keeps showing live progress while the automation navigates the page between steps
// (a normal toolbar popup would close the moment the tab navigates).
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (_) {}

const MAIN_CWS_URL = 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws';
const RETRY_ALARM = 'hrTermRetry';
const AUTOMATION_TAB_KEY = 'hrAutomationTabId';
const RETRY_TIMEOUT_MS = globalThis.HRStatusModel &&
  typeof globalThis.HRStatusModel.backgroundAutomationTimeoutMs === 'function'
  ? globalThis.HRStatusModel.backgroundAutomationTimeoutMs()
  : 45 * 60 * 1000;
const TERM_HISTORY_KEY = 'hrTermStatusHistory';
const BACKGROUND_RUN_KEY = 'hrBackgroundRun';
const USER_ACTION_KEY = 'hrUserActionRequired';
const NOTIFIED_BLOCKERS_KEY = 'hrNotifiedBlockers';

function formatMonthLabel(monthKey) {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-');
  return `${y}年${parseInt(m, 10)}月`;
}

function showNotification(title, message) {
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: title || '勤務時間 自動入力',
      message: message || '',
      priority: 1,
    });
  } catch (_) {}
}

// Is the UTokyo network reachable (on campus or via VPN)? The CWS host only answers
// from inside the UTokyo network, so a resolved fetch means "connected". redirect:'manual'
// lets a Shibboleth login redirect still count as reachable. Host permission lets the
// service worker fetch it without CORS.
async function isConnected(timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(MAIN_CWS_URL, {
      method: 'GET', cache: 'no-store', redirect: 'manual', signal: controller.signal,
    });
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_TERM_CONFIG = {
  arriveRange: { earlyH: 8, earlyM: 45, lateH: 10, lateM: 0 },
  departRange: { earlyH: 17, earlyM: 0, lateH: 19, lateM: 0 },
};

// The time range the automatic submission fills hours with — the user's saved 出退勤設定
// (hrTermTimeConfig, set from the side panel) if present, otherwise the built-in defaults.
async function getTermConfig() {
  try {
    const cfg = (await chrome.storage.local.get('hrTermTimeConfig')).hrTermTimeConfig;
    if (cfg && cfg.arriveRange && cfg.departRange) {
      return { arriveRange: cfg.arriveRange, departRange: cfg.departRange };
    }
  } catch (_) {}
  return DEFAULT_TERM_CONFIG;
}

function prevMonthKey() {
  const d = new Date();
  let y = d.getFullYear();
  let m = d.getMonth(); // 0-based current month === previous month in 1-based terms
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function thisCalMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthKeyMinus(monthKey, n) {
  let [y, m] = monthKey.split('-').map(Number);
  m -= n;
  while (m <= 0) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ── "Ready for manual submission" badge + one-time notification ──────────────────
// So a manual user (side panel closed, 毎月自動で申請する off) still knows a month is
// ready: the toolbar icon shows a badge with the count, and the first time a month
// becomes ready a single desktop notification fires. A month is "ready" only when a
// manual click would actually go through — its 月次申請 window is open, it is a past
// month not yet submitted, it is not the blocked/pending one, and its previous month
// is 最終承認 (so it is not waiting on the approval gate). Fed by the side panel scan,
// by the content script while on the 勤務表, and by the background submit flow — all
// read-only; no hidden tab is opened just for the badge when auto-submit is off.
const BADGE_COLOR = '#d9480f';

async function updateBadge(count) {
  try {
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count > 0) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } catch (_) {}
}

// ── Activity spinner (toolbar indicator while a hidden background run is active) ──
// A background run opens an invisible tab, so animate the toolbar badge to show it's
// working. The service worker is kept alive by the run's open tab + pending awaits, so
// the interval ticks for the run's duration. stopActivitySpinner restores the normal
// (ready-months) badge.
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const SPINNER_COLOR = '#1a3a6b';
let spinnerTimer = null;

function startActivitySpinner() {
  if (spinnerTimer) return;
  let i = 0;
  const tick = () => {
    try {
      chrome.action.setBadgeBackgroundColor({ color: SPINNER_COLOR });
      chrome.action.setBadgeText({ text: SPINNER_FRAMES[i % SPINNER_FRAMES.length] });
    } catch (_) {}
    i++;
  };
  tick();
  spinnerTimer = setInterval(tick, 250);
  try { chrome.action.setTitle({ title: '勤務時間 自動入力：実行中…' }); } catch (_) {}
}

async function stopActivitySpinner() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  try { chrome.action.setTitle({ title: '勤務時間 自動入力' }); } catch (_) {}
  await recomputeTermReady(); // restore the normal badge (ready-months count or clear)
}

function computeReadyMonths(cache, pendingMonth) {
  const months = (cache && cache.months) || {};
  const current = (cache && cache.currentMonth) || thisCalMonthKey();
  const ready = [];
  for (const m of Object.values(months)) {
    if (!m || !m.month) continue;
    if (!m.submittable) continue;
    if (!(m.month < current)) continue;
    if (!(m.approval === 'none' || m.approval === 'returned' || !m.approval)) continue;
    if (pendingMonth && pendingMonth === m.month) continue;
    const prev = months[monthKeyMinus(m.month, 1)];
    if (!prev || prev.approval !== 'approved') continue; // still blocked → not manually submittable
    ready.push(m.month);
  }
  return ready.sort();
}

async function recomputeTermReady() {
  let s;
  try {
    s = await chrome.storage.local.get(['hrTermStatusCache', 'hrPendingSubmit', 'hrNotifiedReady', 'hrAutoSubmitEnabled']);
  } catch (_) { return; }
  const pendingMonth = s.hrPendingSubmit && s.hrPendingSubmit.targetMonth;
  const ready = computeReadyMonths(s.hrTermStatusCache, pendingMonth);

  // Notify only the first time each month becomes ready (hrNotifiedReady tracks months
  // we've already pinged, pruned to those still ready). Suppress when auto-submit is on —
  // the background submits silently and sends its own "完了" notification, so a separate
  // "可能です" ping would be redundant; a since-disabled toggle still gets notified later.
  let notified = (Array.isArray(s.hrNotifiedReady) ? s.hrNotifiedReady : []).filter(mo => ready.includes(mo));
  if (!s.hrAutoSubmitEnabled) {
    for (const mo of ready) {
      if (notified.includes(mo)) continue;
      showNotification('月次申請が可能です', `${formatMonthLabel(mo)}分の月次申請ができます。ツールバーの拡張機能アイコンを開いて申請してください。`);
      notified.push(mo);
    }
  }
  try { await chrome.storage.local.set({ hrReadyMonths: ready, hrNotifiedReady: notified }); } catch (_) {}
  await updateBadge(ready.length);
}

// The content script reports the 勤務表's live submit-readiness (works with the panel
// closed). Merge it into the status cache, then recompute the badge/notification.
async function handleTermObserved(msg) {
  if (!msg || !msg.month) return;
  let r;
  try { r = await chrome.storage.local.get('hrTermStatusCache'); } catch (_) { return; }
  const cache = r.hrTermStatusCache || { months: {} };
  if (!cache.months) cache.months = {};
  cache.currentMonth = thisCalMonthKey();
  const cur = cache.months[msg.month] || {};
  cache.months[msg.month] = {
    ...cur, month: msg.month, label: msg.label || cur.label,
    submittable: !!msg.submittable, approval: msg.approval || cur.approval || 'none',
  };
  if (msg.prevApproved && msg.prevMonth) {
    const pe = cache.months[msg.prevMonth] || {};
    cache.months[msg.prevMonth] = {
      ...pe, month: msg.prevMonth, label: pe.label || formatMonthLabel(msg.prevMonth),
      submittable: !!pe.submittable, approval: 'approved',
    };
  }
  // 最終承認 is terminal: record it in the ledger so neither the panel scan nor this
  // observer ever visits the month again.
  const statusModel = globalThis.HRStatusModel;
  if (statusModel && typeof statusModel.confirmMonths === 'function') {
    cache.months = statusModel.confirmMonths(cache.months, Date.now());
  }
  try { await chrome.storage.local.set({ hrTermStatusCache: cache }); } catch (_) {}
  await recomputeTermReady();
}

// ── Periodic background check ──────────────────────────────────────────────────
// One alarm (every few hours) drives two things, both opening a hidden CWS tab and
// letting the content-script submission machine do the work:
//   1. A blocked 月次申請 (hrPendingSubmit) — retried until the previous month is approved.
//   2. Opt-in monthly auto-submit (hrAutoSubmitEnabled) — submits the previous month.
// Each firing first verifies connectivity (see runDailyCheck) and skips quietly when
// off-network — so the frequent cadence is nearly free when you're off campus / no VPN.
// The alarm exists only while one of those two is active.

async function refreshDailyAlarm() {
  let need = false;
  try {
    const s = await chrome.storage.local.get(['hrPendingSubmit', 'hrAutoSubmitEnabled', 'hrAutoEntryEnabled']);
    need = !!s.hrPendingSubmit || !!s.hrAutoSubmitEnabled || !!s.hrAutoEntryEnabled;
  } catch (_) {}
  try {
    const existing = await chrome.alarms.get(RETRY_ALARM);
    if (need && !existing) {
      chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 240, delayInMinutes: 1 });
    } else if (!need && existing) {
      await chrome.alarms.clear(RETRY_ALARM);
    }
  } catch (_) {}
}

// ── Session-expired detection (the one case that needs foreground login) ────────
const LOGIN_NOTIF_ID = 'hr-login-needed';

// A background run opens CWS in a hidden tab. If the login session has expired, CWS
// bounces to the UTokyo Account / Shibboleth login page on a *different* host — work
// only the user can do. Resolve false the moment the tab lands off the CWS host, true
// once it settles on CWS (logged in), true on timeout (assume usable, let it proceed).
function waitForCwsOrLogin(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      let t;
      try { t = await chrome.tabs.get(tabId); } catch (_) { return resolve(true); }
      const url = t.url || t.pendingUrl || '';
      const onCws = url.includes('ut-ppsweb.adm.u-tokyo.ac.jp');
      if (url && !onCws && /^https?:/i.test(url)) return resolve(false); // redirected to login/SSO
      if (onCws && t.status === 'complete') return resolve(true);
      if (Date.now() >= deadline) return resolve(true);
      setTimeout(tick, 800);
    };
    setTimeout(tick, 800);
  });
}

// Clickable prompt: opens CWS so the user can log in; the content script's CWS_READY
// then auto-resumes the submission (onCwsReady). priority 2 so it stays on screen.
function notifyLoginNeeded() {
  try {
    chrome.notifications.create(LOGIN_NOTIF_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'ログインが必要です',
      message: '就労管理システムのログインが切れているため、月次申請を続けられません。この通知をクリックしてログインすると、自動で再開します。',
      priority: 2,
    });
  } catch (_) {}
}

let retryInProgress = false;
let termLedgerWrite = Promise.resolve();

function mutateTermLedger(work) {
  termLedgerWrite = termLedgerWrite.catch(() => {}).then(work);
  return termLedgerWrite;
}

function appendTermHistory(history, event) {
  const model = globalThis.HRStatusModel;
  if (!model || !model.appendHistoryEvent) return Array.isArray(history) ? history : [];
  return model.appendHistoryEvent(history, event, thisCalMonthKey());
}

function historyEvent(month, type, state, message, at = Date.now()) {
  return { month, type, state, message, at };
}

function backgroundOutcome(month, progress) {
  const model = globalThis.HRStatusModel;
  if (model && model.classifyBackgroundOutcome) return model.classifyBackgroundOutcome(month, progress);
  return { completed: false, userAction: null };
}

function backgroundRunPlan(existingRun, now) {
  const model = globalThis.HRStatusModel;
  if (model && model.planBackgroundRun) return model.planBackgroundRun(existingRun, now, RETRY_TIMEOUT_MS);
  return { start: !existingRun, ownsRun: !existingRun, staleMonth: null };
}

function shouldClearAction(action, month, outcome) {
  const model = globalThis.HRStatusModel;
  if (model && model.shouldClearBackgroundAction) return model.shouldClearBackgroundAction(action, month, outcome);
  return !!(action && action.month === month && outcome && (outcome.completed || outcome.retryable));
}

function blockerSignature(month, progress) {
  const value = progress || {};
  const blocker = value.signature || value.message || (value.timeout ? 'timeout' : 'error');
  return `${month}:${blocker}`;
}

async function recordBackgroundRunStart(month, startedAt) {
  return mutateTermLedger(async () => {
    const stored = await chrome.storage.local.get(TERM_HISTORY_KEY);
    const history = appendTermHistory(
      stored[TERM_HISTORY_KEY],
      historyEvent(month, 'processing-started', 'processing', '自動処理を開始しました。', startedAt)
    );
    await chrome.storage.local.set({
      [BACKGROUND_RUN_KEY]: { month, state: 'processing', startedAt },
      [TERM_HISTORY_KEY]: history
    });
  });
}

async function recordBackgroundOutcome(month, progress) {
  const outcome = backgroundOutcome(month, progress);
  if (!outcome.completed && !outcome.retryable && !outcome.userAction) return;

  return mutateTermLedger(async () => {
    const stored = await chrome.storage.local.get([
      TERM_HISTORY_KEY,
      USER_ACTION_KEY,
      NOTIFIED_BLOCKERS_KEY
    ]);
    let history = stored[TERM_HISTORY_KEY];
    const patch = {};
    let notification = null;

    if (outcome.retryable) {
      history = appendTermHistory(history, historyEvent(
        month,
        'failed',
        'failed',
        (progress && progress.message) || '自動処理に失敗しました。次回の自動確認で再試行します。'
      ));
      if (shouldClearAction(stored[USER_ACTION_KEY], month, outcome)) patch[USER_ACTION_KEY] = null;
    } else if (outcome.completed) {
      const waiting = !!(progress && progress.waitingApproval);
      history = appendTermHistory(history, historyEvent(
        month,
        'processing-completed',
        waiting ? 'waiting-approval' : 'processing-completed',
        waiting ? '前月の最終承認待ちのため、自動確認を継続します。' : '自動処理が完了しました。'
      ));
      if (shouldClearAction(stored[USER_ACTION_KEY], month, outcome)) patch[USER_ACTION_KEY] = null;
    } else {
      const signature = blockerSignature(month, progress);
      const action = Object.assign({}, outcome.userAction, { since: Date.now(), signature });
      history = appendTermHistory(history, historyEvent(month, 'action-required', 'user-action-required', action.message));
      patch[USER_ACTION_KEY] = action;

      const notified = stored[NOTIFIED_BLOCKERS_KEY] && typeof stored[NOTIFIED_BLOCKERS_KEY] === 'object'
        ? stored[NOTIFIED_BLOCKERS_KEY] : {};
      if (!notified[signature]) {
        patch[NOTIFIED_BLOCKERS_KEY] = Object.assign({}, notified, { [signature]: { month, at: action.since } });
        notification = action.message;
      }
    }

    patch[TERM_HISTORY_KEY] = history;
    await chrome.storage.local.set(patch);
    if (notification) showNotification('月次申請に確認が必要です', notification);
  });
}

async function recordBackgroundPause(month, state, message) {
  return mutateTermLedger(async () => {
    const stored = await chrome.storage.local.get([TERM_HISTORY_KEY, USER_ACTION_KEY]);
    const history = appendTermHistory(stored[TERM_HISTORY_KEY], historyEvent(month, state, state, message));
    const patch = { [TERM_HISTORY_KEY]: history };
    if (stored[USER_ACTION_KEY] && stored[USER_ACTION_KEY].month === month) patch[USER_ACTION_KEY] = null;
    await chrome.storage.local.set(patch);
  });
}

async function recordBackgroundOutcomeEvent(event) {
  if (!event || !event.month || !event.type || !event.state) return;
  return mutateTermLedger(async () => {
    const stored = await chrome.storage.local.get([TERM_HISTORY_KEY, USER_ACTION_KEY]);
    const history = appendTermHistory(stored[TERM_HISTORY_KEY], {
      month: event.month,
      type: event.type,
      state: event.state,
      message: event.message || '',
      at: event.at || Date.now()
    });
    const patch = { [TERM_HISTORY_KEY]: history };
    if ((event.state === 'submitted-pending' || event.state === 'waiting-approval') &&
        stored[USER_ACTION_KEY] && stored[USER_ACTION_KEY].month === event.month) {
      patch[USER_ACTION_KEY] = null;
    }
    await chrome.storage.local.set(patch);
  });
}

async function clearBackgroundRun(startedAt) {
  const stored = await chrome.storage.local.get(BACKGROUND_RUN_KEY);
  if (stored[BACKGROUND_RUN_KEY] && stored[BACKGROUND_RUN_KEY].startedAt === startedAt) {
    await chrome.storage.local.remove(BACKGROUND_RUN_KEY);
  }
}

// Set hrSubmitState, open a hidden CWS tab, let the content machine run, then clean up.
async function driveSubmitInBackgroundTab(sub) {
  if (retryInProgress) return;
  retryInProgress = true;
  let tabId = null;
  const startedAt = Date.now();
  const month = sub && sub.targetMonth;
  const tracksMonthlySubmission = !!(sub && !sub.entryOnly);
  let ownsRun = false;
  let ownsSessionState = false;
  let ownsSpinner = false;
  try {
    if (!month) return;
    const prior = await chrome.storage.local.get(BACKGROUND_RUN_KEY);
    const existingRun = prior[BACKGROUND_RUN_KEY];
    const plan = backgroundRunPlan(existingRun, startedAt);
    if (!plan.start) return;
    if (plan.staleMonth) {
      await recordBackgroundOutcome(plan.staleMonth, { timeout: true });
      await clearBackgroundRun(existingRun.startedAt);
    }
    if (tracksMonthlySubmission) {
      await recordBackgroundRunStart(month, startedAt);
      ownsRun = true;
    }

    // Clear stale scan state so the workday-scan navigation always starts fresh. A prior
    // run that stalled/timed out mid-scan can leave hrScanNavStep set (e.g. 'main'), which
    // makes clickWorkdayCalendarLink think it already reached the work menu and wait forever
    // for a 本人用実績 link that isn't on the current (勤務表) page — the 2% stall.
    const statusModel = globalThis.HRStatusModel;
    const startupCleanupKeys = statusModel && statusModel.cwsAutomationStartupCleanupKeys
      ? statusModel.cwsAutomationStartupCleanupKeys()
      : ['hrAutoProgress', 'hrScanNavStep', 'hrTermScan', 'hrScanActive', 'hrScanStartedAt'];
    await chrome.storage.session.remove(startupCleanupKeys);
    await chrome.storage.session.set({ hrSubmitState: sub });
    ownsSessionState = true;
    startActivitySpinner(); // toolbar indicator: a hidden run is now working
    ownsSpinner = true;

    const tab = await chrome.tabs.create({ url: MAIN_CWS_URL, active: false });
    tabId = tab.id;
    await chrome.storage.session.set({ [AUTOMATION_TAB_KEY]: tabId });

    // Session expired → CWS bounced to login (foreground work). Prompt and bail; the
    // pending/auto state stays put, so it resumes after the user logs in (CWS_READY)
    // or on the next alarm — rather than failing silently.
    if ((await waitForCwsOrLogin(tabId, 20000)) === false) {
      try { await chrome.storage.local.set({ hrLoginNeededSince: Date.now() }); } catch (_) {}
      if (tracksMonthlySubmission) {
        await recordBackgroundPause(month, 'login-required', 'ログインが必要なため、自動申請を一時停止しました。ログイン後に自動で再開します。');
      }
      notifyLoginNeeded();
      return;
    }

    const progress = await waitForRetryCompletion(RETRY_TIMEOUT_MS);
    const outcomeModel = globalThis.HRStatusModel;
    const entryTerminal = sub.entryOnly && outcomeModel && typeof outcomeModel.terminalEntryProgress === 'function'
      ? outcomeModel.terminalEntryProgress(progress)
      : null;
    if (entryTerminal) await chrome.storage.session.set({ hrAutoProgress: entryTerminal });
    if (tracksMonthlySubmission || entryTerminal) {
      await recordBackgroundOutcome(month, entryTerminal || progress || { timeout: true });
    }
  } catch (err) {
    if (tracksMonthlySubmission || (sub && sub.entryOnly)) {
      const rawFailure = {
        error: true,
        infrastructure: true,
        message: (err && err.message) || (sub && sub.entryOnly
          ? '勤務時間の自動入力中にエラーが発生しました。次回の自動確認で再試行します。'
          : '自動申請中にエラーが発生しました。')
      };
      const outcomeModel = globalThis.HRStatusModel;
      const entryTerminal = sub && sub.entryOnly && outcomeModel && typeof outcomeModel.terminalEntryProgress === 'function'
        ? outcomeModel.terminalEntryProgress(rawFailure)
        : null;
      if (entryTerminal) await chrome.storage.session.set({ hrAutoProgress: entryTerminal });
      await recordBackgroundOutcome(month, entryTerminal || rawFailure);
    }
  } finally {
    if (tabId != null) {
      try {
        const tracked = (await chrome.storage.session.get(AUTOMATION_TAB_KEY))[AUTOMATION_TAB_KEY];
        if (tracked === tabId) await chrome.storage.session.remove(AUTOMATION_TAB_KEY);
      } catch (_) {}
    }
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
    if (ownsSessionState) {
      try { await chrome.storage.session.remove('hrSubmitState'); } catch (_) {}
    }
    if (ownsRun) {
      try { await clearBackgroundRun(startedAt); } catch (_) {}
    }
    if (ownsSpinner) await stopActivitySpinner(); // stop the toolbar spinner + restore the ready-months badge
    retryInProgress = false;
  }
}

async function runPendingRetry() {
  const { hrPendingSubmit } = await chrome.storage.local.get('hrPendingSubmit');
  if (!hrPendingSubmit) { await refreshDailyAlarm(); return; }
  await driveSubmitInBackgroundTab({
    queue: (hrPendingSubmit.queue && hrPendingSubmit.queue.length)
      ? hrPendingSubmit.queue : [hrPendingSubmit.targetMonth],
    queueIndex: 0,
    targetMonth: hrPendingSubmit.targetMonth,
    phase: 'submit-nav',
    config: hrPendingSubmit.config || (await getTermConfig()),
    workdaysByMonth: hrPendingSubmit.workdaysByMonth || {},
    navStep: null,
    auto: true,
  });
}

// Opt-in: submit the previous month automatically (the machine fetches 平日, enters any
// missing hours, waits on prev-month approval, and submits — all quietly if nothing to do).
async function runAutoSubmitCheck() {
  const s = await chrome.storage.local.get(['hrAutoSubmitEnabled', 'hrPendingSubmit', 'hrTermStatusCache']);
  if (!s.hrAutoSubmitEnabled) { await refreshDailyAlarm(); return; }
  if (s.hrPendingSubmit) return; // a blocked submission is already being retried
  const target = prevMonthKey();
  // Already submitted (per the last status scan) → nothing to do; don't reopen a tab.
  const cached = s.hrTermStatusCache && s.hrTermStatusCache.months && s.hrTermStatusCache.months[target];
  const statusModel = globalThis.HRStatusModel;
  const alreadyHandled = statusModel && typeof statusModel.monthlySubmissionAlreadyHandled === 'function'
    ? statusModel.monthlySubmissionAlreadyHandled(cached)
    : !!(cached && (cached.submitted || ['pending', 'approved', 'final', 'complete'].includes(String(cached.approval || '').toLowerCase())));
  if (alreadyHandled) return;
  await driveSubmitInBackgroundTab({
    queue: [target], queueIndex: 0, targetMonth: target, phase: 'submit-nav',
    config: await getTermConfig(), workdaysByMonth: {}, navStep: null, auto: true,
  });
}

// Opt-in: keep the CURRENT month's hours filled — independent of the submission gate.
// Enters every workday in the current month that still lacks times (holiday-aware; never
// overwrites existing records — detectHoursComplete drives which days are missing).
// Runs even while a 月次申請 is blocked on a prior month's approval, so July's daily
// entry is never held up by an unapproved May/June.
async function runCurrentMonthEntryCheck() {
  const target = thisCalMonthKey();
  await driveSubmitInBackgroundTab({
    queue: [target], queueIndex: 0, targetMonth: target, phase: 'submit-nav',
    config: await getTermConfig(), workdaysByMonth: {}, navStep: null,
    auto: true, entryOnly: true,
  });
}

async function runDailyCheck() {
  const s = await chrome.storage.local.get(['hrPendingSubmit', 'hrAutoSubmitEnabled', 'hrAutoEntryEnabled']);
  if (!s.hrPendingSubmit && !s.hrAutoSubmitEnabled && !s.hrAutoEntryEnabled) { await refreshDailyAlarm(); return; }
  // Only act when CWS is actually reachable (campus or VPN). Off-network, skip quietly
  // without opening a tab — the next daily alarm will try again.
  if (!(await isConnected())) return;
  // The UTokyo CWS session rejects simultaneous navigation from two tabs. If the
  // side panel is scanning submission status, let it finish and retry from PANEL_OPENED.
  try {
    const session = await chrome.storage.session.get(['hrScanActive', 'hrScanStartedAt']);
    const model = globalThis.HRStatusModel;
    const lock = model && model.planCwsScanLock
      ? model.planCwsScanLock(session, Date.now(), 120000)
      : { defer: !!session.hrScanActive, stale: false };
    if (lock.defer) return;
    if (lock.stale) await chrome.storage.session.remove(['hrScanActive', 'hrScanStartedAt']);
  } catch (_) {}
  // Current-month hours entry runs first and independently of the submission gate.
  if (s.hrAutoEntryEnabled) await runCurrentMonthEntryCheck();
  if (s.hrPendingSubmit) { await runPendingRetry(); return; }
  await runAutoSubmitCheck();
}

// The content script fires CWS_READY whenever a CWS page loads — which (since login lives
// on a different host) means the user is logged in. If we'd recently asked them to log in,
// resume the submission now instead of waiting for the next alarm.
async function onCwsReady() {
  let s;
  try { s = await chrome.storage.local.get(['hrLoginNeededSince', 'hrPendingSubmit', 'hrAutoSubmitEnabled', 'hrAutoEntryEnabled']); }
  catch (_) { return; }
  if (!s.hrLoginNeededSince) return;
  try { await chrome.storage.local.remove('hrLoginNeededSince'); } catch (_) {}
  if (!s.hrPendingSubmit && !s.hrAutoSubmitEnabled && !s.hrAutoEntryEnabled) return;
  runDailyCheck();
}

// Resolve once the submission flow signals done/error (hrAutoProgress) or it times out.
function waitForRetryCompletion(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const { hrAutoProgress } = await chrome.storage.session.get('hrAutoProgress');
        if (hrAutoProgress && (hrAutoProgress.done || hrAutoProgress.error)) return resolve(hrAutoProgress);
      } catch (_) {}
      if (Date.now() >= deadline) return resolve({ timeout: true });
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 3000);
  });
}

// ── Messages from content scripts / UI ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'NOTIFY') { showNotification(msg.title, msg.message); return; }
  // A CWS page loaded → user is logged in; resume if we were waiting on login.
  if (msg.type === 'CWS_READY') { onCwsReady(); return; }
  // The content script's passive 勤務表 readiness report (panel may be closed).
  if (msg.type === 'TERM_OBSERVED') { handleTermObserved(msg); return; }
  if (msg.type === 'TERM_HISTORY_EVENT') {
    recordBackgroundOutcomeEvent(msg)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  // Recompute the badge/notification from the current status cache.
  if (msg.type === 'TERM_STATUS_REFRESHED' || msg.type === 'TERM_READY_RECOMPUTE') { recomputeTermReady(); return; }
  // These reconcile the daily alarm; the pending/cleared ones also change readiness.
  if (msg.type === 'TERM_SCHEDULE_RETRY' || msg.type === 'TERM_CLEAR_RETRY' ||
      msg.type === 'AUTO_SUBMIT_SCHEDULE' || msg.type === 'AUTO_ENTRY_SCHEDULE') { refreshDailyAlarm(); recomputeTermReady(); return; }
  if (msg.type === 'TERM_RUN_RETRY_NOW') { runDailyCheck(); return; }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) runDailyCheck();
});

// Clicking the "ログインが必要です" prompt opens CWS in the foreground so the user can
// log in; CWS_READY then resumes the submission automatically.
chrome.notifications.onClicked.addListener((id) => {
  if (id !== LOGIN_NOTIF_ID) return;
  try { chrome.tabs.create({ url: MAIN_CWS_URL, active: true }); } catch (_) {}
  try { chrome.notifications.clear(id); } catch (_) {}
});

// Re-arm the alarm, re-apply the badge, AND run a check now on browser startup / install
// / extension reload — so auto-entry / auto-submit act immediately instead of waiting up
// to the full alarm interval. runDailyCheck self-gates on connectivity + enabled flags.
chrome.runtime.onStartup.addListener(() => { refreshDailyAlarm(); recomputeTermReady(); runDailyCheck(); });
chrome.runtime.onInstalled.addListener(() => { refreshDailyAlarm(); recomputeTermReady(); runDailyCheck(); });

// The side panel opened and reported it's ready → run a check now (guarded), so opening
// the panel is itself a trigger rather than relying on the alarm/checkbox.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'PANEL_OPENED') runDailyCheck();
});
