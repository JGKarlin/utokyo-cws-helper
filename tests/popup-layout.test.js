const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('places recent history after the controls and live progress area', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const history = html.indexOf('id="termHistory"');
  const progress = html.indexOf('id="progressBar"');
  const automationEnd = html.indexOf('</div>', progress);

  assert.notEqual(history, -1);
  assert.notEqual(progress, -1);
  assert.ok(history > progress);
  assert.ok(history > automationEnd);
});

// Ids of the <div id="..."> ancestors enclosing the element with the given id.
function divAncestors(html, id) {
  const target = html.indexOf(`id="${id}"`);
  const stack = [];
  const tag = /<div\b[^>]*>|<\/div>/g;
  let m;
  while ((m = tag.exec(html)) && m.index < target) {
    if (m[0] === '</div>') { stack.pop(); continue; }
    if (m.index + m[0].length > target) break; // the target's own tag
    const idMatch = /\bid="([^"]+)"/.exec(m[0]);
    stack.push(idMatch ? idMatch[1] : '');
  }
  return stack.filter(Boolean);
}

test('keeps live progress and 停止 outside the CWS-only settings block', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  for (const id of ['progressBar', 'btnStop', 'statusText', 'errorBox', 'successBox']) {
    const ancestors = divAncestors(html, id);
    assert.ok(!ancestors.includes('automationUI'), `${id} must not be inside #automationUI`);
    assert.ok(ancestors.includes('liveStatusUI'), `${id} must be inside #liveStatusUI`);
  }
  // The CWS-only settings stay gated.
  assert.ok(divAncestors(html, 'manualEntrySection').includes('automationUI'));
});

test('停止 reaches the CWS tab running the automation, not just the active tab', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const start = popup.indexOf("getElementById('btnStop').addEventListener");
  const end = popup.indexOf('\n});\n', start);
  const handler = popup.slice(start, end);
  assert.match(handler, /chrome\.tabs\.query\(\{ url: 'https:\/\/ut-ppsweb\.adm\.u-tokyo\.ac\.jp\/\*' \}\)/);
  assert.match(handler, /hrAutoState/);
  assert.match(handler, /hrSubmitState/);
});
