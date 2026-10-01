const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('records entry-only timeouts and infrastructure failures in recent history', () => {
  assert.match(background, /terminalEntryProgress\(progress\)/);
  assert.match(background, /hrAutoProgress: entryTerminal/);
  assert.match(background, /recordBackgroundOutcome\(month, entryTerminal \|\| progress/);
});

test('waits for completion history persistence before declaring the month done', () => {
  assert.match(content, /async function emitTermHistoryEvent/);
  assert.match(content, /await emitTermHistoryEvent\(sub\.targetMonth, 'hours-complete', 'hours-complete', message\)/);
  assert.match(content, /勤務時間の完了履歴を保存できませんでした/);
});

test('records a verified current-month completion when the live work table is observed', () => {
  assert.match(content, /async function reportCurrentMonthHoursCompletion/);
  assert.match(content, /detectScheduledWorkdays\(month\)/);
  assert.match(content, /detectHoursComplete\(scheduled\.dates\)/);
  assert.match(content, /await emitTermHistoryEvent\(month, 'hours-complete', 'hours-complete', message\)/);

  const start = content.indexOf('async function reportCurrentMonthHoursCompletion');
  const end = content.indexOf('\n}\n', start) + 3;
  const observer = content.slice(start, end);
  assert.doesNotMatch(observer, /hrSubmitState|hrAutoState|hrScanActive|hrAutoEntryEnabled/);
});

test('plans the current-month entry run against the whole month, not just the remaining days', () => {
  assert.match(content, /monthEntries: hoursModel\.countMonthEntries\(workdays, rowFacts\)/);
  assert.match(content, /monthEntries: res\.monthEntries/);
  const start = content.indexOf('function calcProgress');
  const end = content.indexOf('// ── Advance State', start);
  assert.match(content.slice(start, end), /plannedEntryProgress\(state\)/);
});

test('shows 100% with a verification message once the month entry is complete', () => {
  assert.match(content, /sendProgress\(`\$\{formatMonthLabel\(pendingSubmit\.targetMonth\)\}：勤務時間の入力が完了しました。勤務表で入力結果を確認中\.\.\.`, 100\)/);
  // A submission run whose hours were already complete starts its later steps at 100% too.
  assert.match(content, /sendProgress\(`\$\{labelOf\(sub\)\}：勤務時間の入力完了を確認しました。`, 100\)/);
});

test('expresses only the month entry progress as a percentage', () => {
  // Navigation, workday scans, approval checks and submission steps are text-only.
  assert.doesNotMatch(content, /submitPercent/);
  const scan = content.slice(content.indexOf('async function scanWorkdaysForMonths'));
  assert.doesNotMatch(scan.slice(0, scan.indexOf('\n}\n')), /sendProgress\(/);
  for (const step of ['：勤務表へ移動中', '：対象月へ移動中', 'の承認状況を確認中', '：月次申請を送信中', '：申請内容を確定中', '：申請結果を確認中']) {
    const at = content.indexOf(step);
    assert.notEqual(at, -1, step);
    const line = content.slice(content.lastIndexOf('\n', at), content.indexOf('\n', at));
    assert.match(line, /await sendStepProgress\(/, step);
  }
});

test('names the submitted months in the completion message and notification', () => {
  const start = content.indexOf('async function advanceSubmitQueue');
  const body = content.slice(start, content.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /\$\{n\}件の月次申請が完了しました/);
  assert.match(body, /の月次申請を提出しました（承認待ち）。/);
});

test('stamps when a month status was observed so the panel can tell how current it is', () => {
  const start = content.indexOf('async function markTermSubmitted');
  assert.match(content.slice(start, content.indexOf('\n}\n', start)), /observedAt: Date\.now\(\)/);
  const observed = background.indexOf('async function handleTermObserved');
  assert.match(background.slice(observed, background.indexOf('\n}\n', observed)), /observedAt: Date\.now\(\)/);
});

test('decides which months are past against today, not the last status scan', () => {
  const start = background.indexOf('function computeReadyMonths');
  const body = background.slice(start, background.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /cache\.currentMonth/);
  assert.match(body, /thisCalMonthKey\(\)/);
});
