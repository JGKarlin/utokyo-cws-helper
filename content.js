'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let shouldStop = false;
const MAIN_CWS_URL = 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws';
const WORK_MENU_LINK_SELECTOR = '#maincontentsbody > form > table:nth-child(7) > tbody > tr:nth-child(2) > td > div.mainmenuleft > ul > li:nth-child(1) > a';
const WORK_MENU_LINK_HREF = 'cws?@SID=null&@SUB=root.cws.shuro&@SN=root.cws&@FN=-167990413';
const PERFORMANCE_LINK_SELECTOR = 'body > table:nth-child(11) > tbody > tr > td > table > tbody > tr > td > form > table > tbody > tr:nth-child(1) > td > table > tbody > tr > td > table > tbody > tr:nth-child(5) > td:nth-child(1) > a';
const PERFORMANCE_LINK_HREF = 'cws?@SID=null&@SUB=root.cws.shuro.personal.wp&@SN=root.cws.shuro.personal.wp&@FN=form_shuro';
const MATRIX_INPUT_LINK_SELECTOR = 'body > table:nth-child(11) > tbody > tr > td > table > tbody > tr > td > form > div > table > tbody > tr:nth-child(1) > th > h2 > a';
const MATRIX_INPUT_LINK_HREF = 'cws?@SID=null&@SUB=root.cws.shuro.personal.wp.matrixinput&@SN=root.cws.shuro.personal.wp.matrixinput&@FN=FORM_WP_PERSONAL';

// ── Communication ─────────────────────────────────────────────────────────────
// True only while this content script's extension context is still valid. After the
// extension is reloaded/updated, the already-injected script keeps running but its
// chrome.* bridge is severed — any chrome call then throws "Extension context
// invalidated". Guarding on this lets the orphaned instance bail quietly instead of
// spraying uncaught errors (it can do nothing useful until the page is reloaded).
function extensionAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
}

// Fire-and-forget session-storage writes that must never throw on a dead context
// (synchronous throw and async rejection are both swallowed).
function safeSessionSet(obj) {
  if (!extensionAlive()) return;
  try { const p = chrome.storage.session.set(obj); if (p && p.catch) p.catch(() => {}); } catch (_) {}
}
function safeSessionRemove(keys) {
  if (!extensionAlive()) return;
  try { const p = chrome.storage.session.remove(keys); if (p && p.catch) p.catch(() => {}); } catch (_) {}
}

function sendToPopup(msg) {
  try { chrome.runtime.sendMessage(msg); } catch {}
}

function sendProgress(text, percent) {
  sendToPopup({ type: 'PROGRESS', text, percent });
  safeSessionSet({ hrAutoProgress: { running: true, text, percent } });
}

function sendDone(text, details) {
  sendToPopup({ type: 'DONE', text });
  safeSessionSet({ hrAutoProgress: Object.assign({ running: false, done: true, text }, details || {}) });
}

function sendError(message) {
  sendToPopup({ type: 'ERROR', message });
  safeSessionSet({ hrAutoProgress: { running: false, error: true, message } });
}

async function setTerminalAutoProgress(progress) {
  if (!extensionAlive()) return;
  try {
    await chrome.storage.session.remove(['hrSubmitState', 'hrAutoState', 'hrTermScan']);
    await chrome.storage.session.set({ hrAutoProgress: progress });
  } catch (_) {}
}

async function sendRetryableSubmitError(sub, message) {
  await setTerminalAutoProgress({ running: false, error: true, retryable: true, message });
  if (!(sub && sub.auto)) sendToPopup({ type: 'ERROR', message });
}

async function sendTerminalSubmitError(sub, message) {
  await setTerminalAutoProgress({ running: false, error: true, message });
  if (!(sub && sub.auto)) sendToPopup({ type: 'ERROR', message });
}

async function sendTerminalSubmitDone(message) {
  await setTerminalAutoProgress({ running: false, done: true, text: message });
  sendToPopup({ type: 'DONE', text: message });
}

// Ask the background service worker to raise an OS/desktop notification (works even
// when the side panel is closed — e.g. during the unattended daily retry).
function notify(title, message) {
  try { chrome.runtime.sendMessage({ type: 'NOTIFY', title, message }); } catch (_) {}
}

async function emitTermHistoryEvent(month, type, state, message) {
  if (!extensionAlive()) return false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TERM_HISTORY_EVENT', month, type, state, message, at: Date.now()
    });
    return !(response && response.error);
  } catch (_) {
    return false;
  }
}

// ── DOM Utilities ─────────────────────────────────────────────────────────────
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start >= timeout)
        return reject(new Error(`要素が見つかりません: ${selector}`));
      setTimeout(check, 100);
    };
    check();
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForPredicate(check, timeout = 10000, errorMessage = '条件を満たしませんでした') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - start >= timeout) {
        return reject(new Error(errorMessage));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function setFieldValue(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function randomTime(earlyH, earlyM, lateH, lateM) {
  const earlyTotal = earlyH * 60 + earlyM;
  const lateTotal = lateH * 60 + lateM;
  const total = Math.round(earlyTotal + Math.random() * (lateTotal - earlyTotal));
  return { h: Math.floor(total / 60), m: total % 60 };
}

// ── Page Detection ────────────────────────────────────────────────────────────
function detectPage() {
  const title = document.title || '';
  const url = window.location.href;

  if (!url.includes('ut-ppsweb.adm.u-tokyo.ac.jp')) return 'unknown';

  if (title.includes('出勤）【入力】')) return 'clockin-input';
  if (title.includes('退勤）【入力】')) return 'clockout-input';
  if (title.includes('勤務外時間数【入力】')) return 'break-input';
  if (title.includes('【確認】')) return 'confirm';

  // Confirmation form is in an iframe; outer frame may have title メインメニュー.
  // Only detect by exact structure (form center table) — avoid matching reauth 送信 on other pages.
  if (document.querySelector('form center table tbody tr td:nth-child(1) font input[type=submit]')) return 'confirm';

  // Success page: check for the return link text
  const bodyText = document.body ? (document.body.textContent || '') : '';
  if (bodyText.includes('就労メインページへ戻る')) {
    return 'success';
  }

  if (title === '就労申請') return 'application-menu';

  // Any other page on the domain
  return 'other';
}

// ── Navigation Actions ────────────────────────────────────────────────────────

function navigateToApplicationMenu() {
  // Find the 就労申請 link on the page
  const links = document.querySelectorAll('a');
  for (const link of links) {
    if (link.textContent.trim() === '就労申請' &&
        link.href.includes('root.cws.shuro.personal.srw_app')) {
      link.click();
      return;
    }
  }
  // Fallback: navigate directly
  window.location.href = 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws?@SID=null&@SUB=root.cws.shuro.personal.srw_app&@SN=root.cws.shuro.personal.srw_app&@FN=form_shuro';
}

function clickApplicationLink(phase) {
  const linkText = phase === 'clockin' ? '自己申告記録（出勤）'
    : phase === 'clockout' ? '自己申告記録（退勤）' : '勤務外時間数';
  const navigation = globalThis.HRNavigation;

  const links = document.querySelectorAll('a');
  for (const link of links) {
    const matches = navigation && typeof navigation.matchesApplicationLink === 'function'
      ? navigation.matchesApplicationLink(phase, link.textContent, link.href)
      : link.textContent.includes(linkText);
    if (matches) {
      link.click();
      return;
    }
  }
  throw new Error(`${linkText} のリンクが見つかりません`);
}

async function fillDateAndTime(state) {
  const { phase, dates, dateIndex, config } = state;
  const dateStr = dates[dateIndex];
  const [yyyy, mm, dd] = dateStr.split('-');

  // Wait for form to be ready (calendar may still be initializing)
  await delay(600);

  // Close any open calendar popup before filling
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
    await delay(200);
  }

  // Set date via hidden fields + spans (avoid triggering calendar)
  const setDate = (name, value, spanId) => {
    const hidden = document.querySelector(`input[name="${name}"]`);
    const span = document.getElementById(spanId);
    if (hidden) hidden.value = value;
    if (span) span.textContent = value;
  };
  setDate('sdate_date_yyyy', yyyy, 'sdate_date_yyyy_span');
  setDate('sdate_date_mm', mm, 'sdate_date_mm_span');
  setDate('sdate_date_dd', dd, 'sdate_date_dd_span');

  await delay(400);

  // Enter time
  const range = phase === 'clockin' ? config.arriveRange : config.departRange;
  const time = randomTime(range.earlyH, range.earlyM, range.lateH, range.lateM);

  // Both 出勤 and 退勤 use same structure: tr.r1 > td:nth-child(2) > table with hour (1st) and minute (2nd) inputs
  // 出勤 has name="gi1_6H"/"gi1_6M"; 退勤 may use different names — use structure for both
  const r1Inputs = document.querySelectorAll('form table tr.r1 td:nth-child(2) table input[type=text]');
  const hourField = r1Inputs[0] || document.querySelector('input[name="gi1_6H"]');
  const minField  = r1Inputs[1] || document.querySelector('input[name="gi1_6M"]');

  if (!hourField || !minField) {
    throw new Error('時刻入力フィールドが見つかりません');
  }

  // Hours NOT zero-padded, minutes zero-padded
  setFieldValue(hourField, String(time.h));
  setFieldValue(minField, pad2(time.m));

  await delay(300);

  // Click 次 へ submit button (value may have different spacing)
  const submitBtn =
    document.querySelector('input[type="submit"][value="次 へ"]') ||
    document.querySelector('input[type="submit"][value="次　へ"]') ||
    document.querySelector('input[type="submit"][value*="次"]');
  if (!submitBtn) {
    throw new Error('「次 へ」ボタンが見つかりません');
  }
  submitBtn.click();
}

// Random 勤務外時間数 (break) in whole minutes. Staff requires ≥45 min for any 6h+ day,
// so a random 45–60 always satisfies it. Returns {h, m}.
function randomBreakHM() {
  const total = 45 + Math.floor(Math.random() * 16); // 45..60 inclusive
  return { h: Math.floor(total / 60), m: total % 60 };
}

// Fill the 【裁量労働制】勤務外時間数【入力】 page (srw_app_gi07). One workday per
// submission: 開始日 = 終了日 = that day, plus the break duration (gi1_62H/gi1_62M).
// The date fields reuse the same hidden-input + span pattern as the 出勤/退勤 page.
async function fillBreakEntry(state) {
  const { dates, dateIndex } = state;
  const dateStr = dates[dateIndex];
  const [yyyy, mm, dd] = dateStr.split('-');

  await delay(600);

  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
    await delay(200);
  }

  const setDate = (name, value, spanId) => {
    const hidden = document.querySelector(`input[name="${name}"]`);
    const span = document.getElementById(spanId);
    if (hidden) hidden.value = value;
    if (span) span.textContent = value;
  };
  // 開始日 and 終了日 both set to the workday (avoids spanning weekends/holidays).
  setDate('sdate_date_yyyy', yyyy, 'sdate_date_yyyy_span');
  setDate('sdate_date_mm', mm, 'sdate_date_mm_span');
  setDate('sdate_date_dd', dd, 'sdate_date_dd_span');
  setDate('edate_date_yyyy', yyyy, 'edate_date_yyyy_span');
  setDate('edate_date_mm', mm, 'edate_date_mm_span');
  setDate('edate_date_dd', dd, 'edate_date_dd_span');

  await delay(400);

  const brk = randomBreakHM();
  const hourField = document.querySelector('input[name="gi1_62H"]');
  const minField  = document.querySelector('input[name="gi1_62M"]');
  if (!hourField || !minField) {
    throw new Error('勤務外時間数の入力フィールドが見つかりません');
  }
  setFieldValue(hourField, String(brk.h));
  setFieldValue(minField, pad2(brk.m));

  await delay(300);

  const submitBtn =
    document.querySelector('input[type="submit"][value="次 へ"]') ||
    document.querySelector('input[type="submit"][value="次　へ"]') ||
    document.querySelector('input[type="submit"][value*="次"]');
  if (!submitBtn) {
    throw new Error('「次 へ」ボタンが見つかりません');
  }
  submitBtn.click();
}

function findSubmitButton(doc) {
  // Exact structure: form > center > table > tbody > tr > td:nth-child(1) > font > input[type=submit]
  const exact = doc.querySelector('form center table tbody tr td:nth-child(1) font input[type=submit]');
  if (exact) return exact;
  const byValue = doc.querySelector('input[type="submit"][value="送信"]') ||
    doc.querySelector('input[type="submit"][value*="送信"]');
  if (byValue) return byValue;
  const formCenter = doc.querySelector('form center table');
  if (formCenter) {
    const first = formCenter.querySelector('tbody tr td:first-child input[type="submit"]');
    if (first) return first;
  }
  for (const input of doc.querySelectorAll('input[type="submit"], input[type="image"]')) {
    if (input.value === '送信' || (input.value && input.value.trim() === '送信') || input.alt === '送信')
      return input;
  }
  return null;
}

async function clickSubmit() {
  // Confirmation form is in an iframe; outer frame is メインメニュー shell. Wait for iframe to load.
  const docsToSearch = () => {
    const docs = [document];
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try {
          if (window.frames[i].document && window.frames[i].document !== document)
            docs.push(window.frames[i].document);
        } catch (_) {}
      }
    } catch (_) {}
    return docs;
  };

  let submitBtn = null;
  let docUsed = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    for (const doc of docsToSearch()) {
      submitBtn = findSubmitButton(doc);
      if (submitBtn) { docUsed = doc; break; }
    }
    if (submitBtn) break;
    await delay(400);
  }

  if (!submitBtn) throw new Error('「送信」ボタンが見つかりません');

  const form = submitBtn.form;
  if (!form) {
    submitBtn.click();
    return;
  }

  const name = submitBtn.getAttribute('name');
  if (name) {
    const hidden = docUsed.createElement('input');
    hidden.type = 'hidden';
    hidden.name = name;
    hidden.value = submitBtn.value || '';
    form.appendChild(hidden);
  }
  HTMLFormElement.prototype.submit.call(form);
}

function clickReturnLink() {
  const links = document.querySelectorAll('a');
  for (const link of links) {
    if (link.textContent.includes('就労メインページへ戻る')) {
      link.click();
      return;
    }
  }
  // Broader fallback: any link mentioning 就労メインページ
  for (const link of links) {
    if (link.textContent.includes('就労メインページ')) {
      link.click();
      return;
    }
  }
  // Last resort: navigate directly
  window.location.href = 'https://ut-ppsweb.adm.u-tokyo.ac.jp/cws/cws';
}

// ── Progress Calculation ──────────────────────────────────────────────────────
// Each workday is 3 entries: 出勤 → 退勤 → 勤務外時間数（休憩）.
const ENTRIES_PER_DAY = 3;
function phaseOffset(state) {
  return state.phase === 'clockin' ? 0 : state.phase === 'clockout' ? 1 : 2;
}
function calcProgress(state) {
  if (Array.isArray(state.taskPhases)) {
    return Math.round(((state.dateIndex || 0) / Math.max(1, state.dates.length)) * 100);
  }
  const totalEntries = state.dates.length * ENTRIES_PER_DAY;
  const completed = (state.dateIndex * ENTRIES_PER_DAY) + phaseOffset(state);
  return Math.round((completed / totalEntries) * 100);
}

function progressText(state) {
  const phaseLabel = state.phase === 'clockin' ? '自己申告記録（出勤）'
    : state.phase === 'clockout' ? '自己申告記録（退勤）'
    : '勤務外時間数（休憩）';
  const dateStr = state.dates[state.dateIndex];
  const planned = Array.isArray(state.taskPhases);
  const current = planned ? state.dateIndex + 1 : (state.dateIndex * ENTRIES_PER_DAY) + phaseOffset(state) + 1;
  const total = planned ? state.dates.length : state.dates.length * ENTRIES_PER_DAY;
  return `${phaseLabel}：${dateStr}（${current}/${total}）`;
}

// ── Advance State ─────────────────────────────────────────────────────────────
// Returns the next state, or null if all entries are done.
function advanceState(state) {
  const hoursModel = globalThis.HRTermHours;
  if (Array.isArray(state.taskPhases) && hoursModel &&
      typeof hoursModel.advancePlannedEntryState === 'function') {
    return hoursModel.advancePlannedEntryState(state);
  }
  const next = { ...state, config: { ...state.config } };

  if (state.phase === 'clockin')  { next.phase = 'clockout'; return next; }
  if (state.phase === 'clockout') { next.phase = 'break';    return next; }

  // Finished this day (after 勤務外時間数) — move to the next day's 出勤.
  next.phase = 'clockin';
  next.dateIndex = state.dateIndex + 1;

  if (next.dateIndex >= state.dates.length) {
    return null; // All done
  }

  return next;
}

// ── State Machine ─────────────────────────────────────────────────────────────
// Runs on every page load. Reads state from session storage, detects current
// page, and takes the appropriate action. State advances on the success page
// (after 送信 completes) to keep progress text accurate on confirm/success.

async function runStateMachine() {
  if (!extensionAlive()) return; // orphaned after an extension reload — do nothing
  let result;
  try {
    result = await chrome.storage.session.get(['hrAutoState', 'hrScanActive', 'hrSubmitState']);
  } catch { return; }

  if (result.hrScanActive) {
    // Stand down while a popup-driven scan is running — but self-heal if a closed
    // popup left the flag stuck (no/old timestamp), so automation never wedges.
    let since = null;
    try { since = (await chrome.storage.session.get('hrScanStartedAt')).hrScanStartedAt; } catch {}
    if (since && Date.now() - since < 120000) return;
    try { await chrome.storage.session.remove(['hrScanActive', 'hrScanStartedAt']); } catch {}
  }

  const state = result.hrAutoState;
  if (!state) {
    // No clockin/clockout entry in progress — drive the 月次申請 machine if active.
    if (result.hrSubmitState) {
      await delay(1200);
      if (shouldStop) { clearSubmit(); return; }
      await runSubmitStateMachine(result.hrSubmitState);
    }
    return;
  }

  // Delay to let page settle (longer for iframe-based pages)
  await delay(1200);

  if (shouldStop) {
    safeSessionRemove('hrAutoState');
    return;
  }

  const page = detectPage();
  const percent = calcProgress(state);

  try {
    switch (page) {
      case 'clockin-input':
      case 'clockout-input':
      case 'break-input': {
        const expectedPage = state.phase === 'clockin' ? 'clockin-input'
          : state.phase === 'clockout' ? 'clockout-input' : 'break-input';
        if (page !== expectedPage) {
          // Wrong page — go back to pick the right one
          navigateToApplicationMenu();
          return;
        }
        sendProgress(progressText(state), percent);
        if (state.phase === 'break') await fillBreakEntry(state);
        else await fillDateAndTime(state);
        // State does NOT advance here — it advances on the success page
        break;
      }

      case 'confirm': {
        sendProgress(progressText(state) + '\n送信中...', percent);
        await delay(1500); // Wait for confirmation iframe to fully render
        await clickSubmit();
        break;
      }

      case 'success': {
        // Current entry is done. Advance state.
        const nextState = advanceState(state);
        if (nextState) {
          safeSessionSet({ hrAutoState: nextState });
          sendProgress(progressText(nextState), calcProgress(nextState));
          clickReturnLink();
        } else {
          // All entries complete
          await chrome.storage.session.remove('hrAutoState');
          const pendingSubmit = (await chrome.storage.session.get('hrSubmitState')).hrSubmitState;
          if (pendingSubmit && pendingSubmit.phase === 'submit-entering') {
            await chrome.storage.session.set({
              hrSubmitState: { ...pendingSubmit, phase: 'submit-nav' }
            });
            sendProgress(`${formatMonthLabel(pendingSubmit.targetMonth)}：入力結果を勤務表で再確認中...`, submitPercent(pendingSubmit, 60));
            clickReturnLink();
          } else {
            const uniqueDays = new Set(state.dates).size;
            const entryCount = Array.isArray(state.taskPhases) ? state.taskPhases.length : state.dates.length * 3;
            sendDone(`${uniqueDays}勤務日の未入力記録の登録が完了しました（${entryCount}件）。`);
          }
        }
        break;
      }

      case 'application-menu': {
        sendProgress(progressText(state) + '\n入力画面を表示中...', percent);
        clickApplicationLink(state.phase);
        break;
      }

      case 'other':
      default: {
        sendProgress('就労申請ページへ移動中...', percent);
        navigateToApplicationMenu();
        break;
      }
    }
  } catch (err) {
    console.error('[HR Auto-Fill] Error:', err);
    safeSessionRemove('hrAutoState');
    sendError(err.message);
  }
}

// ── Workday calendar scan (本人用実績入力) ──────────────────────────────────────
function getAccessibleDocuments() {
  const docs = [];
  const seen = new Set();

  const visit = (win) => {
    if (!win || seen.has(win)) return;
    seen.add(win);

    try {
      if (win.document) docs.push(win.document);
      for (let i = 0; i < win.frames.length; i++) {
        visit(win.frames[i]);
      }
    } catch (_) {}
  };

  visit(window);
  return docs;
}

function normalizeNavText(text) {
  return (text || '').replace(/\s+/g, '').trim();
}

function getNavigationText(el) {
  if (!el) return '';
  if (el.tagName === 'INPUT') {
    return normalizeNavText(el.value || el.getAttribute('aria-label') || el.title || '');
  }
  return normalizeNavText(
    el.textContent ||
    el.innerText ||
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    ''
  );
}

function getNavigationElements() {
  const selector = 'a[href], button, input[type="button"], input[type="submit"], [role="button"], [onclick]';
  return getAccessibleDocuments().flatMap(doc => Array.from(doc.querySelectorAll(selector)));
}

function findNavigationElement(matchFn) {
  return getNavigationElements().find(el => {
    try {
      return matchFn(el, getNavigationText(el));
    } catch {
      return false;
    }
  }) || null;
}

function findLinkBySelectorOrHref(selector, href) {
  for (const doc of getAccessibleDocuments()) {
    const bySelector = doc.querySelector(selector);
    if (bySelector && (!href || bySelector.getAttribute('href') === href)) {
      return bySelector;
    }
  }

  return findNavigationElement(el => el.tagName === 'A' && el.getAttribute('href') === href);
}

function isMainWorkMenuContext() {
  return getAccessibleDocuments().some(doc => {
    const title = normalizeNavText(doc.title || '');
    const body = normalizeNavText(doc.body ? doc.body.textContent || '' : '');
    return title.includes('就労管理') || body.includes('就労管理');
  });
}

function isPerformanceMenuContext() {
  return getAccessibleDocuments().some(doc => {
    const title = normalizeNavText(doc.title || '');
    const body = normalizeNavText(doc.body ? doc.body.textContent || '' : '');
    return (title.includes('本人用実績') || body.includes('本人用実績')) &&
      !title.includes('本人用実績入力') &&
      !body.includes('本人用実績入力');
  });
}

function activateElement(el) {
  if (!el) return false;

  if (typeof el.click === 'function') {
    el.click();
    return true;
  }

  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (view && typeof view.MouseEvent === 'function') {
    el.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, view }));
    return true;
  }

  return false;
}

function getWorkdayCalendarDocument() {
  return getAccessibleDocuments().find(doc => {
    return doc.querySelector('#BTNLOAD') &&
      doc.querySelector('#grdLoadDailyTarget > tbody > tr > td:nth-child(2) > select');
  }) || null;
}

function isWorkdayCalendarPage() {
  return !!getWorkdayCalendarDocument();
}

async function getWorkdayScanNavStep() {
  try {
    const result = await chrome.storage.session.get('hrScanNavStep');
    return result.hrScanNavStep || null;
  } catch {
    return null;
  }
}

async function setWorkdayScanNavStep(step) {
  try {
    await chrome.storage.session.set({ hrScanNavStep: step });
  } catch {}
}

async function clearWorkdayScanNavStep() {
  try {
    await chrome.storage.session.remove('hrScanNavStep');
  } catch {}
}

// Find an <a> whose (whitespace-stripped) text satisfies pred.
function findLinkByTextPred(pred) {
  return findNavigationElement((el, t) => el.tagName === 'A' && pred(t));
}

/** Navigate toward 本人用実績入力 by LINK TEXT — robust to the site's changing @FN
 *  session tokens and nth-child layout (the hardcoded href/selector approach broke
 *  when @FN changed). Path: 勤務表 →(就労メインページ)→ 本人用メニュー →(本人用実績)→
 *  本人用実績 →(本人用実績入力)→ カレンダー. Stateless: each call clicks the deepest
 *  link present on the current page, so it converges regardless of where it starts.
 *  Every branch performs a real navigation (clicked:true) → the state machine
 *  re-enters on the resulting page load. */
async function clickWorkdayCalendarLink() {
  const navigationAction = HRNavigation.chooseWorkdayNavigationAction(
    getNavigationElements().map(getNavigationText).filter(Boolean),
    isWorkdayCalendarPage()
  );

  if (navigationAction === 'ready') {
    await clearWorkdayScanNavStep();
    return { ready: true };
  }

  if (navigationAction === 'work-menu-unavailable') {
    return {
      navigating: true,
      clicked: false,
      step: '本人用実績入力はこのアカウントの就労管理メニューにありません',
      waitMs: 1000
    };
  }

  const actionDetails = {
    input: {
      matches: t => t.includes('本人用実績入力'),
      step: '本人用実績入力へ移動中...'
    },
    performance: {
      matches: t => t.includes('本人用実績') && !t.includes('本人用実績入力'),
      step: '本人用実績メニューへ移動中...'
    },
    menu: {
      matches: t => t.includes('就労メインページ') || t.includes('本人用メニュー') || t.includes('メインページ'),
      step: '就労メインページへ移動中...'
    },
    work: {
      matches: t => t === '就労管理',
      step: '就労管理へ移動中...'
    }
  }[navigationAction];
  const link = actionDetails && findLinkByTextPred(actionDetails.matches);
  if (link && activateElement(link)) {
    return { navigating: true, clicked: true, step: actionDetails.step, waitMs: 1500 };
  }

  // No recognizable navigation link — reload the main CWS page and retry.
  window.location.href = MAIN_CWS_URL;
  return { navigating: true, clicked: true, step: '就労メインページへ移動中...', waitMs: 1800 };
}

function fireEvent(el, eventName) {
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  const EventCtor = (view && view.Event) || Event;
  el.dispatchEvent(new EventCtor(eventName, { bubbles: true, cancelable: false }));
}

/**
 * Extract workday dates from 平日 cells in the current calendar view.
 * Returns array of "yyyy-mm-dd" strings.
 */
function extractWorkdayDatesFromCalendar(doc, yyyy, mm) {
  const dates = [];
  const ddSet = new Set();

  for (const td of doc.querySelectorAll('td')) {
    const text = (td.innerText || td.textContent || '').trim();
    if (!text.includes('平日')) continue;

    const dayMatch = text.match(/(\d{1,2})\s*平日/) || text.match(/^(\d{1,2})\b/);
    if (!dayMatch) continue;

    const dd = parseInt(dayMatch[1], 10);
    if (dd < 1 || dd > 31) continue;
    if (ddSet.has(dd)) continue;
    ddSet.add(dd);

    const ddStr = String(dd).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${ddStr}`);
  }

  return dates.sort();
}

async function loadMonthForWorkdays(monthKey) {
  const [yyyy, mm] = monthKey.split('-');
  const MONTH_SEL = '#grdLoadDailyTarget > tbody > tr > td:nth-child(2) > select';
  const sel = await waitForPredicate(
    () => {
      const doc = getWorkdayCalendarDocument();
      return doc ? doc.querySelector(MONTH_SEL) : null;
    },
    12000,
    `要素が見つかりません: ${MONTH_SEL}`
  );

  const match = Array.from(sel.options).find(o => extractMonthKeyFromOption(o) === monthKey);
  if (!match) {
    const available = Array.from(sel.options)
      .map(o => `"${o.text.trim()}" (${o.value})`)
      .slice(0, 12)
      .join(', ');
    throw new Error(`月「${monthKey}」がドロップダウンに見つかりません。候補: ${available}`);
  }

  const calendarDoc = sel.ownerDocument;
  const currentOption = sel.options[sel.selectedIndex] || null;
  if (extractMonthKeyFromOption(currentOption) === monthKey) {
    return extractWorkdayDatesFromCalendar(calendarDoc, yyyy, mm);
  }

  const prevCheckbox = calendarDoc.querySelector('#CHKMODGI0');
  sel.value = match.value;
  fireEvent(sel, 'change');
  await delay(300);

  const loadBtn = await waitForPredicate(
    () => {
      const doc = getWorkdayCalendarDocument();
      return doc ? doc.querySelector('#BTNLOAD') : null;
    },
    8000,
    '要素が見つかりません: #BTNLOAD'
  );
  loadBtn.click();

  if (prevCheckbox) {
    const deadline = Date.now() + 3000;
    await new Promise(resolve => {
      const poll = () => {
        if (!prevCheckbox.isConnected || Date.now() >= deadline) resolve();
        else setTimeout(poll, 100);
      };
      poll();
    });
  }

  try {
    await waitForPredicate(
      () => {
        const doc = getWorkdayCalendarDocument();
        return doc ? doc.querySelector('#CHKMODGI0') : null;
      },
      12000,
      '要素が見つかりません: #CHKMODGI0'
    );
  } catch {
    throw new Error(`${monthKey} のカレンダーの読み込みがタイムアウトしました`);
  }
  await delay(600);

  const currentDoc = getWorkdayCalendarDocument();
  if (!currentDoc) {
    throw new Error('本人用実績入力のカレンダーが見つかりません');
  }

  return extractWorkdayDatesFromCalendar(currentDoc, yyyy, mm);
}

function formatMonthLabel(monthKey) {
  const [yyyy, mm] = monthKey.split('-');
  return `${yyyy}年${parseInt(mm, 10)}月`;
}

function normalizeDigits(text) {
  return (text || '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function extractMonthKey(text) {
  const normalized = normalizeDigits(text).replace(/\s+/g, '');
  const patterns = [
    /(\d{4})[\/.-](\d{1,2})/,
    /(\d{4})年(\d{1,2})月/,
    /(\d{4}).*?(\d{1,2})月/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const yyyy = match[1];
    const mm = String(parseInt(match[2], 10)).padStart(2, '0');
    if (Number.isNaN(parseInt(mm, 10))) continue;
    return `${yyyy}-${mm}`;
  }

  return null;
}

function extractMonthKeyFromOption(option) {
  if (!option) return null;

  const value = option.value || '';
  const valueMatch = value.match(/^(\d{4}-\d{2})-\d{2}_\d{4}-\d{2}-\d{2}$/);
  if (valueMatch) return valueMatch[1];

  return extractMonthKey(option.text || '');
}

async function scanWorkdaysForMonths(months) {
  const result = {};
  const total = months.length;
  for (let i = 0; i < total; i++) {
    const monthKey = months[i];
    const label = formatMonthLabel(monthKey);
    const percent = total <= 1 ? 50 : Math.round(15 + (75 * (i + 1) / total));
    sendProgress(`${label}の本人用実績入力で対象期間を表示し、勤務表の平日を確認中 (${i + 1}/${total})`, percent);

    const dates = await loadMonthForWorkdays(monthKey);
    result[monthKey] = dates;
  }
  sendProgress('本人用実績入力での勤務表の平日確認が完了しました', 95);
  return result;
}

async function scanWorkdaysForMonth(monthKey) {
  return loadMonthForWorkdays(monthKey);
}

// ── 月次申請 (monthly report submission) ───────────────────────────────────────
// Reaches the 勤務表 page, reads which past months still need 月次申請, and — after
// the existing engine fills any missing 平日 hours — submits via the 月次申請 button.
//
// TERM_SUBMIT_DRY_RUN gates the irreversible 月次申請 click. When true, the whole flow
// runs end-to-end but stops just before clicking 月次申請 (logs instead). Now LIVE
// (false): #BTNSBMT0 → confirm page → #btnExec0「確定」 are clicked for real.
// Success is detected by the target month becoming non-submittable after commit.
const TERM_SUBMIT_DRY_RUN = false;
const MAX_TERM_LOOKBACK = 12;

// 勤務表 navigation works by link text (confirmed on the live site).
function findLinkByText(text) {
  const target = normalizeNavText(text);
  return findNavigationElement(el => el.tagName === 'A' && normalizeNavText(el.textContent) === target);
}

function getTermForm() {
  for (const doc of getAccessibleDocuments()) {
    try { const f = doc.forms && doc.forms['FormListPersonalDetails']; if (f) return f; } catch (_) {}
  }
  return null;
}
function isTermPage() { return !!getTermForm(); }
function getTermEl(id) {
  for (const doc of getAccessibleDocuments()) {
    try { const el = doc.getElementById(id); if (el) return el; } catch (_) {}
  }
  return null;
}
// The header/nav band that holds "本日は…", the YYYY年MM月 label, and ＜＜ / ＞＞.
function getTermNavText() {
  const prev = getTermEl('TOPRVTM');
  if (!prev) return '';
  let anc = prev;
  for (let k = 0; k < 6 && anc; k++) anc = anc.parentElement;
  return normalizeDigits(anc ? (anc.textContent || '') : '').replace(/\s+/g, '');
}
// Displayed month = the last YYYY年MM月 token BEFORE ＜＜ (the nav text also
// contains "本日は…" = today, so a naive first-match would be wrong).
function readDisplayedTermMonth() {
  const nav = getTermNavText();
  if (nav) {
    const left = nav.split('＜＜')[0];
    const ms = [...left.matchAll(/(\d{4})年(\d{1,2})月/g)];
    if (ms.length) {
      const m = ms[ms.length - 1];
      return `${m[1]}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
    }
  }
  const form = getTermForm();
  if (form) {
    const ft = normalizeDigits(form.textContent || '').replace(/\s+/g, '');
    const r = ft.match(/(\d{4})年(\d{1,2})月\d{1,2}日[^～]*～/);
    if (r) return `${r[1]}-${String(parseInt(r[2], 10)).padStart(2, '0')}`;
  }
  return null;
}
function currentMonthKey() {
  const nav = getTermNavText();
  const m = nav.match(/本日は(\d{4})年(\d{1,2})月/);
  if (m) return `${m[1]}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// A month is submittable iff the 月次申請 button is present and enabled (confirmed:
// closed/past months have no button; the actionable month does).
function isMonthSubmittable() {
  const btn = getTermEl('BTNSBMT0');
  return !!btn && !btn.disabled;
}
function monthDelta(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (ay * 12 + am) - (by * 12 + bm);
}
// Locate the daily 勤務表 table + the 自己申告記録（出勤/退勤）column indices by header text.
function detectTermTable() {
  const form = getTermForm();
  if (!form) return null;
  for (const t of form.querySelectorAll('table')) {
    for (const r of Array.from(t.rows).slice(0, 3)) {
      const hs = Array.from(r.cells).map(c => normalizeNavText(c.textContent));
      const inCol = hs.findIndex(x => x.indexOf('自己申告記録（出勤') !== -1);
      if (inCol !== -1) {
        const outCol = hs.findIndex(x => x.indexOf('自己申告記録（退勤') !== -1);
        const breakCol = hs.findIndex(x => x.indexOf('勤務外時間数') !== -1);
        return {
          table: t,
          inCol,
          outCol: outCol !== -1 ? outCol : inCol + 1,
          breakCol: breakCol !== -1 ? breakCol : null
        };
      }
    }
  }
  return null;
}
// The live 勤務表 already classifies every date cell. mg_normal is a scheduled
// workday; Saturday, Sunday, and public holidays use distinct mg_dh_* classes.
// Reuse that authoritative table instead of the unavailable 本人用実績 calendar.
function detectScheduledWorkdays(monthKey) {
  const info = detectTermTable();
  if (!info) return { dates: [], error: '勤務表の勤務時間表が見つかりません' };
  const hoursModel = globalThis.HRTermHours;
  if (!hoursModel || typeof hoursModel.findScheduledWorkdays !== 'function') {
    return { dates: [], error: '勤務日の安全判定モデルを読み込めませんでした' };
  }
  const rowFacts = [];
  for (const row of info.table.rows) {
    const cells = row.cells;
    if (!cells.length) continue;
    const d0 = normalizeDigits(cells[0].textContent || '').trim();
    if (d0.indexOf('月日') !== -1 || d0.indexOf('曜日') !== -1) continue;
    const md = d0.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    const d2 = !md && d0.match(/(\d{1,2})日/);
    const day = md ? parseInt(md[2], 10) : (d2 ? parseInt(d2[1], 10) : null);
    if (day == null || day < 1 || day > 31) continue;
    rowFacts.push({ day, dayClass: cells[0].className || '' });
  }
  return { dates: hoursModel.findScheduledWorkdays(monthKey, rowFacts) };
}

function scheduledWorkdaysMessage(monthKey, dates) {
  const compactDates = dates.map(date => {
    const parts = date.split('-');
    return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
  }).join('、');
  const suffix = compactDates ? `（${compactDates}）` : '';
  return `${formatMonthLabel(monthKey)}：対象勤務日を${dates.length}日確認しました${suffix}。`;
}

async function scanTermWorkdaysStep(monthKey) {
  if (!isTermPage()) return prepareTermPage();
  const current = readDisplayedTermMonth();
  if (!current) return { error: '勤務表の対象月を読み取れませんでした' };
  if (current !== monthKey) {
    const goBack = monthDelta(monthKey, current) < 0;
    const btn = goBack ? getTermEl('TOPRVTM') : getTermEl('TONXTTM');
    if (!btn) return { error: `${formatMonthLabel(monthKey)}へ移動できませんでした` };
    activateElement(btn);
    return { navigating: true, step: `${formatMonthLabel(monthKey)}の勤務表へ移動中...`, waitMs: 1500 };
  }
  const result = detectScheduledWorkdays(monthKey);
  if (result.error) return { error: result.error };
  return { monthKey, dates: result.dates };
}
// Given the month's 平日 (yyyy-mm-dd, from the existing workday scan), report which
// of them still lack times in the 勤務表 (time format is HH時MM分). Header rows are
// repeated mid-table, so skip any row whose first cell is 月日/曜日.
function detectHoursComplete(workdays) {
  const info = detectTermTable();
  if (!info) return { complete: false, missing: [], error: '勤務表の勤務時間表が見つかりません' };
  const hoursModel = globalThis.HRTermHours;
  if (!hoursModel || typeof hoursModel.planMissingEntries !== 'function') {
    return { complete: false, missing: [], error: '勤務時間の安全判定モデルを読み込めませんでした' };
  }
  const { table, inCol, outCol, breakCol } = info;
  const timeRe = /\d{1,2}時\d{1,2}分/;
  const breakRe = /(?:\d{1,2}:\d{2}|\d{1,2}時\d{1,2}分)/;
  const rowFacts = [];
  for (const row of table.rows) {
    const cells = row.cells;
    if (cells.length <= Math.max(inCol, outCol, breakCol == null ? 0 : breakCol)) continue;
    const d0 = normalizeDigits(cells[0].textContent || '').trim();
    if (d0.indexOf('月日') !== -1 || d0.indexOf('曜日') !== -1) continue;
    let dd = null;
    const md = d0.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (md) dd = parseInt(md[2], 10);
    else { const d2 = d0.match(/(\d{1,2})日/); if (d2) dd = parseInt(d2[1], 10); }
    if (dd == null || dd < 1 || dd > 31) continue;
    const inT = normalizeDigits(cells[inCol].textContent || '');
    const outT = normalizeDigits(cells[outCol].textContent || '');
    const breakT = breakCol == null ? '' : normalizeDigits(cells[breakCol].textContent || '');
    rowFacts.push({
      day: dd,
      hasArrival: timeRe.test(inT),
      hasDeparture: timeRe.test(outT),
      hasBreak: breakCol == null ? undefined : breakRe.test(breakT),
      rowText: normalizeDigits(row.textContent || '')
    });
  }
  const tasks = hoursModel.planMissingEntries(workdays, rowFacts);
  const missing = Array.from(new Set(tasks.map(task => task.date)));
  return { complete: tasks.length === 0, missing, tasks };
}

// Read a month's approval status from the 【処理状況】 table (located by its header
// cells 担当者/結果/処理日/コメント). The 結果 column is authoritative:
//   no rows → 'none' (not submitted); any 差戻 → 'returned';
//   any 未処理 → 'pending' (submitted, awaiting approval); all 承認 → 'approved'.
function readTermApprovalStatus() {
  const form = getTermForm();
  if (!form) return 'unknown';
  let table = null, resIdx = -1;
  for (const t of form.querySelectorAll('table')) {
    for (const r of Array.from(t.rows).slice(0, 2)) {
      const cs = Array.from(r.cells).map(c => normalizeNavText(c.textContent));
      if (cs.indexOf('担当者') !== -1 && cs.indexOf('結果') !== -1 && cs.indexOf('処理日') !== -1) {
        table = t; resIdx = cs.indexOf('結果'); break;
      }
    }
    if (table) break;
  }
  if (!table) return 'none';
  const results = [];
  for (const row of table.rows) {
    const c = row.cells[resIdx];
    if (!c) continue;
    const v = normalizeNavText(c.textContent);
    if (!v || v === '結果') continue;
    results.push(v);
  }
  if (!results.length) return 'none';
  if (results.some(v => v.indexOf('差戻') !== -1)) return 'returned';
  if (results.some(v => v.indexOf('未処理') !== -1)) return 'pending';
  if (results.every(v => v.indexOf('承認') !== -1)) return 'approved';
  return 'pending';
}

function monthMinus(monthKey, n) {
  let [y, m] = monthKey.split('-').map(Number);
  m -= n;
  while (m <= 0) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// The 月次申請 was rejected because the previous period isn't finally approved.
function isPrevApprovalBlocked() {
  const form = getTermForm();
  if (!form) return false;
  return normalizeDigits(form.textContent || '').indexOf('最終承認されていないため送信できません') !== -1;
}

// The 勤務表 shows 「{前期間}の勤務実績は、最終承認されています。」 when the previous month
// is approved — a passive, same-page confirmation that this month is unblocked.
function isPrevApprovedOnTermPage() {
  const form = getTermForm();
  if (!form) return false;
  return normalizeDigits(form.textContent || '').indexOf('最終承認されています') !== -1;
}

// Passively report the 勤務表's submit-readiness to the background so the toolbar badge
// and the one-time "ready" notification work even with the side panel closed. Read-only,
// and skipped while any automation/scan is running so it never interferes.
async function reportTermObservation() {
  if (!extensionAlive() || !isTermPage()) return;
  let st;
  try { st = await chrome.storage.session.get(['hrSubmitState', 'hrAutoState', 'hrScanActive']); }
  catch { return; }
  if (st.hrSubmitState || st.hrAutoState || st.hrScanActive) return;
  const month = readDisplayedTermMonth();
  if (!month) return;
  try {
    chrome.runtime.sendMessage({
      type: 'TERM_OBSERVED',
      month,
      label: formatMonthLabel(month),
      submittable: isMonthSubmittable(),
      approval: readTermApprovalStatus(),
      prevMonth: monthMinus(month, 1),
      prevApproved: isPrevApprovedOnTermPage(),
    });
  } catch (_) {}
}

// When a current-month 勤務表 is already complete, the extension itself records that
// authoritative live observation even if the entry worker previously timed out while
// returning to this page. This also replaces any stale running progress with DONE.
async function reportCurrentMonthHoursCompletion() {
  if (!extensionAlive() || !isTermPage()) return;
  const month = readDisplayedTermMonth();
  if (!month || month !== currentMonthKey()) return;

  const scheduled = detectScheduledWorkdays(month);
  if (scheduled.error) return;
  const result = detectHoursComplete(scheduled.dates);
  if (result.error || !result.complete) return;

  const completionModel = globalThis.HRTermHours;
  if (!completionModel || typeof completionModel.completedHoursMessage !== 'function') return;
  const message = completionModel.completedHoursMessage(month, scheduled.dates.length);
  const recorded = await emitTermHistoryEvent(month, 'hours-complete', 'hours-complete', message);
  if (!recorded) return;
  try {
    await chrome.storage.session.set({
      hrAutoProgress: { running: false, done: true, text: message }
    });
  } catch (_) {}
}

// Navigate toward the 勤務表: メインメニュー → 就労管理(text) → 勤務表(text).
// Returns the popup-poll shape: { ready } | { navigating, step, waitMs }.
async function prepareTermPage() {
  if (isTermPage()) return { ready: true };
  const termLink = findLinkByText('勤務表');
  if (termLink) { activateElement(termLink); return { navigating: true, step: '勤務表へ移動中...', waitMs: 1500 }; }
  const workLink = findLinkByText('就労管理');
  if (workLink) { activateElement(workLink); return { navigating: true, step: '就労管理へ移動中...', waitMs: 1500 }; }
  window.location.href = MAIN_CWS_URL;
  return { navigating: true, step: 'メインメニューへ移動中...', waitMs: 1800 };
}

// One resumable step of the backward status walk (driven by the popup across the
// full-page reloads that ＜＜ triggers). Records each month's submittable flag and
// stops at the first PAST month whose 月次申請 button is gone (window closed), at the
// lookback ceiling, or — the usual case — as soon as the next month back is already
// confirmed 最終承認済み, since 承認 is terminal and cannot change.
async function termScanStep(confirmedMonths) {
  if (!isTermPage()) return { navigating: true, step: '勤務表の読み込み待ち...', waitMs: 1000 };
  const month = readDisplayedTermMonth();
  if (!month) return { error: '勤務表の対象月を読み取れませんでした' };
  const current = currentMonthKey();
  const r = await chrome.storage.session.get('hrTermScan');
  const scan = r.hrTermScan || { collected: {}, steps: 0 };
  // The confirmed set arrives with the first step only; keep it in session storage so
  // it survives the full-page reloads that ＜＜ triggers.
  if (Array.isArray(confirmedMonths) && confirmedMonths.length) scan.confirmed = confirmedMonths;
  const confirmed = Array.isArray(scan.confirmed) ? scan.confirmed : [];

  // A month already confirmed 最終承認済み can never change — don't even read it.
  if (confirmed.indexOf(month) === -1) {
    scan.collected[month] = { month, label: formatMonthLabel(month), submittable: isMonthSubmittable(), approval: readTermApprovalStatus() };
    if (isPrevApprovedOnTermPage()) {
      const previousMonth = monthMinus(month, 1);
      scan.collected[previousMonth] = Object.assign({}, scan.collected[previousMonth], {
        month: previousMonth,
        label: formatMonthLabel(previousMonth),
        submittable: false,
        approval: 'approved'
      });
    }
  }
  scan.steps = (scan.steps || 0) + 1;

  const model = globalThis.HRStatusModel;
  const decision = model && typeof model.termScanShouldStop === 'function'
    ? model.termScanShouldStop({
        month,
        current,
        submittable: scan.collected[month] ? scan.collected[month].submittable : false,
        steps: scan.steps,
        maxSteps: MAX_TERM_LOOKBACK,
        confirmedMonths: confirmed
      })
    : { stop: (monthDelta(month, current) < 0 && !(scan.collected[month] || {}).submittable) || scan.steps >= MAX_TERM_LOOKBACK };
  if (decision.stop) {
    await chrome.storage.session.remove('hrTermScan');
    return { done: true, months: scan.collected, current };
  }
  await chrome.storage.session.set({ hrTermScan: scan });
  const prev = getTermEl('TOPRVTM');
  if (!prev) {
    await chrome.storage.session.remove('hrTermScan');
    return { done: true, months: scan.collected, current };
  }
  activateElement(prev);
  return { navigating: true, step: `${formatMonthLabel(month)}を確認中...`, waitMs: 1500 };
}

// ── Submission state machine (persistent, parallel to clockin/clockout) ─────────
function labelOf(sub) { return formatMonthLabel(sub.targetMonth); }
function submitPercent(sub, intra) {
  const total = (sub.queue && sub.queue.length) || 1;
  const done = sub.queueIndex || 0;
  return Math.min(99, Math.round(((done + intra / 100) / total) * 100));
}
async function updateSubmit(sub, patch) {
  const next = { ...sub, ...patch };
  await chrome.storage.session.set({ hrSubmitState: next });
  return next;
}
function clearSubmit() {
  safeSessionRemove('hrSubmitState');
  safeSessionRemove('hrAutoState');
  safeSessionRemove('hrTermScan');
}

// Stop a submission. In unattended auto mode an expected no-op (e.g. the month is
// already submitted / out of window) is silent; a manual run shows the message.
async function abortSubmit(sub, message) {
  if (sub && sub.auto) {
    await setTerminalAutoProgress({ running: false, done: true, noOp: true, text: message });
    return;
  }
  await setTerminalAutoProgress({ running: false, error: true, message });
  sendToPopup({ type: 'ERROR', message });
}
// Provisional — confirm/success pages not yet verified live (only used when not DRY_RUN).
// The 月次申請 confirmation page = form `FormConfirmPersonalTermSubmission` + `#btnExec0`「確定」.
function isTermConfirmPage() {
  for (const doc of getAccessibleDocuments()) {
    try {
      if (doc.forms && doc.forms['FormConfirmPersonalTermSubmission']) return true;
      if (doc.getElementById('btnExec0')) return true;
    } catch (_) {}
  }
  return false;
}
function findTermConfirmButton() {
  // Confirm page commits via `#btnExec0`「確定」(onclick → ExecutePersonalTermSubmissionAction).
  // No password / 再認証 is required. (Button id/form known from the page; the post-commit
  // success page is the only piece still unobserved.)
  const exact = getTermEl('btnExec0');
  if (exact && !exact.disabled) return exact;
  for (const doc of getAccessibleDocuments()) {
    const cand = Array.from(doc.querySelectorAll('input[type="button"],input[type="submit"],button')).find(b => {
      const v = normalizeNavText(b.value || b.textContent || '');
      return /確定|確認|送信|申請する|はい|OK/.test(v) &&
        v.indexOf('戻') === -1 && v.indexOf('月次申請前') === -1 && v !== '月次申請';
    });
    if (cand) return cand;
  }
  return findSubmitButton(document);
}
// Post-commit success page VERIFIED (2026-06-02): the 勤務表 reloads with a <marquee>
// reading 「{期間}の勤務実績を提出しました。」 and the 月次申請 button gone. Either the
// 提出しました text or the month becoming non-submittable confirms the commit.
function detectTermSubmissionSuccess(month) {
  if (isTermConfirmPage()) return false; // still on the confirm page → not committed yet
  const txt = getAccessibleDocuments().map(d => normalizeNavText(d.body ? d.body.textContent : '')).join('');
  if (/勤務実績を提出しました|提出しました|申請しました|受け付けました|申請を受付|正常に処理/.test(txt)) return true;
  // Fallback: back on the 勤務表 for that month and no longer submittable ⟺ submitted.
  return isTermPage() && readDisplayedTermMonth() === month && !isMonthSubmittable();
}
async function markTermSubmitted(month) {
  try {
    const r = await chrome.storage.local.get(['hrTermStatusCache', 'hrPendingSubmit', 'hrUserActionRequired']);
    const cache = r.hrTermStatusCache || { months: {} };
    if (!cache.months) cache.months = {};
    cache.months[month] = {
      ...(cache.months[month] || {}), month, submittable: false, submitted: true, approval: 'pending',
      fresh: true, stale: false, staleFallback: false, source: 'live'
    };
    const updates = { hrTermStatusCache: cache };
    if (r.hrPendingSubmit && r.hrPendingSubmit.targetMonth === month) updates.hrPendingSubmit = null;
    if (r.hrUserActionRequired && r.hrUserActionRequired.month === month) updates.hrUserActionRequired = null;
    await chrome.storage.local.set(updates);
  } catch (_) {}
  emitTermHistoryEvent(month, 'submitted', 'submitted-pending', `${formatMonthLabel(month)}分を提出しました。`);
  // A pending background retry for this month is now satisfied (and was cleared
  // atomically with the confirmed cache observation above).
  try { chrome.runtime.sendMessage({ type: 'TERM_CLEAR_RETRY' }); } catch (_) {}
  // The month is no longer "ready" — refresh the toolbar badge / notification state.
  try { chrome.runtime.sendMessage({ type: 'TERM_READY_RECOMPUTE' }); } catch (_) {}
}
// Previous period not finally approved → can't submit yet. Persist a pending record
// (storage.local), ask the background to schedule the daily retry + notify, and stop.
async function handleTermBlocked(sub, prevMonth, prevApproval) {
  const pending = {
    queue: sub.queue, queueIndex: sub.queueIndex || 0, targetMonth: sub.targetMonth,
    prevMonth, prevApproval, config: sub.config, workdaysByMonth: sub.workdaysByMonth || {},
    since: Date.now(), notified: false,
  };
  try {
    const { hrUserActionRequired } = await chrome.storage.local.get('hrUserActionRequired');
    const updates = { hrPendingSubmit: pending };
    if (hrUserActionRequired && hrUserActionRequired.month === sub.targetMonth) updates.hrUserActionRequired = null;
    await chrome.storage.local.set(updates);
  } catch (_) {}
  try { chrome.runtime.sendMessage({ type: 'TERM_SCHEDULE_RETRY' }); } catch (_) {}
  const message = `${formatMonthLabel(sub.targetMonth)} は前月（${formatMonthLabel(prevMonth)}）が最終承認されていないため、まだ申請できません。承認され次第、自動で確認して申請します。`;
  emitTermHistoryEvent(sub.targetMonth, 'waiting-approval', 'waiting-approval', message);
  await setTerminalAutoProgress({ running: false, done: true, waitingApproval: true, text: message });
  sendToPopup({ type: 'DONE', text: message });
}

async function advanceSubmitQueue(sub, submitted, dryRun) {
  if (submitted) await markTermSubmitted(sub.targetMonth);
  const nextIndex = (sub.queueIndex || 0) + 1;
  if (nextIndex < sub.queue.length) {
    const nextMonth = sub.queue[nextIndex];
    const next = await updateSubmit(sub, { queueIndex: nextIndex, targetMonth: nextMonth, phase: 'submit-ensure-month', navStep: null });
    sendProgress(`次の対象月（${formatMonthLabel(nextMonth)}）を処理します...`, submitPercent(next, 0));
    return runSubmitStateMachine(next);
  }
  const n = sub.queue.length;
  let message;
  if (dryRun) {
    message = `（テスト実行）${n}件の月次申請を申請直前まで確認しました。実際の送信は行っていません。`;
  } else {
    notify('月次申請が完了しました', `${n}件の月次申請が完了しました。`);
    message = `${n}件の月次申請が完了しました。`;
  }
  await setTerminalAutoProgress({ running: false, done: true, text: message });
  sendToPopup({ type: 'DONE', text: message });
}

async function runSubmitStateMachine(sub) {
  try {
    switch (sub.phase) {
      case 'submit-nav': {
        const r = await prepareTermPage();
        if (r.ready) {
          const next = await updateSubmit(sub, { phase: 'submit-ensure-month' });
          return runSubmitStateMachine(next);
        }
        sendProgress(`${labelOf(sub)}：勤務表へ移動中...`, submitPercent(sub, 4));
        return; // navigation in flight; re-enter on next page load
      }

      case 'submit-ensure-month': {
        if (!isTermPage()) {
          const next = await updateSubmit(sub, { phase: 'submit-nav' });
          return runSubmitStateMachine(next);
        }
        const cur = readDisplayedTermMonth();
        if (!cur) return sendRetryableSubmitError(sub, '勤務表の対象月を読み取れませんでした');
        if (cur === sub.targetMonth) {
          const next = await updateSubmit(sub, { phase: 'submit-check-hours', navStep: null });
          return runSubmitStateMachine(next);
        }
        const count = (sub.navStep && sub.navStep.count) || 0;
        if (count > MAX_TERM_LOOKBACK + 2) {
          return sendRetryableSubmitError(sub, `${labelOf(sub)} の勤務表へ移動できませんでした`);
        }
        const goBack = monthDelta(sub.targetMonth, cur) < 0;
        const btn = goBack ? getTermEl('TOPRVTM') : getTermEl('TONXTTM');
        if (!btn) return sendRetryableSubmitError(sub, '月移動ボタンが見つかりません');
        await updateSubmit(sub, { navStep: { count: count + 1 } });
        sendProgress(`${labelOf(sub)}：対象月へ移動中...（現在 ${formatMonthLabel(cur)}）`, submitPercent(sub, 8));
        activateElement(btn); // full reload → re-enter
        return;
      }

      case 'submit-check-hours': {
        if (!isTermPage() || readDisplayedTermMonth() !== sub.targetMonth) {
          const next = await updateSubmit(sub, { phase: 'submit-ensure-month' });
          return runSubmitStateMachine(next);
        }
        // Entry-only (current-month hours fill) skips the submittable gate: the current
        // month isn't in a submission window yet, but we still enter its worked days.
        if (!sub.entryOnly && !isMonthSubmittable()) {
          // Already submitted or window closed — a quiet no-op for the unattended auto run.
          return abortSubmit(sub, `${labelOf(sub)} は月次申請の対象外です（提出期限切れ、または既に申請済みです）。`);
        }
        const hasWorkdays = !!(sub.workdaysByMonth &&
          Object.prototype.hasOwnProperty.call(sub.workdaysByMonth, sub.targetMonth));
        const workdays = hasWorkdays ? sub.workdaysByMonth[sub.targetMonth] : [];
        if (!hasWorkdays) {
          // Workdays unknown (e.g. an unattended auto run) — fetch the month's 平日 first.
          const next = await updateSubmit(sub, { phase: 'submit-scan-workdays' });
          return runSubmitStateMachine(next);
        }
        const res = detectHoursComplete(workdays);
        if (res.error) return sendRetryableSubmitError(sub, res.error);
        if (res.complete) {
          if (sub.entryOnly) {
            // Hours-entry only — nothing to submit. We're done for this month.
            const completionModel = globalThis.HRTermHours;
            if (!completionModel || typeof completionModel.completedHoursMessage !== 'function') {
              return sendRetryableSubmitError(sub, '勤務時間の完了履歴モデルを読み込めませんでした');
            }
            const message = completionModel.completedHoursMessage(sub.targetMonth, workdays.length);
            const historyRecorded = await emitTermHistoryEvent(sub.targetMonth, 'hours-complete', 'hours-complete', message);
            if (!historyRecorded) {
              return sendRetryableSubmitError(sub, '勤務時間の完了履歴を保存できませんでした');
            }
            return sendTerminalSubmitDone(message);
          }
          // Hours done. Verify the previous period is approved before submitting (unless already checked).
          const next = await updateSubmit(sub, { phase: sub.prechecked ? 'submit-click' : 'submit-precheck' });
          return runSubmitStateMachine(next);
        }
        sendProgress(`${labelOf(sub)}：未入力の勤務時間（${res.missing.length}日分）を入力します...`, submitPercent(sub, 15));
        const tasks = res.tasks || [];
        await chrome.storage.session.set({
          hrAutoState: {
            phase: tasks[0].phase,
            dates: tasks.map(task => task.date),
            taskPhases: tasks.map(task => task.phase),
            dateIndex: 0,
            config: sub.config
          }
        });
        await updateSubmit(sub, { phase: 'submit-entering' });
        navigateToApplicationMenu(); // hand off to the existing clockin/clockout machine
        return;
      }

      case 'submit-entering': {
        // The existing machine owns the page while hrAutoState exists. If we reach here,
        // entry finished (handoff in the 'success' branch reset us to submit-nav) — re-verify.
        const next = await updateSubmit(sub, { phase: 'submit-nav' });
        return runSubmitStateMachine(next);
      }

      case 'submit-scan-workdays': {
        // Read the target month's complete scheduled-date set directly from the
        // authoritative 勤務表 and fill the entire month in one run.
        const target = sub.targetMonth;
        if (sub.workdaysByMonth && Object.prototype.hasOwnProperty.call(sub.workdaysByMonth, target)) {
          return runSubmitStateMachine(await updateSubmit(sub, { phase: 'submit-ensure-month' }));
        }
        if (!isTermPage() || readDisplayedTermMonth() !== target) {
          return runSubmitStateMachine(await updateSubmit(sub, { phase: 'submit-ensure-month' }));
        }
        const result = detectScheduledWorkdays(target);
        if (result.error) return sendRetryableSubmitError(sub, result.error);
        const dates = result.dates;
        const message = scheduledWorkdaysMessage(target, dates);
        sendProgress(message, submitPercent(sub, 10));
        emitTermHistoryEvent(target, 'workdays-determined-full-month', 'workdays-determined', message);
        const wbm = { ...(sub.workdaysByMonth || {}), [target]: dates };
        return runSubmitStateMachine(await updateSubmit(sub, { phase: 'submit-check-hours', workdaysByMonth: wbm }));
      }

      case 'submit-precheck': {
        // Navigate to the previous month to read its 処理状況 (approval) before submitting.
        if (!isTermPage() || readDisplayedTermMonth() !== sub.targetMonth) {
          const next = await updateSubmit(sub, { phase: 'submit-ensure-month' });
          return runSubmitStateMachine(next);
        }
        const prevMonth = monthMinus(sub.targetMonth, 1);
        const btn = getTermEl('TOPRVTM');
        if (!btn) return sendRetryableSubmitError(sub, '前月へ移動できませんでした');
        await updateSubmit(sub, { phase: 'submit-precheck-read', prevMonth, navStep: { count: 0 } });
        sendProgress(`${labelOf(sub)}：前月（${formatMonthLabel(prevMonth)}）の承認状況を確認中...`, submitPercent(sub, 70));
        activateElement(btn); // full reload → re-enter on submit-precheck-read
        return;
      }

      case 'submit-precheck-read': {
        if (!isTermPage()) return; // wait for the reload
        const cur = readDisplayedTermMonth();
        if (cur !== sub.prevMonth) {
          const count = (sub.navStep && sub.navStep.count) || 0;
          if (count > MAX_TERM_LOOKBACK + 2) return sendRetryableSubmitError(sub, '前月へ移動できませんでした');
          const goBack = monthDelta(sub.prevMonth, cur) < 0;
          const btn = goBack ? getTermEl('TOPRVTM') : getTermEl('TONXTTM');
          if (!btn) return sendRetryableSubmitError(sub, '前月へ移動できませんでした');
          await updateSubmit(sub, { navStep: { count: count + 1 } });
          activateElement(btn);
          return;
        }
        const approval = readTermApprovalStatus();
        if (approval === 'approved') {
          // Clear to submit: return to the target month, then submit.
          const next = await updateSubmit(sub, { phase: 'submit-ensure-month', prechecked: true, navStep: null });
          return runSubmitStateMachine(next);
        }
        return handleTermBlocked(sub, sub.prevMonth, approval);
      }

      case 'submit-click': {
        if (!isTermPage() || readDisplayedTermMonth() !== sub.targetMonth) {
          const next = await updateSubmit(sub, { phase: 'submit-ensure-month' });
          return runSubmitStateMachine(next);
        }
        if (!isMonthSubmittable()) {
          return abortSubmit(sub, `${labelOf(sub)} は月次申請の対象外です。`);
        }
        const btn = getTermEl('BTNSBMT0');
        if (!btn) return sendTerminalSubmitError(sub, '月次申請ボタンが見つかりません');
        if (TERM_SUBMIT_DRY_RUN) {
          console.log('[HR Term Submit] DRY-RUN: would click 月次申請 for', sub.targetMonth);
          sendProgress(`（テスト実行）${labelOf(sub)} の月次申請手前まで確認しました（未送信）。`, submitPercent(sub, 90));
          return advanceSubmitQueue(sub, false, true);
        }
        sendProgress(`${labelOf(sub)}：月次申請を送信中...`, submitPercent(sub, 85));
        await updateSubmit(sub, { phase: 'submit-confirm' });
        activateElement(btn); // onclick → PreparePersonalTermSubmissionAction → form.submit() (full reload)
        return;
      }

      case 'submit-confirm': {
        // Blocked? (clicking 月次申請 reloaded the 勤務表 with the rejection <strong>)
        if (isPrevApprovalBlocked()) {
          return handleTermBlocked(sub, monthMinus(sub.targetMonth, 1), 'pending');
        }
        // Confirm page → click 確定 (#btnExec0) to commit.
        if (isTermConfirmPage()) {
          const confirmBtn = findTermConfirmButton();
          if (confirmBtn) {
            sendProgress(`${labelOf(sub)}：申請内容を確定中...`, submitPercent(sub, 92));
            await updateSubmit(sub, { phase: 'submit-success' });
            activateElement(confirmBtn); // → ExecutePersonalTermSubmissionAction → commit (full reload)
            return;
          }
        }
        // Otherwise it may already be committed, or the page is still settling — re-check as success.
        const next = await updateSubmit(sub, { phase: 'submit-success' });
        return runSubmitStateMachine(next);
      }

      case 'submit-success': {
        // ⚠ Success page DOM not yet observed; detection keys on the month becoming non-submittable.
        if (detectTermSubmissionSuccess(sub.targetMonth)) {
          return advanceSubmitQueue(sub, true, false);
        }
        sendProgress(`${labelOf(sub)}：申請結果を確認中...`, submitPercent(sub, 95));
        await updateSubmit(sub, { phase: 'submit-success-wait' });
        return;
      }

      case 'submit-success-wait': {
        if (detectTermSubmissionSuccess(sub.targetMonth)) {
          return advanceSubmitQueue(sub, true, false);
        }
        // Don't claim a success we can't confirm.
        return sendTerminalSubmitError(sub, `${labelOf(sub)} の申請結果を確認できませんでした。勤務表でご確認ください。`);
      }

      default:
        return sendRetryableSubmitError(sub, '月次申請の処理状態を復元できませんでした。');
    }
  } catch (err) {
    console.error('[HR Term Submit] Error:', err);
    await sendRetryableSubmitError(sub, err.message);
  }
}

// ── Message Handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PAGE_CHECK') {
    sendResponse({ onDomain: true });
    return;
  }

  if (msg.type === 'PREPARE_WORKDAY_SCAN') {
    prepareTermPage()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'SCAN_WORKDAYS') {
    if (!isWorkdayCalendarPage()) {
      sendResponse({ error: '本人用実績入力のページではありません' });
      return;
    }
    scanWorkdaysForMonths(msg.months || [])
      .then(workdays => sendResponse({ workdays }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // async response
  }

  if (msg.type === 'SCAN_WORKDAYS_FOR_MONTH') {
    scanTermWorkdaysStep(msg.monthKey)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'PREPARE_TERM_PAGE') {
    prepareTermPage()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'SCAN_TERM_STATUS_STEP') {
    termScanStep(msg.confirmedMonths)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'START_TERM_SUBMIT') {
    shouldStop = false;
    const queue = msg.queue || [];
    const sub = {
      queue,
      queueIndex: 0,
      targetMonth: queue[0] || null,
      phase: 'submit-nav',
      config: msg.config,
      workdaysByMonth: msg.workdaysByMonth || {},
      navStep: null,
      auto: !!msg.auto,
    };
    chrome.storage.session.set({ hrSubmitState: sub });
    if (sub.targetMonth) {
      sendProgress(`${formatMonthLabel(sub.targetMonth)} の月次申請を開始します...`, 2);
    }
    runStateMachine();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'STOP') {
    shouldStop = true;
    chrome.storage.session.remove('hrAutoState');
    chrome.storage.session.remove('hrSubmitState');
    chrome.storage.session.remove('hrTermScan');
    chrome.storage.session.remove('hrAutoProgress');
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'START') {
    shouldStop = false;
    chrome.storage.session.set({ hrAutoState: msg.state });
    sendProgress('開始中...', 0);

    // If already on a usable page, run state machine immediately
    const page = detectPage();
    if (page === 'application-menu' || page === 'clockin-input' || page === 'clockout-input' || page === 'break-input') {
      runStateMachine();
    } else {
      navigateToApplicationMenu();
    }

    sendResponse({ ok: true });
    return;
  }
});

// ── Auto-resume on page load ──────────────────────────────────────────────────
runStateMachine();

// Passive readiness signal for the toolbar badge / one-time notification (read-only,
// independent of the state machine; self-skips off the 勤務表 and during automation).
setTimeout(() => { reportTermObservation(); }, 1500);
setTimeout(() => { reportCurrentMonthHoursCompletion(); }, 2000);

// This content script only runs on CWS pages (login lives on a different host), so
// reaching here means the session is valid. Tell the background in case a background
// submission was paused waiting for the user to log in.
if (extensionAlive()) { try { chrome.runtime.sendMessage({ type: 'CWS_READY' }); } catch (_) {} }
