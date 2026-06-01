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

// ── Daily retry for a blocked 月次申請 ─────────────────────────────────────────
// When a submission is blocked because the previous month isn't finally approved,
// the content script records `hrPendingSubmit` (storage.local) and asks us to set a
// daily alarm. Each firing opens a hidden CWS tab and re-runs the submission machine,
// which re-checks the previous month's approval and submits once it clears.

async function scheduleRetryAlarm() {
  try {
    const existing = await chrome.alarms.get(RETRY_ALARM);
    if (!existing) {
      chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1440, delayInMinutes: 1440 });
    }
  } catch (_) {}
}

async function clearRetryAlarm() {
  try { await chrome.alarms.clear(RETRY_ALARM); } catch (_) {}
}

let retryInProgress = false;

async function runPendingRetry() {
  if (retryInProgress) return;
  const { hrPendingSubmit } = await chrome.storage.local.get('hrPendingSubmit');
  if (!hrPendingSubmit) { await clearRetryAlarm(); return; }

  retryInProgress = true;
  let tabId = null;
  try {
    const sub = {
      queue: (hrPendingSubmit.queue && hrPendingSubmit.queue.length)
        ? hrPendingSubmit.queue : [hrPendingSubmit.targetMonth],
      queueIndex: 0,
      targetMonth: hrPendingSubmit.targetMonth,
      phase: 'submit-nav',
      config: hrPendingSubmit.config,
      workdaysByMonth: hrPendingSubmit.workdaysByMonth || {},
      navStep: null,
    };
    await chrome.storage.session.remove('hrAutoProgress');
    await chrome.storage.session.set({ hrSubmitState: sub });

    const tab = await chrome.tabs.create({ url: MAIN_CWS_URL, active: false });
    tabId = tab.id;

    await waitForRetryCompletion(RETRY_TIMEOUT_MS);
  } catch (_) {
    // best-effort; try again on the next alarm
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (_) {} }
    try { await chrome.storage.session.remove('hrSubmitState'); } catch (_) {}
    retryInProgress = false;
  }
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

// ── Messages from content scripts ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'NOTIFY') { showNotification(msg.title, msg.message); return; }
  if (msg.type === 'TERM_SCHEDULE_RETRY') { scheduleRetryAlarm(); return; }
  if (msg.type === 'TERM_CLEAR_RETRY') { clearRetryAlarm(); return; }
  if (msg.type === 'TERM_RUN_RETRY_NOW') { runPendingRetry(); return; }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) runPendingRetry();
});

// Re-arm the alarm on browser startup if a submission is still pending.
chrome.runtime.onStartup.addListener(async () => {
  try {
    const { hrPendingSubmit } = await chrome.storage.local.get('hrPendingSubmit');
    if (hrPendingSubmit) scheduleRetryAlarm();
  } catch (_) {}
});
