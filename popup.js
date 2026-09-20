'use strict';

// ── Date utilities ───────────────────────────────────────────────────────────
function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function setDefaultDates() {
  const today = new Date();
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  document.getElementById('startDate').value = formatDate(today);
  document.getElementById('endDate').value = formatDate(lastDay);
}

const CWS_MAIN_URL = 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws';
const CACHE_KEY = 'hrWorkdaysCacheV2';

// ── UTokyo network connection indicator ──────────────────────────────────────
// The 就労管理システム is only reachable from within the UTokyo network (campus
// or VPN). We probe the CWS URL: if the request resolves (any HTTP response,
// including a login redirect) the host is reachable → connected. A network
// error or timeout means the page "does not open" → not connected.
function setNetStatus(state) {
  const el = document.getElementById('netStatus');
  const label = document.getElementById('netStatusLabel');
  if (!el || !label) return;

  el.classList.remove('net-status--checking', 'net-status--online', 'net-status--offline');

  if (state === 'online') {
    el.classList.add('net-status--online');
    label.textContent = '接続';
    el.title = 'UTokyoネットワークに接続されています（学内またはVPN）。クリックで再確認。';
  } else if (state === 'offline') {
    el.classList.add('net-status--offline');
    label.textContent = '未接続';
    el.title = 'UTokyoネットワークに接続されていません。学内ネットワークまたはVPN接続が必要です。クリックで再確認。';
  } else {
    el.classList.add('net-status--checking');
    label.textContent = '確認中';
    el.title = 'UTokyoネットワークへの接続を確認しています...';
  }
}

async function checkNetworkConnectivity() {
  setNetStatus('checking');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    // redirect: 'manual' so a Shibboleth login redirect still counts as
    // "reachable" without following a cross-origin redirect that could throw.
    await fetch(CWS_MAIN_URL, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
    setNetStatus('online');
  } catch (_) {
    setNetStatus('offline');
  } finally {
    clearTimeout(timer);
  }
}

document.getElementById('netStatus').addEventListener('click', checkNetworkConnectivity);
checkNetworkConnectivity();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeout = 60000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('勤務日の取得がタイムアウトしました'));
    }, timeout);

    const listener = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeoutId);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendMessageWithRetry(tabId, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      lastError = err;
      await delay(500);
    }
  }

  throw lastError || new Error('ページとの通信に失敗しました');
}

function isTransientMessageChannelError(err) {
  const message = String((err && err.message) || err || '');
  return message.includes('before a response was received') ||
    message.includes('Receiving end does not exist') ||
    message.includes('The message port closed');
}

async function prepareWorkdayScanTab(tabId, updateProgressFn) {
  const deadline = Date.now() + 60000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const prep = await sendMessageWithRetry(tabId, { type: 'PREPARE_WORKDAY_SCAN' }, 15000);

    if (prep && prep.ready) return;
    if (prep && prep.error) throw new Error(prep.error);

    const step = prep && prep.step ? prep.step : '勤務表へ移動中...';
    const percent = Math.min(35, 5 + attempt * 2);
    updateProgressFn(step, percent);

    const topLevelNavigation =
      step.includes('就労管理ページへ移動中') ||
      step.includes('就労管理へ移動中') ||
      step.includes('勤務表へ移動中');

    if (topLevelNavigation) {
      try {
        await waitForTabComplete(tabId, 5000);
      } catch (_) {
        // iframe or in-page navigation does not always emit tab updates.
      }
    }

    await delay(prep && prep.waitMs ? prep.waitMs : 1200);
  }

  throw new Error('勤務表へ移動できませんでした');
}

async function fetchWorkdaysForMonth(tabId, monthKey, index, total, updateProgressFn) {
  const label = `${monthKey.slice(0, 4)}年${parseInt(monthKey.slice(5), 10)}月`;
  const deadline = Date.now() + 60000;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (attempt > 0) {
      await waitForTabComplete(tabId).catch(() => {});
      await delay(800);
    }
    attempt += 1;

    const percent = total <= 1 ? 50 : Math.round(40 + (50 * index / total));
    updateProgressFn(`${label}の勤務表で対象勤務日を確認中 (${index}/${total})`, percent);

    try {
      const res = await sendMessageWithRetry(
        tabId,
        { type: 'SCAN_WORKDAYS_FOR_MONTH', monthKey },
        15000
      );

      if (res && res.error) {
        throw new Error(res.error);
      }
      if (Array.isArray(res && res.dates)) return res.dates;
      if (res && res.navigating) {
        updateProgressFn(res.step || `${label}の勤務表へ移動中...`, percent);
        await delay(res.waitMs || 1200);
        continue;
      }
      throw new Error(`${label} の勤務日を読み取れませんでした`);
    } catch (err) {
      if (!isTransientMessageChannelError(err)) {
        throw err;
      }
      await delay(1200);
    }
  }

  throw new Error(`${label} の取得に失敗しました`);
}

function getMonthsInRange(startDate, endDate) {
  const months = [];
  let current = new Date(startDate);
  current.setDate(1);
  const end = new Date(endDate);
  while (current <= end) {
    months.push(`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`);
    current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  }
  return months;
}

async function getWorkdays(startDate, endDate, updateProgressFn) {
  const months = getMonthsInRange(startDate, endDate);
  if (months.length === 0) return [];

  let cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const missing = months.filter(m => !cache[m] || !Array.isArray(cache[m]));

  if (missing.length > 0) {
    updateProgressFn('勤務表で対象勤務日を確認中...', 5);
    await chrome.storage.session.set({ hrScanActive: true, hrScanStartedAt: Date.now() });
    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url: CWS_MAIN_URL, active: false });
      tabId = tab.id;

      await waitForTabComplete(tabId);
      await prepareWorkdayScanTab(tabId, updateProgressFn);

      for (let i = 0; i < missing.length; i++) {
        const monthKey = missing[i];
        const dates = await fetchWorkdaysForMonth(tabId, monthKey, i + 1, missing.length, updateProgressFn);
        cache = { ...cache, [monthKey]: dates };
        await chrome.storage.local.set({ [CACHE_KEY]: cache });
      }

      await chrome.tabs.remove(tabId).catch(() => {});
    } catch (err) {
      if (tabId !== null) {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
      throw err;
    } finally {
      await chrome.storage.session.remove(['hrScanActive', 'hrScanStartedAt']);
    }
  } else {
    updateProgressFn('キャッシュを確認中...', 2);
  }

  const finalCache = cache;
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (const monthKey of months) {
    const monthDates = (finalCache[monthKey] || []);
    for (const d of monthDates) {
      const date = new Date(d);
      if (date >= start && date <= end) dates.push(d);
    }
  }
  return dates.sort();
}

// ── Page detection (live: re-checks when you switch / navigate tabs) ──────────
async function refreshOnDomainUI() {
  let url = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = (tab && tab.url) || '';
  } catch (_) {}
  const onDomain = url.includes('ut-ppsweb.adm.u-tokyo.ac.jp');
  const auto = document.getElementById('automationUI');
  const off = document.getElementById('notOnDomain');
  if (auto) auto.style.display = onDomain ? 'block' : 'none';
  if (off) off.style.display = onDomain ? 'none' : 'block';
}

(async () => {
  setDefaultDates();
  await restoreTermTimeConfig(); // show the saved 出退勤 time range (also used by 月次申請)
  await refreshOnDomainUI();
})();

// The side panel stays open across tab switches/navigations, so re-check the on-domain
// state live — the manual UI then appears/disappears as you move on/off a CWS page,
// instead of being frozen to whatever tab was active when the panel opened.
chrome.tabs.onActivated.addListener(() => { refreshOnDomainUI(); });
chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  if (tab && tab.active && (changeInfo.url || changeInfo.status === 'complete')) refreshOnDomainUI();
});

// ── Open system link ─────────────────────────────────────────────────────────
document.getElementById('btnOpenSystem').addEventListener('click', async (e) => {
  e.preventDefault();
  const tracked = (await chrome.storage.session.get('hrAutomationTabId')).hrAutomationTabId;
  const tabs = await chrome.tabs.query({ url: 'https://ut-ppsweb.adm.u-tokyo.ac.jp/*' });
  const model = globalThis.HRStatusModel;
  const reusable = model && typeof model.chooseReusableCwsTab === 'function'
    ? model.chooseReusableCwsTab(tracked, tabs)
    : null;
  if (reusable) {
    await chrome.tabs.update(reusable.id, { active: true });
    if (Number.isInteger(reusable.windowId)) {
      await chrome.windows.update(reusable.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: CWS_MAIN_URL, active: true });
});

// ── Mode toggle ──────────────────────────────────────────────────────────────
document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const isManual = document.getElementById('modeManual').checked;
    document.getElementById('manualSection').style.display = isManual ? 'block' : 'none';
    saveTermTimeConfig(); // these times also drive the 月次申請 submission
  });
});

// ── Minute field auto-pad ────────────────────────────────────────────────────
['arriveEarlyM', 'arriveLatestM', 'departEarlyM', 'departLatestM'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('blur', () => {
    const n = parseInt(el.value, 10);
    el.value = isNaN(n) ? '00' : String(Math.min(n, 59)).padStart(2, '0');
    saveTermTimeConfig();
  });
});
// Hours persist on change (minutes persist via their blur handler above).
['arriveEarlyH', 'arriveLatestH', 'departEarlyH', 'departLatestH'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', saveTermTimeConfig);
});

// ── 出勤/退勤 time config (shared by 入力開始 and the 月次申請 submission) ──────────
const TERM_TIME_KEY = 'hrTermTimeConfig';
const DEFAULT_ARRIVE = { earlyH: 8, earlyM: 45, lateH: 10, lateM: 0 };
const DEFAULT_DEPART = { earlyH: 17, earlyM: 0, lateH: 19, lateM: 0 };

// Read the time config from the UI. Throws on an invalid manual range (via validateRange).
function readTimeConfigFromUI() {
  const manual = document.getElementById('modeManual').checked;
  if (manual) {
    const aEH = getInt('arriveEarlyH'), aEM = getInt('arriveEarlyM');
    const aLH = getInt('arriveLatestH'), aLM = getInt('arriveLatestM');
    const dEH = getInt('departEarlyH'),  dEM = getInt('departEarlyM');
    const dLH = getInt('departLatestH'),  dLM = getInt('departLatestM');
    validateRange(aEH, aEM, aLH, aLM, '出勤');
    validateRange(dEH, dEM, dLH, dLM, '退勤');
    return { mode: 'manual',
      arriveRange: { earlyH: aEH, earlyM: aEM, lateH: aLH, lateM: aLM },
      departRange: { earlyH: dEH, earlyM: dEM, lateH: dLH, lateM: dLM } };
  }
  return { mode: 'auto', arriveRange: { ...DEFAULT_ARRIVE }, departRange: { ...DEFAULT_DEPART } };
}

// Persist it so the automatic / background 月次申請 fills hours with the same times.
async function saveTermTimeConfig() {
  let cfg;
  try { cfg = readTimeConfigFromUI(); } catch (_) { return; } // skip invalid range; keep last good
  try { await chrome.storage.local.set({ [TERM_TIME_KEY]: cfg }); } catch (_) {}
}

// Restore the saved config into the UI on open so the displayed times match what the
// automatic submission will use.
async function restoreTermTimeConfig() {
  let cfg;
  try { cfg = (await chrome.storage.local.get(TERM_TIME_KEY))[TERM_TIME_KEY]; } catch (_) { return; }
  if (!cfg) return;
  const manual = cfg.mode === 'manual';
  document.getElementById(manual ? 'modeManual' : 'modeAuto').checked = true;
  document.getElementById('manualSection').style.display = manual ? 'block' : 'none';
  if (manual) {
    const a = cfg.arriveRange || DEFAULT_ARRIVE, d = cfg.departRange || DEFAULT_DEPART;
    const pad = (n) => String(n).padStart(2, '0');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('arriveEarlyH', a.earlyH); set('arriveEarlyM', pad(a.earlyM));
    set('arriveLatestH', a.lateH); set('arriveLatestM', pad(a.lateM));
    set('departEarlyH', d.earlyH); set('departEarlyM', pad(d.earlyM));
    set('departLatestH', d.lateH); set('departLatestM', pad(d.lateM));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getInt(id) {
  return parseInt(document.getElementById(id).value, 10) || 0;
}

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.style.display = 'block';
  document.getElementById('successBox').style.display = 'none';
}

function showSuccess(msg) {
  const box = document.getElementById('successBox');
  box.textContent = msg;
  box.style.display = 'block';
  document.getElementById('errorBox').style.display = 'none';
}

function clearMessages() {
  document.getElementById('errorBox').style.display = 'none';
  document.getElementById('successBox').style.display = 'none';
}

let isRunning = false;
function setRunning(running) {
  isRunning = running;
  const auto = !!document.getElementById('autoSubmitToggle').checked;
  // 入力開始 is a manual-entry action — hidden when fully automatic; 停止 only while running.
  document.getElementById('btnStart').style.display = (running || auto) ? 'none' : 'flex';
  document.getElementById('btnStop').style.display  = running ? 'flex' : 'none';
  // Collapse the (now empty) button row when fully automatic and idle.
  const group = document.getElementById('btnGroup');
  if (group) group.style.display = (running || !auto) ? '' : 'none';
}

// When 毎月自動で申請する is on, the manual hours-entry controls (出退勤設定・時刻範囲・
// 対象期間・入力開始) are irrelevant and just clutter the panel — hide them. They return
// the moment the box is unchecked.
function applyAutoSubmitUI() {
  const sec = document.getElementById('manualEntrySection');
  const auto = !!document.getElementById('autoSubmitToggle').checked;
  if (sec) sec.style.display = auto ? 'none' : 'block';
  setRunning(isRunning); // re-apply button visibility for the new mode
}

function updateProgress(text, percent) {
  document.getElementById('statusText').textContent    = text;
  document.getElementById('progressBar').value         = percent;
  document.getElementById('statusPercent').textContent = percent > 0 ? `${percent}%` : '';
}

function validateRange(earlyH, earlyM, lateH, lateM, label) {
  const early = earlyH * 60 + earlyM;
  const late  = lateH  * 60 + lateM;
  if (isNaN(early) || isNaN(late)) {
    throw new Error(`${label}の時刻を正しく入力してください`);
  }
  if (early >= late) {
    throw new Error(`${label}：最早時刻は最遅時刻より前にしてください`);
  }
}

// ── Start automation ─────────────────────────────────────────────────────────
// Loops every eligible workday in the period, entering 出勤 → 退勤 → 勤務外時間数（休憩）.
async function startEntry() {
  clearMessages();
  updateProgress('キャッシュを確認中...', 0);

  let arriveRange, departRange;
  try {
    const cfg = readTimeConfigFromUI();
    arriveRange = cfg.arriveRange;
    departRange = cfg.departRange;
  } catch (e) {
    showError(e.message);
    updateProgress('入力エラー', 0);
    return;
  }
  saveTermTimeConfig(); // keep the persisted (submission) config in sync

  const startDate = document.getElementById('startDate').value;
  const endDate   = document.getElementById('endDate').value;
  if (!startDate) {
    showError('開始日を入力してください');
    updateProgress('入力エラー', 0);
    return;
  }
  if (!endDate) {
    showError('終了日を入力してください');
    updateProgress('入力エラー', 0);
    return;
  }
  if (startDate > endDate) {
    showError('開始日は終了日以前にしてください');
    updateProgress('入力エラー', 0);
    return;
  }

  let dates;
  try {
    dates = await getWorkdays(startDate, endDate, updateProgress);
  } catch (err) {
    showError(err.message || '平日の取得に失敗しました。就労管理システムで本人用実績入力ページを開いてから再試行してください。');
    setRunning(false);
    updateProgress('エラー', 0);
    return;
  }

  if (dates.length === 0) {
    showError('対象となる平日がありません');
    updateProgress('入力エラー', 0);
    return;
  }

  const state = {
    phase: 'clockin',
    dates,
    dateIndex: 0,
    config: { arriveRange, departRange },
  };

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    showError('タブの取得に失敗しました');
    updateProgress('エラー', 0);
    return;
  }

  if (!tab || !tab.url || !tab.url.includes('ut-ppsweb.adm.u-tokyo.ac.jp')) {
    showError('就労管理システムのページで実行してください');
    updateProgress('ページエラー', 0);
    return;
  }

  setRunning(true);
  updateProgress(`${dates.length}日分の入力を開始します...`, 0);

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START', state });
  } catch {
    showError('ページを再読み込みして、もう一度試してください。\n（コンテンツスクリプトが見つかりません）');
    setRunning(false);
    updateProgress('エラー', 0);
  }
}

document.getElementById('btnStart').addEventListener('click', () => startEntry());

// ── Stop automation ──────────────────────────────────────────────────────────
document.getElementById('btnStop').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'STOP' });
  } catch { /* ignore */ }

  chrome.storage.session.remove('hrAutoProgress');
  setRunning(false);
  updateProgress('停止しました', 0);
  document.getElementById('statusPercent').textContent = '';
});

// ── Restore state after popup reopen ─────────────────────────────────────────
chrome.storage.session.get('hrAutoProgress', (result) => {
  const p = result.hrAutoProgress;
  if (!p) return;

  if (p.running) {
    setRunning(true);
    updateProgress(p.text, p.percent);
  } else if (p.done) {
    setRunning(false);
    updateProgress('完了', 100);
    showSuccess(p.text);
    chrome.storage.session.remove('hrAutoProgress');
  } else if (p.error) {
    setRunning(false);
    updateProgress('エラーが発生しました', 0);
    document.getElementById('statusPercent').textContent = '';
    showError(p.message);
    chrome.storage.session.remove('hrAutoProgress');
  }
});

// ── Live sync via storage changes ────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.hrAutoProgress) return;
  const p = changes.hrAutoProgress.newValue;
  if (!p) return;

  if (p.running) {
    setRunning(true);
    updateProgress(p.text, p.percent);
  } else if (p.done) {
    setRunning(false);
    updateProgress('完了', 100);
    showSuccess(p.text);
  } else if (p.error) {
    setRunning(false);
    updateProgress('エラーが発生しました', 0);
    document.getElementById('statusPercent').textContent = '';
    showError(p.message);
  }
});

// ── Messages from content.js ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROGRESS') {
    updateProgress(msg.text, msg.percent);
  }
  if (msg.type === 'DONE') {
    setRunning(false);
    updateProgress('完了', 100);
    showSuccess(msg.text || '入力が完了しました。');
  }
  if (msg.type === 'ERROR') {
    setRunning(false);
    updateProgress('エラーが発生しました', 0);
    document.getElementById('statusPercent').textContent = '';
    showError(msg.message);
  }
});

// ── 月次申請 (monthly report submission) ──────────────────────────────────────
const TERM_CACHE_KEY = 'hrTermStatusCache';
const TERM_HISTORY_KEY = 'hrTermStatusHistory';
const TERM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TERM_CONFIG = {
  arriveRange: { earlyH: 8, earlyM: 45, lateH: 10, lateM: 0 },
  departRange: { earlyH: 17, earlyM: 0, lateH: 19, lateM: 0 },
};

function thisCalendarMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function formatTermLabel(monthKey) {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-');
  return `${y}年${parseInt(m, 10)}月`;
}
function termMonthMinus(monthKey, n) {
  let [y, m] = monthKey.split('-').map(Number);
  m -= n;
  while (m <= 0) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Drive the (background) tab to the 勤務表, then walk months backward collecting status.
async function prepareTermTab(tabId, deadlineMs = 25000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const prep = await sendMessageWithRetry(tabId, { type: 'PREPARE_TERM_PAGE' }, 12000);
    if (prep && prep.ready) return;
    if (prep && prep.error) throw new Error(prep.error);
    const step = (prep && prep.step) || '勤務表へ移動中...';
    setTermStatus(step);
    try { await waitForTabComplete(tabId, 6000); } catch (_) {}
    await delay(prep && prep.waitMs ? prep.waitMs : 1200);
  }
  throw new Error('勤務表ページへ移動できませんでした');
}

async function runTermScan(tabId, confirmedMonths = [], deadlineMs = 70000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const res = await sendMessageWithRetry(tabId, { type: 'SCAN_TERM_STATUS_STEP', confirmedMonths }, 12000);
    if (res && res.error) throw new Error(res.error);
    if (res && res.done) return { months: res.months || {}, currentMonth: res.current };
    setTermStatus((res && res.step) || '確認中...');
    try { await waitForTabComplete(tabId, 6000); } catch (_) {}
    await delay(res && res.waitMs ? res.waitMs : 1200);
  }
  throw new Error('月次申請状況の確認がタイムアウトしました');
}

function setTermStatus(text) {
  const card = document.getElementById('termCard');
  const status = document.getElementById('termStatus');
  if (!card || !status) return;
  card.style.display = 'block';
  status.style.display = 'block';
  status.textContent = text;
}

function isTermCacheFresh(cache) {
  return !!(cache && cache.currentMonth === thisCalendarMonthKey() && cache.scannedAt &&
    (Date.now() - cache.scannedAt) < TERM_CACHE_TTL_MS);
}

function mergedTermMonths(previousMonths, liveMonths, observedAt) {
  const model = globalThis.HRStatusModel;
  const isConfirmed = entry => !!(model && model.isConfirmedMonth(entry));
  const merged = {};
  Object.entries(previousMonths || {}).forEach(([month, entry]) => {
    if (!entry) return;
    // A confirmed month is settled — it is never re-scanned, so it is never stale.
    merged[month] = isConfirmed(entry)
      ? Object.assign({}, entry, { month: entry.month || month })
      : Object.assign({}, entry, { month: entry.month || month, stale: true, fresh: false, source: 'stale' });
  });
  Object.entries(liveMonths || {}).forEach(([month, entry]) => {
    if (!entry) return;
    // The live 勤務表 stays authoritative for status — only the ledger stamp carries
    // over, so a re-read of a confirmed month keeps its original confirmation time.
    const previous = merged[month];
    merged[month] = Object.assign({}, entry, {
      month: entry.month || month,
      stale: false,
      staleFallback: false,
      fresh: true,
      source: 'live'
    });
    if (isConfirmed(previous)) {
      merged[month].confirmed = true;
      merged[month].confirmedAt = previous.confirmedAt;
    }
  });
  return model ? model.confirmMonths(merged, observedAt || Date.now()) : merged;
}

function appendScanHistory(history, previousMonths, nextMonths, currentMonth, observedAt) {
  const oldestMonth = termMonthMinus(currentMonth, 11);
  let result = (Array.isArray(history) ? history : []).filter(event =>
    event && event.month && event.month >= oldestMonth && event.month <= currentMonth
  );
  const model = globalThis.HRStatusModel;
  if (!model) return result;
  model.statusEventsFromSnapshot(previousMonths, nextMonths, observedAt).forEach(event => {
    result = model.appendHistoryEvent(result, event, currentMonth);
  });
  return result;
}

async function loadTermRenderState() {
  const stored = await chrome.storage.local.get([
    'hrPendingSubmit',
    'hrBackgroundRun',
    'hrUserActionRequired',
    TERM_AUTO_KEY
  ]);
  return {
    pending: stored.hrPendingSubmit,
    activeRun: stored.hrBackgroundRun,
    userAction: stored.hrUserActionRequired,
    autoSubmitEnabled: !!stored[TERM_AUTO_KEY]
  };
}

function pendingIsSatisfiedByFreshScan(pending, months) {
  if (!pending || !pending.targetMonth || !pending.prevMonth) return false;
  const previous = months && months[pending.prevMonth];
  if (!previous) return false;
  const model = globalThis.HRStatusModel;
  // A confirmed month is never re-scanned, so it can never come back `fresh` — the
  // ledger entry is the stronger signal and lifts the block on its own.
  if (model && model.isConfirmedMonth(previous)) return true;
  return previous.fresh === true && previous.approval === 'approved';
}

async function discoverTermStatus(isOnDomain) {
  const renderState = await loadTermRenderState();
  let cache = (await chrome.storage.local.get(TERM_CACHE_KEY))[TERM_CACHE_KEY];
  const fresh = isTermCacheFresh(cache);
  const statusModel = globalThis.HRStatusModel;

  // Backfill the ledger from what the cache already knows, so months approved before
  // the ledger existed are confirmed — and shown with their checkmark — without
  // another CWS visit.
  if (statusModel && cache && cache.months) {
    const ledgerMonths = statusModel.confirmMonths(cache.months, Date.now());
    const before = statusModel.confirmedMonthKeys(cache.months);
    const after = statusModel.confirmedMonthKeys(ledgerMonths);
    if (after.length !== before.length) {
      cache = Object.assign({}, cache, { months: ledgerMonths });
      const currentMonth = cache.currentMonth || thisCalendarMonthKey();
      let history = (await chrome.storage.local.get(TERM_HISTORY_KEY))[TERM_HISTORY_KEY];
      after.filter(month => before.indexOf(month) === -1).forEach(month => {
        history = statusModel.appendHistoryEvent(history, {
          month,
          type: 'approved',
          state: 'approved',
          at: (ledgerMonths[month] || {}).confirmedAt || Date.now()
        }, currentMonth);
      });
      await chrome.storage.local.set({ [TERM_CACHE_KEY]: cache, [TERM_HISTORY_KEY]: history });
    }
  }

  // CWS is effectively single-session. When automatic current-month entry is
  // enabled, reserve it exclusively for that full-month run; do not launch the
  // backward June/July status walker from the panel.
  try {
    const local = await chrome.storage.local.get(TERM_ENTRY_KEY);
    const session = await chrome.storage.session.get(['hrSubmitState', 'hrAutoState']);
    const model = globalThis.HRStatusModel;
    const automationActive = !!(model && model.cwsAutomationActive(session));
    const shouldScan = model && model.shouldRunStatusScan
      ? model.shouldRunStatusScan({ autoEntryEnabled: !!local[TERM_ENTRY_KEY], automationActive })
      : !local[TERM_ENTRY_KEY] && !automationActive;
    if (!shouldScan) {
      const history = (await chrome.storage.local.get(TERM_HISTORY_KEY))[TERM_HISTORY_KEY];
      renderTermSection(cache, renderState, history);
      return;
    }
  } catch (_) {}

  // When a submission is pending (blocked on the previous month's approval), don't trust
  // a fresh cache — re-scan so a since-granted 最終承認 is picked up and the block lifts.
  if ((fresh && !renderState.pending) || !isOnDomain) {
    const history = (await chrome.storage.local.get(TERM_HISTORY_KEY))[TERM_HISTORY_KEY];
    renderTermSection(cache, renderState, history);
    return;
  }

  // 最終承認 is terminal, so a month already confirmed can never change. If even the
  // current month is confirmed there is nothing left for a CWS visit to discover.
  const confirmedMonths = statusModel ? statusModel.confirmedMonthKeys(cache && cache.months) : [];
  if (statusModel && !statusModel.termScanNeeded({
    currentMonth: (cache && cache.currentMonth) || thisCalendarMonthKey(),
    months: cache && cache.months
  })) {
    const history = (await chrome.storage.local.get(TERM_HISTORY_KEY))[TERM_HISTORY_KEY];
    renderTermSection(cache, renderState, history);
    return;
  }

  setTermStatus('未提出の月を確認中...');
  document.getElementById('termCurrentStatus').replaceChildren();

  await chrome.storage.session.set({ hrScanActive: true, hrScanStartedAt: Date.now() });
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: CWS_MAIN_URL, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    await prepareTermTab(tabId);
    const scan = await runTermScan(tabId, confirmedMonths);
    await chrome.tabs.remove(tabId).catch(() => {});
    tabId = null;
    const scannedAt = Date.now();
    const previousMonths = (cache && cache.months) || {};
    const months = mergedTermMonths(previousMonths, scan.months, scannedAt);
    const currentMonth = scan.currentMonth || thisCalendarMonthKey();
    cache = { scannedAt, currentMonth, months };
    const oldHistory = (await chrome.storage.local.get(TERM_HISTORY_KEY))[TERM_HISTORY_KEY];
    const history = appendScanHistory(oldHistory, previousMonths, months, currentMonth, scannedAt);
    await chrome.storage.local.set({ [TERM_CACHE_KEY]: cache, [TERM_HISTORY_KEY]: history });
    if (pendingIsSatisfiedByFreshScan(renderState.pending, months)) {
      await chrome.storage.local.remove('hrPendingSubmit');
      try { chrome.runtime.sendMessage({ type: 'TERM_CLEAR_RETRY' }); } catch (_) {}
    }
  } catch (err) {
    if (tabId !== null) await chrome.tabs.remove(tabId).catch(() => {});
    // Fall back to whatever we have (old cache / pending only).
    const history = (await chrome.storage.local.get(TERM_HISTORY_KEY))[TERM_HISTORY_KEY];
    renderTermSection(cache, renderState, history, '未提出の月を確認できませんでした。');
    return;
  } finally {
    await chrome.storage.session.remove(['hrScanActive', 'hrScanStartedAt']);
  }

  const history = (await chrome.storage.local.get(TERM_HISTORY_KEY))[TERM_HISTORY_KEY];
  renderTermSection(cache, await loadTermRenderState(), history);
}

function isStaleRow(row, staleFallback) {
  const model = globalThis.HRStatusModel;
  if (model && model.isConfirmedMonth(row)) return false;
  return staleFallback || row.stale === true || row.staleFallback === true || row.fresh === false || row.source === 'stale';
}

function appendTermStatusRow(container, row, staleFallback) {
  const documentRef = container.ownerDocument;
  const model = globalThis.HRStatusModel;
  const confirmed = !!(model && model.isConfirmedMonth(row));
  const item = documentRef.createElement('div');
  item.className = `term-row term-row--${row.state}${confirmed ? ' term-row--confirmed' : ''}`;
  const message = documentRef.createElement('div');
  if (confirmed) {
    const check = documentRef.createElement('span');
    check.className = 'term-check';
    check.textContent = '✓';
    message.appendChild(check);
  }
  message.appendChild(documentRef.createTextNode(row.message));
  item.appendChild(message);

  if (isStaleRow(row, staleFallback)) {
    const stale = documentRef.createElement('div');
    stale.className = 'term-stale';
    stale.textContent = '前回確認時の情報です';
    item.appendChild(stale);
  }

  if (row.state === 'user-action-required' && row.actionMonth) {
    const button = documentRef.createElement('button');
    button.className = 'btn btn-start term-submit-btn';
    button.dataset.month = row.actionMonth;
    button.textContent = `▶ ${formatTermLabel(row.actionMonth)}分を確認して申請`;
    item.appendChild(button);
  }
  container.appendChild(item);
}

function historyOutcome(event) {
  if (event.message) {
    const model = globalThis.HRStatusModel;
    return model && typeof model.historyMessageBody === 'function'
      ? model.historyMessageBody(event.month, event.message)
      : event.message;
  }
  switch (event.state) {
    case 'submitted-pending': return '提出済み（承認待ち）';
    case 'approved': return '最終承認済み（確認済み）';
    case 'returned': return '差戻し';
    case 'waiting-approval': return '前月の承認待ち';
    case 'processing': return '自動処理を開始';
    case 'ready-auto': return '自動申請の準備完了';
    case 'user-action-required': return '確認が必要';
    default: return event.state || event.type || '状態を確認しました';
  }
}

function historyTimestamp(at) {
  const date = new Date(Number(at));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderTermHistory(history, currentMonth) {
  const container = document.getElementById('termHistory');
  container.replaceChildren();
  const title = document.createElement('div');
  title.className = 'term-history-title';
  title.textContent = '最近の履歴';
  container.appendChild(title);

  const oldestMonth = termMonthMinus(currentMonth, 11);
  const events = (Array.isArray(history) ? history : [])
    .filter(event => event && event.month && event.month >= oldestMonth && event.month <= currentMonth)
    .sort((left, right) => Number(right.at || 0) - Number(left.at || 0));
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'term-history-empty';
    empty.textContent = '履歴はまだありません。';
    container.appendChild(empty);
    return;
  }
  events.forEach(event => {
    const item = document.createElement('div');
    item.className = 'term-history-item';
    const at = historyTimestamp(event.at);
    if (at) {
      const time = document.createElement('span');
      time.className = 'term-history-time';
      time.textContent = at;
      item.appendChild(time);
    }
    const outcome = document.createElement('span');
    outcome.textContent = `${formatTermLabel(event.month)}分：${historyOutcome(event)}`;
    item.appendChild(outcome);
    container.appendChild(item);
  });
}

function renderTermSection(cache, renderState, history, failMsg) {
  const card = document.getElementById('termCard');
  const status = document.getElementById('termStatus');
  const currentStatus = document.getElementById('termCurrentStatus');
  if (!card) return;
  currentStatus.replaceChildren();

  const current = (cache && cache.currentMonth) || thisCalendarMonthKey();
  const months = (cache && cache.months) || {};
  const model = globalThis.HRStatusModel;
  const staleFallback = !!failMsg || !isTermCacheFresh(cache);
  const modelMonths = staleFallback && model && model.markMonthsStale ? model.markMonthsStale(months) : months;
  const rows = model ? model.buildMonthRows(Object.assign({ currentMonth: current, months: modelMonths }, renderState || {})) : [];
  rows.forEach(row => appendTermStatusRow(currentStatus, row, staleFallback));
  renderTermHistory(history, current);

  card.style.display = 'block';
  if (staleFallback) {
    status.style.display = 'block';
    status.textContent = failMsg || '前回の確認結果を表示しています。';
  } else if (!rows.length) {
    status.style.display = 'block';
    status.textContent = '月次申請の状況はまだありません。';
  } else {
    status.style.display = 'none';
  }

  // Refresh the toolbar badge / one-time notification from the latest status.
  try { chrome.runtime.sendMessage({ type: 'TERM_STATUS_REFRESHED' }); } catch (_) {}
}

// Live-update the term card when the status ledger state changes.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!changes[TERM_CACHE_KEY] && !changes[TERM_HISTORY_KEY] && !changes.hrPendingSubmit &&
      !changes.hrBackgroundRun && !changes.hrUserActionRequired && !changes[TERM_AUTO_KEY]) return;
  const stored = await chrome.storage.local.get([TERM_CACHE_KEY, TERM_HISTORY_KEY]);
  renderTermSection(stored[TERM_CACHE_KEY], await loadTermRenderState(), stored[TERM_HISTORY_KEY]);
});

async function startTermSubmission(queue) {
  const labels = queue.map(formatTermLabel).join('、');
  const ok = window.confirm(
    `${labels} の月次申請を行います。\n\n` +
    `未入力の勤務時間を自動入力したうえで申請します。\n月次申請は取り消せません。続行しますか？`
  );
  if (!ok) return;

  clearMessages();
  setRunning(true);
  updateProgress('勤務表の平日を確認中...', 0);

  // 1) Ensure each month's 平日 are known (reuse the existing workday scan + cache).
  const workdaysByMonth = {};
  try {
    for (const month of queue) {
      const [y, m] = month.split('-').map(Number);
      const start = `${month}-01`;
      const last = new Date(y, m, 0).getDate();
      const end = `${month}-${String(last).padStart(2, '0')}`;
      workdaysByMonth[month] = await getWorkdays(start, end, updateProgress);
    }
  } catch (err) {
    showError(err.message || '平日の取得に失敗しました');
    setRunning(false);
    updateProgress('エラー', 0);
    return;
  }

  // 2) The submission drives the active tab — it must be a CWS page.
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    showError('タブの取得に失敗しました');
    setRunning(false);
    updateProgress('エラー', 0);
    return;
  }
  if (!tab || !tab.url || !tab.url.includes('ut-ppsweb.adm.u-tokyo.ac.jp')) {
    if (tab) {
      await chrome.tabs.update(tab.id, { url: CWS_MAIN_URL });
      showError('就労管理システムを開きました。ページの読み込み後、もう一度「申請」を押してください。');
    } else {
      showError('就労管理システムのページを開いてから実行してください');
    }
    setRunning(false);
    updateProgress('', 0);
    return;
  }

  // 3) Kick off the submission state machine (using the saved 出退勤設定 time range).
  const tcfg = (await chrome.storage.local.get(TERM_TIME_KEY))[TERM_TIME_KEY];
  const config = (tcfg && tcfg.arriveRange && tcfg.departRange)
    ? { arriveRange: tcfg.arriveRange, departRange: tcfg.departRange } : DEFAULT_TERM_CONFIG;
  updateProgress(`${formatTermLabel(queue[0])} の月次申請を開始します...`, 0);
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'START_TERM_SUBMIT', queue, workdaysByMonth, config,
    });
  } catch {
    showError('ページを再読み込みして、もう一度試してください。');
    setRunning(false);
    updateProgress('エラー', 0);
  }
}

document.getElementById('termCurrentStatus').addEventListener('click', (e) => {
  const btn = e.target.closest('.term-submit-btn');
  if (!btn || !btn.dataset.month) return;
  startTermSubmission([btn.dataset.month]);
});

// ── Opt-in: 毎月自動で申請する (off by default) ─────────────────────────────────
const TERM_AUTO_KEY = 'hrAutoSubmitEnabled';
(async () => {
  const el = document.getElementById('autoSubmitToggle');
  if (!el) return;
  document.getElementById('termCard').style.display = 'block';
  const stored = (await chrome.storage.local.get(TERM_AUTO_KEY))[TERM_AUTO_KEY];
  el.checked = !!stored;
  applyAutoSubmitUI();
  el.addEventListener('change', async () => {
    if (el.checked) {
      const ok = window.confirm(
        '毎月、前月分の月次申請を自動で行います。\n\n' +
        '必要な勤務時間を自動入力し、前月の承認を待って自動的に申請します（月次申請は取り消せません）。\n\n' +
        '有効にしますか？'
      );
      if (!ok) { el.checked = false; applyAutoSubmitUI(); return; }
      await chrome.storage.local.set({ [TERM_AUTO_KEY]: true });
    } else {
      await chrome.storage.local.set({ [TERM_AUTO_KEY]: false });
    }
    applyAutoSubmitUI();
    try { chrome.runtime.sendMessage({ type: 'AUTO_SUBMIT_SCHEDULE' }); } catch (_) {}
  });
})();

// ── Opt-in: 今月の勤務時間を自動入力する (off by default) ─────────────────────────
// Independent of 月次申請 — keeps the CURRENT month's hours filled even while a prior
// month's submission is blocked on approval. The background alarm does the work.
const TERM_ENTRY_KEY = 'hrAutoEntryEnabled';
(async () => {
  const el = document.getElementById('autoEntryToggle');
  if (!el) return;
  document.getElementById('entryCard').style.display = 'block';
  const stored = (await chrome.storage.local.get(TERM_ENTRY_KEY))[TERM_ENTRY_KEY];
  el.checked = !!stored;
  el.addEventListener('change', async () => {
    if (el.checked) {
      const ok = window.confirm(
        '今月の勤務時間を自動で入力します。\n\n' +
        '出勤日のうち未入力の日を、出退勤設定の時刻で入力します。' +
        '前月の承認・月次申請の状況とは無関係に実行します。\n\n' +
        '有効にしますか？'
      );
      if (!ok) { el.checked = false; return; }
      await chrome.storage.local.set({ [TERM_ENTRY_KEY]: true });
      try { chrome.runtime.sendMessage({ type: 'AUTO_ENTRY_SCHEDULE' }); } catch (_) {}
      try { chrome.runtime.sendMessage({ type: 'TERM_RUN_RETRY_NOW' }); } catch (_) {} // fill now, don't wait for the alarm
    } else {
      await chrome.storage.local.set({ [TERM_ENTRY_KEY]: false });
      try { chrome.runtime.sendMessage({ type: 'AUTO_ENTRY_SCHEDULE' }); } catch (_) {}
    }
  });
})();

// Kick off read-only discovery on popup open (scan only when on the CWS domain / logged in).
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onDomain = !!(tab && tab.url && tab.url.includes('ut-ppsweb.adm.u-tokyo.ac.jp'));
  await discoverTermStatus(onDomain);
  // Status discovery owns CWS until its hidden tab is closed. Only then trigger
  // automatic August entry, preventing the server's 画面遷移エラー.
  try { chrome.runtime.sendMessage({ type: 'PANEL_OPENED' }); } catch (_) {}
})();
