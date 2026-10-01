const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Runs the real popup.js against stub DOM elements and a stub chrome API, so startup
// ordering bugs (e.g. reading a const before its declaration runs) show up here.
function loadPopup(localData) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    id, value: '', checked: false, textContent: '', innerHTML: '', dataset: {},
    style: { display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, append() {}, replaceChildren() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
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
    set: async () => {}, remove: async () => {},
  });
  const chrome = {
    storage: { local: area(localData), session: area({}), onChanged: event },
    tabs: { query: async () => [], onActivated: event, onUpdated: event },
    runtime: { onMessage: event, sendMessage: async () => {} },
  };
  const context = {
    chrome, console, setTimeout, clearTimeout, AbortController, Promise,
    fetch: () => new Promise(() => {}),
    window: { confirm: () => false },
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      createElement: () => element(`tmp-${Math.random()}`),
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'status-model.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), context);
  return element;
}

test('restores the saved 出退勤設定 into the panel on open', async () => {
  const el = loadPopup({
    hrTermTimeConfig: {
      mode: 'manual',
      arriveRange: { earlyH: 9, earlyM: 5, lateH: 9, lateM: 30 },
      departRange: { earlyH: 18, earlyM: 0, lateH: 18, lateM: 45 },
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(el('modeManual').checked, true);
  assert.equal(el('manualSection').style.display, 'block');
  assert.equal(el('arriveEarlyH').value, 9);
  assert.equal(el('arriveEarlyM').value, '05');
  assert.equal(el('departLatestM').value, '45');
});
