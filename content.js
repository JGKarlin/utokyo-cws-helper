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
function sendToPopup(msg) {
  try { chrome.runtime.sendMessage(msg); } catch {}
}

function sendProgress(text, percent) {
  sendToPopup({ type: 'PROGRESS', text, percent });
  chrome.storage.session.set({ hrAutoProgress: { running: true, text, percent } });
}

function sendDone(text) {
  sendToPopup({ type: 'DONE', text });
  chrome.storage.session.set({ hrAutoProgress: { running: false, done: true, text } });
}

function sendError(message) {
  sendToPopup({ type: 'ERROR', message });
  chrome.storage.session.set({ hrAutoProgress: { running: false, error: true, message } });
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
  let result;
  try {
    result = await chrome.storage.session.get(['hrAutoState', 'hrScanActive']);
  } catch { return; }

  if (result.hrScanActive) return;

  const state = result.hrAutoState;
  if (!state) return;

  // Delay to let page settle (longer for iframe-based pages)
  await delay(1200);

  if (shouldStop) {
    chrome.storage.session.remove('hrAutoState');
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
          chrome.storage.session.set({ hrAutoState: nextState });
          sendProgress(progressText(nextState), calcProgress(nextState));
          clickReturnLink();
        } else {
          // All entries complete
          chrome.storage.session.remove('hrAutoState');
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
    chrome.storage.session.remove('hrAutoState');
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

  if (msg.type === 'STOP') {
    shouldStop = true;
    chrome.storage.session.remove('hrAutoState');
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
