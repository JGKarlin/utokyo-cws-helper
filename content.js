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

function sendDone(text) {
  sendToPopup({ type: 'DONE', text });
  safeSessionSet({ hrAutoProgress: { running: false, done: true, text } });
}

function sendError(message) {
  sendToPopup({ type: 'ERROR', message });
  safeSessionSet({ hrAutoProgress: { running: false, error: true, message } });
}

// Ask the background service worker to raise an OS/desktop notification (works even
// when the side panel is closed — e.g. during the unattended daily retry).
function notify(title, message) {
  try { chrome.runtime.sendMessage({ type: 'NOTIFY', title, message }); } catch (_) {}
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
  const linkText = phase === 'clockin' ? '自己申告記録（出勤）' : '自己申告記録（退勤）';
  const subId = phase === 'clockin' ? 'srw_app_gi02' : 'srw_app_gi03';

  const links = document.querySelectorAll('a');
  for (const link of links) {
    if (link.textContent.trim() === linkText && link.href.includes(subId)) {
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
function calcProgress(state) {
  const totalEntries = state.dates.length * 2;
  const completed = (state.dateIndex * 2) + (state.phase === 'clockout' ? 1 : 0);
  return Math.round((completed / totalEntries) * 100);
}

function progressText(state) {
  const phaseLabel = state.phase === 'clockin' ? '自己申告記録（出勤）' : '自己申告記録（退勤）';
  const dateStr = state.dates[state.dateIndex];
  const current = (state.dateIndex * 2) + (state.phase === 'clockout' ? 2 : 1);
  const total = state.dates.length * 2;
  return `${phaseLabel}：${dateStr}（${current}/${total}）`;
}

// ── Advance State ─────────────────────────────────────────────────────────────
// Returns the next state, or null if all entries are done.
function advanceState(state) {
  const next = { ...state, config: { ...state.config } };
  if (state.phase === 'clockin') {
    next.phase = 'clockout';
    return next;
  }

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
    if (!since || Date.now() - since < 120000) return;
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
      case 'clockout-input': {
        const expectedPage = state.phase === 'clockin' ? 'clockin-input' : 'clockout-input';
        if (page !== expectedPage) {
          // Wrong page — go back to pick the right one
          navigateToApplicationMenu();
          return;
        }
        sendProgress(progressText(state), percent);
        await fillDateAndTime(state);
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
          safeSessionRemove('hrAutoState');
          sendDone(`${state.dates.length}勤務日の自己申告記録（出勤・退勤）の登録が完了しました（${state.dates.length * 2}件）。`);
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

/** Navigate toward 本人用実績入力. Flow: 就労管理 → 本人用実績 → 本人用実績入力. */
async function clickWorkdayCalendarLink() {
  if (isWorkdayCalendarPage()) {
    await clearWorkdayScanNavStep();
    return { ready: true };
  }

  const navStep = await getWorkdayScanNavStep();

  const workMenuLink = findLinkBySelectorOrHref(WORK_MENU_LINK_SELECTOR, WORK_MENU_LINK_HREF);
  if (workMenuLink && !['main', 'performance', 'input'].includes(navStep) && activateElement(workMenuLink)) {
    await setWorkdayScanNavStep('main');
    return { navigating: true, step: '就労管理ページへ移動中...', waitMs: 1800 };
  }

  if (!isMainWorkMenuContext() && !['main', 'performance', 'input'].includes(navStep)) {
    window.location.href = MAIN_CWS_URL;
    return { navigating: true, step: '就労管理ページへ移動中...', waitMs: 1800 };
  }

  const performanceLink = findLinkBySelectorOrHref(PERFORMANCE_LINK_SELECTOR, PERFORMANCE_LINK_HREF);
  if (performanceLink && !['performance', 'input'].includes(navStep) && activateElement(performanceLink)) {
    await setWorkdayScanNavStep('performance');
    return { navigating: true, step: '本人用実績メニューへ移動中...', waitMs: 1200 };
  }
  if (performanceLink && (navStep === 'main' || navStep === 'performance')) {
    return { navigating: true, step: '本人用実績メニューの読み込み待ち...', waitMs: 1200 };
  }

  const inputLink = findLinkBySelectorOrHref(MATRIX_INPUT_LINK_SELECTOR, MATRIX_INPUT_LINK_HREF);
  if (inputLink && (navStep === 'performance' || isPerformanceMenuContext()) && activateElement(inputLink)) {
    await setWorkdayScanNavStep('input');
    return { navigating: true, step: '本人用実績入力へ移動中...', waitMs: 1200 };
  }
  if (inputLink && navStep === 'input') {
    return { navigating: true, step: '本人用実績入力の読み込み待ち...', waitMs: 1200 };
  }

  if (navStep === 'main' && isMainWorkMenuContext()) {
    return { navigating: true, step: '本人用実績リンクの出現待ち...', waitMs: 1000 };
  }
  if (navStep === 'performance') {
    return { navigating: true, step: '本人用実績入力リンクの出現待ち...', waitMs: 1000 };
  }

  return {
    navigating: true,
    step: '本人用実績リンクの出現待ち...',
    waitMs: 1000,
  };
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
        return { table: t, inCol, outCol: outCol !== -1 ? outCol : inCol + 1 };
      }
    }
  }
  return null;
}
// Given the month's 平日 (yyyy-mm-dd, from the existing workday scan), report which
// of them still lack times in the 勤務表 (time format is HH時MM分). Header rows are
// repeated mid-table, so skip any row whose first cell is 月日/曜日.
function detectHoursComplete(workdays) {
  const info = detectTermTable();
  if (!info) return { complete: false, missing: [], error: '勤務表の勤務時間表が見つかりません' };
  const { table, inCol, outCol } = info;
  const timeRe = /\d{1,2}時\d{1,2}分/;
  const dayMap = {};
  for (const row of table.rows) {
    const cells = row.cells;
    if (cells.length <= Math.max(inCol, outCol)) continue;
    const d0 = normalizeDigits(cells[0].textContent || '').trim();
    if (d0.indexOf('月日') !== -1 || d0.indexOf('曜日') !== -1) continue;
    let dd = null;
    const md = d0.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (md) dd = parseInt(md[2], 10);
    else { const d2 = d0.match(/(\d{1,2})日/); if (d2) dd = parseInt(d2[1], 10); }
    if (dd == null || dd < 1 || dd > 31) continue;
    const inT = normalizeDigits(cells[inCol].textContent || '');
    const outT = normalizeDigits(cells[outCol].textContent || '');
    dayMap[dd] = timeRe.test(inT) && timeRe.test(outT);
  }
  const missing = [];
  for (const wd of (workdays || [])) {
    const dd = parseInt(wd.split('-')[2], 10);
    if (!dayMap[dd]) missing.push(wd);
  }
  return { complete: missing.length === 0, missing };
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
// stops at the first PAST month whose 月次申請 button is gone (window closed).
async function termScanStep() {
  if (!isTermPage()) return { navigating: true, step: '勤務表の読み込み待ち...', waitMs: 1000 };
  const month = readDisplayedTermMonth();
  if (!month) return { error: '勤務表の対象月を読み取れませんでした' };
  const current = currentMonthKey();
  const r = await chrome.storage.session.get('hrTermScan');
  const scan = r.hrTermScan || { collected: {}, steps: 0 };
  scan.collected[month] = { month, label: formatMonthLabel(month), submittable: isMonthSubmittable(), approval: readTermApprovalStatus() };
  scan.steps = (scan.steps || 0) + 1;
  const pastClosed = monthDelta(month, current) < 0 && !scan.collected[month].submittable;
  if (pastClosed || scan.steps >= MAX_TERM_LOOKBACK) {
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
function abortSubmit(sub, message) {
  clearSubmit();
  if (sub && sub.auto) {
    safeSessionRemove('hrAutoProgress');
    return;
  }
  sendError(message);
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
    const r = await chrome.storage.local.get('hrTermStatusCache');
    const cache = r.hrTermStatusCache || { months: {} };
    if (!cache.months) cache.months = {};
    cache.months[month] = { ...(cache.months[month] || {}), submittable: false, submitted: true, approval: 'pending' };
    await chrome.storage.local.set({ hrTermStatusCache: cache });
  } catch (_) {}
  // A pending background retry for this month is now satisfied — clear it.
  try {
    const { hrPendingSubmit } = await chrome.storage.local.get('hrPendingSubmit');
    if (hrPendingSubmit && hrPendingSubmit.targetMonth === month) {
      await chrome.storage.local.remove('hrPendingSubmit');
      chrome.runtime.sendMessage({ type: 'TERM_CLEAR_RETRY' });
    }
  } catch (_) {}
  // The month is no longer "ready" — refresh the toolbar badge / notification state.
  try { chrome.runtime.sendMessage({ type: 'TERM_READY_RECOMPUTE' }); } catch (_) {}
}
// Previous period not finally approved → can't submit yet. Persist a pending record
// (storage.local), ask the background to schedule the daily retry + notify, and stop.
async function handleTermBlocked(sub, prevMonth, prevApproval) {
  // Notify only the first time this month is blocked — not on every daily retry.
  let alreadyNotified = false;
  try {
    const existing = (await chrome.storage.local.get('hrPendingSubmit')).hrPendingSubmit;
    if (existing && existing.targetMonth === sub.targetMonth && existing.notified) alreadyNotified = true;
  } catch (_) {}

  const pending = {
    queue: sub.queue, queueIndex: sub.queueIndex || 0, targetMonth: sub.targetMonth,
    prevMonth, prevApproval, config: sub.config, workdaysByMonth: sub.workdaysByMonth || {},
    since: Date.now(), notified: true,
  };
  try { await chrome.storage.local.set({ hrPendingSubmit: pending }); } catch (_) {}
  safeSessionRemove('hrSubmitState');
  safeSessionRemove('hrAutoState');
  try { chrome.runtime.sendMessage({ type: 'TERM_SCHEDULE_RETRY' }); } catch (_) {}
  if (!alreadyNotified) {
    notify('月次申請を保留しました', `${formatMonthLabel(sub.targetMonth)} は前月（${formatMonthLabel(prevMonth)}）の最終承認待ちのため申請できません。承認され次第、毎日自動で確認して申請します。`);
  }
  sendDone(`${formatMonthLabel(sub.targetMonth)} は前月（${formatMonthLabel(prevMonth)}）が最終承認されていないため、まだ申請できません。毎日自動で確認し、承認され次第申請します。`);
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
  safeSessionRemove('hrSubmitState');
  safeSessionRemove('hrAutoState');
  const n = sub.queue.length;
  if (dryRun) {
    sendDone(`（テスト実行）${n}件の月次申請を申請直前まで確認しました。実際の送信は行っていません。`);
  } else {
    notify('月次申請が完了しました', `${n}件の月次申請が完了しました。`);
    sendDone(`${n}件の月次申請が完了しました。`);
  }
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
        if (!cur) { sendError('勤務表の対象月を読み取れませんでした'); return clearSubmit(); }
        if (cur === sub.targetMonth) {
          const next = await updateSubmit(sub, { phase: 'submit-check-hours', navStep: null });
          return runSubmitStateMachine(next);
        }
        const count = (sub.navStep && sub.navStep.count) || 0;
        if (count > MAX_TERM_LOOKBACK + 2) {
          sendError(`${labelOf(sub)} の勤務表へ移動できませんでした`);
          return clearSubmit();
        }
        const goBack = monthDelta(sub.targetMonth, cur) < 0;
        const btn = goBack ? getTermEl('TOPRVTM') : getTermEl('TONXTTM');
        if (!btn) { sendError('月移動ボタンが見つかりません'); return clearSubmit(); }
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
        if (!isMonthSubmittable()) {
          // Already submitted or window closed — a quiet no-op for the unattended auto run.
          return abortSubmit(sub, `${labelOf(sub)} は月次申請の対象外です（提出期限切れ、または既に申請済みです）。`);
        }
        const workdays = (sub.workdaysByMonth && sub.workdaysByMonth[sub.targetMonth]) || [];
        if (!workdays.length) {
          // Workdays unknown (e.g. an unattended auto run) — fetch the month's 平日 first.
          const next = await updateSubmit(sub, { phase: 'submit-scan-workdays' });
          return runSubmitStateMachine(next);
        }
        const res = detectHoursComplete(workdays);
        if (res.error) { sendError(res.error); return clearSubmit(); }
        if (res.complete) {
          // Hours done. Verify the previous period is approved before submitting (unless already checked).
          const next = await updateSubmit(sub, { phase: sub.prechecked ? 'submit-click' : 'submit-precheck' });
          return runSubmitStateMachine(next);
        }
        sendProgress(`${labelOf(sub)}：未入力の勤務時間（${res.missing.length}日分）を入力します...`, submitPercent(sub, 15));
        await chrome.storage.session.set({ hrAutoState: { phase: 'clockin', dates: res.missing, dateIndex: 0, config: sub.config } });
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
        // Reach 本人用実績入力 and read the target month's 平日 (holiday-aware), then resume.
        // Used when the caller didn't pre-scan workdays (the unattended auto run).
        const target = sub.targetMonth;
        if (sub.workdaysByMonth && (sub.workdaysByMonth[target] || []).length) {
          return runSubmitStateMachine(await updateSubmit(sub, { phase: 'submit-ensure-month' }));
        }
        if (!isWorkdayCalendarPage()) {
          const r = await clickWorkdayCalendarLink(); // multi-step nav across reloads
          if (!r || !r.ready) {
            sendProgress(`${labelOf(sub)}：平日を確認中...（${(r && r.step) || ''}）`, submitPercent(sub, 2));
            return; // navigation in flight; re-enter on next page load
          }
        }
        let dates;
        try {
          dates = await loadMonthForWorkdays(target); // in-page, no reload
        } catch (e) {
          return abortSubmit(sub, `${labelOf(sub)} の平日を取得できませんでした：${e.message}`);
        }
        await clearWorkdayScanNavStep();
        const wbm = { ...(sub.workdaysByMonth || {}), [target]: dates };
        return runSubmitStateMachine(await updateSubmit(sub, { phase: 'submit-ensure-month', workdaysByMonth: wbm }));
      }

      case 'submit-precheck': {
        // Navigate to the previous month to read its 処理状況 (approval) before submitting.
        if (!isTermPage() || readDisplayedTermMonth() !== sub.targetMonth) {
          const next = await updateSubmit(sub, { phase: 'submit-ensure-month' });
          return runSubmitStateMachine(next);
        }
        const prevMonth = monthMinus(sub.targetMonth, 1);
        const btn = getTermEl('TOPRVTM');
        if (!btn) { sendError('前月へ移動できませんでした'); return clearSubmit(); }
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
          if (count > MAX_TERM_LOOKBACK + 2) { sendError('前月へ移動できませんでした'); return clearSubmit(); }
          const goBack = monthDelta(sub.prevMonth, cur) < 0;
          const btn = goBack ? getTermEl('TOPRVTM') : getTermEl('TONXTTM');
          if (!btn) { sendError('前月へ移動できませんでした'); return clearSubmit(); }
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
        if (!btn) { sendError('月次申請ボタンが見つかりません'); return clearSubmit(); }
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
        sendError(`${labelOf(sub)} の申請結果を確認できませんでした。勤務表でご確認ください。`);
        return clearSubmit();
      }

      default:
        clearSubmit();
    }
  } catch (err) {
    console.error('[HR Term Submit] Error:', err);
    safeSessionRemove('hrSubmitState');
    safeSessionRemove('hrAutoState');
    sendError(err.message);
  }
}

// ── Message Handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PAGE_CHECK') {
    sendResponse({ onDomain: true });
    return;
  }

  if (msg.type === 'PREPARE_WORKDAY_SCAN') {
    clickWorkdayCalendarLink()
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
    if (!isWorkdayCalendarPage()) {
      sendResponse({ error: '本人用実績入力のページではありません' });
      return;
    }
    scanWorkdaysForMonth(msg.monthKey)
      .then(dates => sendResponse({ monthKey: msg.monthKey, dates }))
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
    termScanStep()
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
    if (page === 'application-menu' || page === 'clockin-input' || page === 'clockout-input') {
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

// This content script only runs on CWS pages (login lives on a different host), so
// reaching here means the session is valid. Tell the background in case a background
// submission was paused waiting for the user to log in.
if (extensionAlive()) { try { chrome.runtime.sendMessage({ type: 'CWS_READY' }); } catch (_) {} }
