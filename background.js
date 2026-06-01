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

// ── Daily background check ─────────────────────────────────────────────────────
// One daily alarm drives two things, both opening a hidden CWS tab and letting the
// content-script submission machine do the work:
//   1. A blocked 月次申請 (hrPendingSubmit) — retried until the previous month is approved.
//   2. Opt-in monthly auto-submit (hrAutoSubmitEnabled) — submits the previous month.
// The alarm exists only while one of those is active.

async function refreshDailyAlarm() {
  let need = false;
  try {
    const s = await chrome.storage.local.get(['hrPendingSubmit', 'hrAutoSubmitEnabled']);
    need = !!s.hrPendingSubmit || !!s.hrAutoSubmitEnabled;
  } catch (_) {}
  try {
    const existing = await chrome.alarms.get(RETRY_ALARM);
    if (need && !existing) {
      chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1440, delayInMinutes: 1440 });
    } else if (!need && existing) {
      await chrome.alarms.clear(RETRY_ALARM);
    }
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
  const s = await chrome.storage.local.get(['hrAutoSubmitEnabled', 'hrPendingSubmit']);
  if (!s.hrAutoSubmitEnabled) { await refreshDailyAlarm(); return; }
  if (s.hrPendingSubmit) return; // a blocked submission is already being retried
  const target = prevMonthKey();
  await driveSubmitInBackgroundTab({
    queue: [target], queueIndex: 0, targetMonth: target, phase: 'submit-nav',
    config: DEFAULT_TERM_CONFIG, workdaysByMonth: {}, navStep: null, auto: true,
  });
}

async function runDailyCheck() {
  const s = await chrome.storage.local.get(['hrPendingSubmit', 'hrAutoSubmitEnabled']);
  if (s.hrPendingSubmit) { await runPendingRetry(); return; }
  if (s.hrAutoSubmitEnabled) { await runAutoSubmitCheck(); return; }
  await refreshDailyAlarm();
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
  // All of these just reconcile the daily alarm with current storage state.
  if (msg.type === 'TERM_SCHEDULE_RETRY' || msg.type === 'TERM_CLEAR_RETRY' ||
      msg.type === 'AUTO_SUBMIT_SCHEDULE') { refreshDailyAlarm(); return; }
  if (msg.type === 'TERM_RUN_RETRY_NOW') { runDailyCheck(); return; }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) runDailyCheck();
});

// Re-arm (or clear) the alarm on browser startup based on current state.
chrome.runtime.onStartup.addListener(() => { refreshDailyAlarm(); });
chrome.runtime.onInstalled.addListener(() => { refreshDailyAlarm(); });
