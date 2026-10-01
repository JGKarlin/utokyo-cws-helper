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

test('keeps an entry-only run at the end of the month scale while it re-verifies', () => {
  // After the last entry (~98%), the re-check must not drop back to the submission scale's 60%.
  assert.match(content, /pendingSubmit\.entryOnly \? 99 : submitPercent\(pendingSubmit, 60\)/);
});
