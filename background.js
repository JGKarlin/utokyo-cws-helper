'use strict';

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
const RETRY_TIMEOUT_MS = 180000; // give a background retry up to 3 min, then close the tab

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
    const s = await chrome.storage.local.get(['hrPendingSubmit', 'hrAutoSubmitEnabled']);
    need = !!s.hrPendingSubmit || !!s.hrAutoSubmitEnabled;
  } catch (_) {}
  try {
    const existing = await chrome.alarms.get(RETRY_ALARM);
    if (need && !existing) {
      chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 240, delayInMinutes: 30 });
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

// Set hrSubmitState, open a hidden CWS tab, let the content machine run, then clean up.
async function driveSubmitInBackgroundTab(sub) {
  if (retryInProgress) return;
  retryInProgress = true;
  let tabId = null;
  try {
    await chrome.storage.session.remove('hrAutoProgress');
    await chrome.storage.session.set({ hrSubmitState: sub });

    const tab = await chrome.tabs.create({ url: MAIN_CWS_URL, active: false });
    tabId = tab.id;

    // Session expired → CWS bounced to login (foreground work). Prompt and bail; the
    // pending/auto state stays put, so it resumes after the user logs in (CWS_READY)
    // or on the next alarm — rather than failing silently.
    if ((await waitForCwsOrLogin(tabId, 20000)) === false) {
      try { await chrome.storage.local.set({ hrLoginNeededSince: Date.now() }); } catch (_) {}
      notifyLoginNeeded();
      return;
    }

    await waitForRetryCompletion(RETRY_TIMEOUT_MS);

    // The side panel is closed during a background run, so surface a hard failure as a
    // desktop notification (success/blocked already notify from content.js).
    const { hrAutoProgress } = await chrome.storage.session.get('hrAutoProgress');
    if (hrAutoProgress && hrAutoProgress.error) {
      showNotification('月次申請に失敗しました', hrAutoProgress.message || 'エラーが発生しました。');
    }
  } catch (_) {
    // best-effort; try again on the next alarm
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
    try { await chrome.storage.session.remove('hrSubmitState'); } catch (_) {}
    await recomputeTermReady(); // a just-submitted month is no longer "ready"
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
    config: hrPendingSubmit.config || DEFAULT_TERM_CONFIG,
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
  if (cached && cached.submitted) return;
  await driveSubmitInBackgroundTab({
    queue: [target], queueIndex: 0, targetMonth: target, phase: 'submit-nav',
    config: DEFAULT_TERM_CONFIG, workdaysByMonth: {}, navStep: null, auto: true,
  });
}

async function runDailyCheck() {
  const s = await chrome.storage.local.get(['hrPendingSubmit', 'hrAutoSubmitEnabled']);
  if (!s.hrPendingSubmit && !s.hrAutoSubmitEnabled) { await refreshDailyAlarm(); return; }
  // Only act when CWS is actually reachable (campus or VPN). Off-network, skip quietly
  // without opening a tab — the next daily alarm will try again.
  if (!(await isConnected())) return;
  if (s.hrPendingSubmit) { await runPendingRetry(); return; }
  await runAutoSubmitCheck();
}

// The content script fires CWS_READY whenever a CWS page loads — which (since login lives
// on a different host) means the user is logged in. If we'd recently asked them to log in,
// resume the submission now instead of waiting for the next alarm.
async function onCwsReady() {
  let s;
  try { s = await chrome.storage.local.get(['hrLoginNeededSince', 'hrPendingSubmit', 'hrAutoSubmitEnabled']); }
  catch (_) { return; }
  if (!s.hrLoginNeededSince) return;
  try { await chrome.storage.local.remove('hrLoginNeededSince'); } catch (_) {}
  if (!s.hrPendingSubmit && !s.hrAutoSubmitEnabled) return;
  runDailyCheck();
}

// Resolve once the submission flow signals done/error (hrAutoProgress) or it times out.
function waitForRetryCompletion(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const { hrAutoProgress } = await chrome.storage.session.get('hrAutoProgress');
        if (hrAutoProgress && (hrAutoProgress.done || hrAutoProgress.error)) return resolve();
      } catch (_) {}
      if (Date.now() >= deadline) return resolve();
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 3000);
  });
}

// ── Messages from content scripts / UI ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'NOTIFY') { showNotification(msg.title, msg.message); return; }
  // A CWS page loaded → user is logged in; resume if we were waiting on login.
  if (msg.type === 'CWS_READY') { onCwsReady(); return; }
  // The content script's passive 勤務表 readiness report (panel may be closed).
  if (msg.type === 'TERM_OBSERVED') { handleTermObserved(msg); return; }
  // Recompute the badge/notification from the current status cache.
  if (msg.type === 'TERM_STATUS_REFRESHED' || msg.type === 'TERM_READY_RECOMPUTE') { recomputeTermReady(); return; }
  // These reconcile the daily alarm; the pending/cleared ones also change readiness.
  if (msg.type === 'TERM_SCHEDULE_RETRY' || msg.type === 'TERM_CLEAR_RETRY' ||
      msg.type === 'AUTO_SUBMIT_SCHEDULE') { refreshDailyAlarm(); recomputeTermReady(); return; }
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

// Re-arm the alarm and re-apply the badge on browser startup / install based on state.
chrome.runtime.onStartup.addListener(() => { refreshDailyAlarm(); recomputeTermReady(); });
chrome.runtime.onInstalled.addListener(() => { refreshDailyAlarm(); recomputeTermReady(); });
