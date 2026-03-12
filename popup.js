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
    await chrome.storage.session.set({ hrScanActive: true });
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
      await chrome.storage.session.remove('hrScanActive');
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

// ── Page detection on popup open ─────────────────────────────────────────────
(async () => {
  setDefaultDates();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab ? (tab.url || '') : '';
  const isOnDomain = url.includes('ut-ppsweb.adm.u-tokyo.ac.jp');

  if (isOnDomain) {
    document.getElementById('automationUI').style.display = 'block';
  } else {
    document.getElementById('notOnDomain').style.display = 'block';
  }
})();

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
  });
});

// ── Minute field auto-pad ────────────────────────────────────────────────────
['arriveEarlyM', 'arriveLatestM', 'departEarlyM', 'departLatestM'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('blur', () => {
    const n = parseInt(el.value, 10);
    el.value = isNaN(n) ? '00' : String(Math.min(n, 59)).padStart(2, '0');
  });
});

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

function setRunning(running) {
  document.getElementById('btnStart').style.display = running ? 'none' : 'flex';
  document.getElementById('btnStop').style.display  = running ? 'flex' : 'none';
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
document.getElementById('btnStart').addEventListener('click', async () => {
  clearMessages();
  updateProgress('キャッシュを確認中...', 0);

  const mode = document.querySelector('input[name="mode"]:checked').value;

  let arriveRange, departRange;
  if (mode === 'manual') {
    const aEH = getInt('arriveEarlyH'), aEM = getInt('arriveEarlyM');
    const aLH = getInt('arriveLatestH'), aLM = getInt('arriveLatestM');
    const dEH = getInt('departEarlyH'),  dEM = getInt('departEarlyM');
    const dLH = getInt('departLatestH'),  dLM = getInt('departLatestM');
    try {
      validateRange(aEH, aEM, aLH, aLM, '出勤');
      validateRange(dEH, dEM, dLH, dLM, '退勤');
    } catch (e) {
      showError(e.message);
      updateProgress('入力エラー', 0);
      return;
    }
    arriveRange = { earlyH: aEH, earlyM: aEM, lateH: aLH, lateM: aLM };
    departRange = { earlyH: dEH, earlyM: dEM, lateH: dLH, lateM: dLM };
  } else {
    arriveRange = { earlyH: 8,  earlyM: 45, lateH: 10, lateM: 0 };
    departRange = { earlyH: 17, earlyM: 0,  lateH: 19, lateM: 0 };
  }

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
});

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
