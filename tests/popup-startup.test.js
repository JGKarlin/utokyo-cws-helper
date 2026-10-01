const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Runs the real popup.js against stub DOM elements and a stub chrome API, so startup
// ordering bugs (e.g. reading a const before its declaration runs) and what the panel
// actually renders show up here.
function loadPopup(localData, options = {}) {
  const elements = {};
  const document = {};
  const makeElement = (props) => ({
    value: '', checked: false, textContent: '', innerHTML: '', className: '', dataset: {},
    children: [], ownerDocument: document,
    style: { display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, remove() {},
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    querySelector: () => null, querySelectorAll: () => [],
    ...props,
  });
  const element = (id) => elements[id] || (elements[id] = makeElement({ id }));
  Object.assign(document, {
    getElementById: element,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement({ tagName: tag }),
    createTextNode: (text) => makeElement({ textContent: String(text) }),
  });
  // The radio defaults from popup.html.
  element('modeAuto').checked = true;

  const event = { addListener() {} };
  const area = (data) => ({
    get: (keys, cb) => {
      const list = keys == null ? Object.keys(data) : [].concat(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      if (cb) { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set: async (patch) => { Object.assign(data, patch); },
    remove: async () => {},
  });
  const chrome = {
    storage: { local: area(localData), session: area({}), onChanged: event },
    tabs: { query: async () => [], onActivated: event, onUpdated: event },
    runtime: { onMessage: event, sendMessage: async () => {} },
  };
  const now = options.now;
  const FixedDate = now == null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const context = {
    chrome, console, setTimeout, clearTimeout, AbortController, Promise, document,
    Date: FixedDate,
    fetch: () => new Promise(() => {}),
    window: { confirm: () => false },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'status-model.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), context);
  return element;
}

// Text of each rendered child (one entry per row / history line).
function renderedLines(container) {
  const textOf = (node) => (node.textContent || '') + (node.children || []).map(textOf).join('');
  return container.children.map(textOf);
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('restores the saved 出退勤設定 into the panel on open', async () => {
  const el = loadPopup({
    hrTermTimeConfig: {
      mode: 'manual',
      arriveRange: { earlyH: 9, earlyM: 5, lateH: 9, lateM: 30 },
      departRange: { earlyH: 18, earlyM: 0, lateH: 18, lateM: 45 },
    },
  });
  await settle();

  assert.equal(el('modeManual').checked, true);
  assert.equal(el('manualSection').style.display, 'block');
  assert.equal(el('arriveEarlyH').value, 9);
  assert.equal(el('arriveEarlyM').value, '05');
  assert.equal(el('departLatestM').value, '45');
});

test('labels 今月/前月 by today, not by the month of the last status scan', async () => {
  // The last full scan ran in September; today is 2026-10-02 00:45 (local time).
  const now = new Date(2026, 9, 2, 0, 45).getTime();
  const submittedAt = new Date(2026, 9, 2, 0, 40).getTime();
  const el = loadPopup({
    hrAutoEntryEnabled: true,
    hrAutoSubmitEnabled: true,
    hrTermStatusCache: {
      scannedAt: new Date(2026, 8, 21, 1, 28).getTime(),
      currentMonth: '2026-09',
      months: {
        '2026-09': { month: '2026-09', approval: 'pending', submitted: true, submittable: false,
          fresh: true, source: 'live', observedAt: submittedAt },
        '2026-08': { month: '2026-08', approval: 'approved', confirmed: true, confirmedAt: 1 },
      },
    },
    hrTermStatusHistory: [
      { month: '2026-10', type: 'hours-complete', state: 'hours-complete', at: submittedAt - 120000,
        message: '2026年10月分：勤務時間の入力完了（21勤務日）。出勤・退勤・勤務外時間数を確認済み。' },
      { month: '2026-09', type: 'submitted', state: 'submitted-pending', at: submittedAt,
        message: '2026年9月分を提出しました。' },
    ],
  }, { now });
  await settle();

  const rows = renderedLines(el('termCurrentStatus'));
  assert.equal(rows[0],
    '2026年10月分（今月・入力済み）：勤務時間の入力完了（21勤務日）。出勤・退勤・勤務外時間数を確認済み。月次申請は11月に自動で行います。');
  // Submitted minutes ago — current, so no 「前回確認時」 caveat.
  assert.equal(rows[1], '2026年9月分（前月・承認待ち）：提出済み（承認待ち）');
  assert.equal(rows[2], '✓2026年8月分：最終承認済み');

  const history = renderedLines(el('termHistory')).join('\n');
  assert.match(history, /2026年10月分：勤務時間の入力完了（21勤務日）/);
});

test('says when an older row was last observed', async () => {
  const now = new Date(2026, 9, 2, 12, 0).getTime();
  const el = loadPopup({
    hrAutoEntryEnabled: true,
    hrTermStatusCache: {
      scannedAt: new Date(2026, 8, 21, 1, 28).getTime(),
      currentMonth: '2026-09',
      months: {
        '2026-09': { month: '2026-09', approval: 'pending', submitted: true,
          observedAt: new Date(2026, 9, 2, 0, 40).getTime() },
      },
    },
  }, { now });
  await settle();

  const rows = renderedLines(el('termCurrentStatus'));
  assert.match(rows[0], /^2026年9月分（前月・承認待ち）：提出済み（承認待ち）/);
  assert.match(rows[0], /10\/2 00:40 時点の情報です$/);
});
