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
const CACHE_KEY = 'hrWorkdaysCache';

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
      reject(new Error('平日の取得がタイムアウトしました'));
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

    const step = prep && prep.step ? prep.step : '本人用実績入力へ移動中...';
    const percent = Math.min(35, 5 + attempt * 2);
    updateProgressFn(step, percent);

    const topLevelNavigation =
      step.includes('就労管理ページへ移動中') ||
      step.includes('本人用実績メニューへ移動中') ||
      step.includes('本人用実績入力へ移動中');

    if (topLevelNavigation) {
      try {
        await waitForTabComplete(tabId, 5000);
      } catch (_) {
        // iframe or in-page navigation does not always emit tab updates.
      }
    }

    await delay(prep && prep.waitMs ? prep.waitMs : 1200);
  }

  throw new Error('本人用実績入力ページへ移動できませんでした');
}

async function fetchWorkdaysForMonth(tabId, monthKey, index, total, updateProgressFn) {
  const label = `${monthKey.slice(0, 4)}年${parseInt(monthKey.slice(5), 10)}月`;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await waitForTabComplete(tabId).catch(() => {});
      await delay(800);
    }

    const percent = total <= 1 ? 50 : Math.round(40 + (50 * index / total));
    updateProgressFn(`${label}の本人用実績入力で対象期間を表示し、勤務表の平日を確認中 (${index}/${total})`, percent);

    try {
      const res = await sendMessageWithRetry(
        tabId,
        { type: 'SCAN_WORKDAYS_FOR_MONTH', monthKey },
        15000
      );

      if (res && res.error) {
        throw new Error(res.error);
      }

      return Array.isArray(res && res.dates) ? res.dates : [];
    } catch (err) {
      if (!isTransientMessageChannelError(err) || attempt === 2) {
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
    updateProgressFn('本人用実績入力で対象期間を表示し、勤務表の平日を確認中...', 5);
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.update(tab.id, { url: 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws' });
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

async function runTermScan(tabId, deadlineMs = 70000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const res = await sendMessageWithRetry(tabId, { type: 'SCAN_TERM_STATUS_STEP' }, 12000);
    if (res && res.error) throw new Error(res.error);
    if (res && res.done) return res.months || {};
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

async function discoverTermStatus(isOnDomain) {
  const { hrPendingSubmit } = await chrome.storage.local.get('hrPendingSubmit');
  let cache = (await chrome.storage.local.get(TERM_CACHE_KEY))[TERM_CACHE_KEY];
  const fresh = cache && cache.currentMonth === thisCalendarMonthKey() &&
    cache.scannedAt && (Date.now() - cache.scannedAt) < TERM_CACHE_TTL_MS;

  // When a submission is pending (blocked on the previous month's approval), don't trust
  // a fresh cache — re-scan so a since-granted 最終承認 is picked up and the block lifts.
  if ((fresh && !hrPendingSubmit) || !isOnDomain) {
    renderTermSection(cache, hrPendingSubmit);
    return;
  }

  setTermStatus('未提出の月を確認中...');
  document.getElementById('termList').innerHTML = '';

  await chrome.storage.session.set({ hrScanActive: true, hrScanStartedAt: Date.now() });
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: CWS_MAIN_URL, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    await prepareTermTab(tabId);
    const months = await runTermScan(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    tabId = null;
    cache = { scannedAt: Date.now(), currentMonth: thisCalendarMonthKey(), months: months || {} };
    await chrome.storage.local.set({ [TERM_CACHE_KEY]: cache });
  } catch (err) {
    if (tabId !== null) await chrome.tabs.remove(tabId).catch(() => {});
    // Fall back to whatever we have (old cache / pending only).
    renderTermSection(cache, hrPendingSubmit, '未提出の月を確認できませんでした。');
    return;
  } finally {
    await chrome.storage.session.remove(['hrScanActive', 'hrScanStartedAt']);
  }

  renderTermSection(cache, hrPendingSubmit);
}

function renderTermSection(cache, pending, failMsg) {
  const card = document.getElementById('termCard');
  const status = document.getElementById('termStatus');
  const list = document.getElementById('termList');
  if (!card) return;
  list.innerHTML = '';

  const current = (cache && cache.currentMonth) || thisCalendarMonthKey();
  const months = (cache && cache.months) || {};

  // Self-heal a stale block: if the pending month's previous month is now 最終承認 (per
  // the fresh scan), the dependency is satisfied — drop the stale pending record and let
  // the month render as a normal submittable candidate instead of the "承認待ち" banner.
  if (pending && pending.targetMonth && pending.prevMonth) {
    const prevApproval = (months[pending.prevMonth] || {}).approval;
    if (prevApproval === 'approved') {
      chrome.storage.local.remove('hrPendingSubmit');
      try { chrome.runtime.sendMessage({ type: 'TERM_CLEAR_RETRY' }); } catch (_) {}
      pending = null;
    }
  }

  const candidates = Object.values(months)
    .filter(m => m.submittable && m.month < current &&
      (m.approval === 'none' || m.approval === 'returned' || !m.approval))
    .sort((a, b) => (a.month < b.month ? 1 : -1)); // newest first

  // Submitted but not yet 最終承認 → positive confirmation (recent months only). Covers
  // both the plugin path (submitted:true) and a manual/observed submit (approval pending,
  // no longer submittable).
  const submitted = Object.values(months)
    .filter(m => m && m.month && m.month < current && m.month >= termMonthMinus(current, 2) &&
      (m.submitted === true || (m.approval === 'pending' && !m.submittable)))
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  let shownButton = false;
  let shownAny = false;

  if (pending && pending.targetMonth) {
    shownAny = true;
    const div = document.createElement('div');
    div.className = 'term-item term-blocked';
    div.innerHTML = `<span class="term-month">${formatTermLabel(pending.targetMonth)}</span>：前月（${formatTermLabel(pending.prevMonth)}）の承認待ち。承認後に自動申請します。`;
    list.appendChild(div);
  }

  for (const m of submitted) {
    shownAny = true;
    const div = document.createElement('div');
    div.className = 'term-item term-done';
    div.innerHTML = `<span class="term-done-check">✓</span> <span class="term-month">${formatTermLabel(m.month)}</span>分の勤務実績を提出しました（承認待ち）。`;
    list.appendChild(div);
  }

  for (const m of candidates) {
    if (pending && pending.targetMonth === m.month) continue;
    if (submitted.some(s => s.month === m.month)) continue;
    shownAny = true;
    shownButton = true;
    const wrap = document.createElement('div');
    wrap.className = 'term-item';

    const prevApproval = (months[termMonthMinus(m.month, 1)] || {}).approval;
    const btn = document.createElement('button');
    btn.className = 'btn btn-start term-submit-btn';
    btn.dataset.month = m.month;
    btn.textContent = `▶ ${m.label}分を申請`;
    wrap.appendChild(btn);

    if (prevApproval && prevApproval !== 'approved') {
      const note = document.createElement('div');
      note.className = 'term-hint';
      note.textContent = `※前月（${formatTermLabel(termMonthMinus(m.month, 1))}）未承認。承認後に自動申請。`;
      wrap.appendChild(note);
    }
    list.appendChild(wrap);
  }

  card.style.display = 'block';
  if (shownButton) {
    status.style.display = 'none';
    const hint = document.createElement('div');
    hint.className = 'term-hint';
    hint.textContent = '※月次申請は取り消せません。';
    list.appendChild(hint);
  } else if (shownAny) {
    status.style.display = 'none';
  } else if (failMsg) {
    status.style.display = 'block';
    status.textContent = failMsg;
  } else {
    status.style.display = 'block';
    status.textContent = '未提出の月はありません。';
  }

  // Refresh the toolbar badge / one-time notification from the latest status.
  try { chrome.runtime.sendMessage({ type: 'TERM_STATUS_REFRESHED' }); } catch (_) {}
}

// Live-update the term card when the status cache / pending record changes (e.g. a
// submission completes) so it reflects "提出しました" without the panel being reopened.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!changes[TERM_CACHE_KEY] && !changes.hrPendingSubmit) return;
  const cache = (await chrome.storage.local.get(TERM_CACHE_KEY))[TERM_CACHE_KEY];
  const { hrPendingSubmit } = await chrome.storage.local.get('hrPendingSubmit');
  renderTermSection(cache, hrPendingSubmit);
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

document.getElementById('termList').addEventListener('click', (e) => {
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

// ── Auto-prompt on detect (paired with the manual button) ─────────────────────
const TERM_PROMPTED_KEY = 'hrAutoPromptedMonths';

// Same "ready for manual submission" rule the background uses for the toolbar badge.
function computeReadyMonths(cache, pendingMonth) {
  const months = (cache && cache.months) || {};
  const current = (cache && cache.currentMonth) || thisCalendarMonthKey();
  const ready = [];
  for (const m of Object.values(months)) {
    if (!m || !m.month) continue;
    if (!m.submittable) continue;
    if (!(m.month < current)) continue;
    if (!(m.approval === 'none' || m.approval === 'returned' || !m.approval)) continue;
    if (pendingMonth && pendingMonth === m.month) continue;
    const prev = months[termMonthMinus(m.month, 1)];
    if (!prev || prev.approval !== 'approved') continue;
    ready.push(m.month);
  }
  return ready.sort();
}

// When the panel opens and a month is ready, pop the confirm dialog automatically —
// but only when 毎月自動で申請する is OFF (else the background submits silently and a
// prompt would just race it), only on the CWS domain, and at most once per month (the
// button stays available for any later run).
async function maybeAutoPromptManual(isOnDomain) {
  if (!isOnDomain) return;
  try {
    const prog = (await chrome.storage.session.get('hrAutoProgress')).hrAutoProgress;
    if (prog && prog.running) return; // a run is already in progress
    const enabled = (await chrome.storage.local.get(TERM_AUTO_KEY))[TERM_AUTO_KEY];
    if (enabled) return;
    const cache = (await chrome.storage.local.get(TERM_CACHE_KEY))[TERM_CACHE_KEY];
    const { hrPendingSubmit } = await chrome.storage.local.get('hrPendingSubmit');
    const ready = computeReadyMonths(cache, hrPendingSubmit && hrPendingSubmit.targetMonth);
    if (!ready.length) return;
    const prompted = (await chrome.storage.local.get(TERM_PROMPTED_KEY))[TERM_PROMPTED_KEY] || [];
    const target = ready.find(mo => !prompted.includes(mo));
    if (!target) return;
    await chrome.storage.local.set({ [TERM_PROMPTED_KEY]: [...prompted, target] });
    startTermSubmission([target]); // shows the one confirm dialog, then runs automatically
  } catch (_) {}
}

// Kick off discovery on popup open (scan only when on the CWS domain / logged in).
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onDomain = !!(tab && tab.url && tab.url.includes('ut-ppsweb.adm.u-tokyo.ac.jp'));
  await discoverTermStatus(onDomain);
  maybeAutoPromptManual(onDomain);
})();
