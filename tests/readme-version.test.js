const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The README states the version twice — in the title line (what GitHub shows at the top
// of the repo page) and under 技術仕様. Both must follow manifest.json on every bump.
test('README version lines match manifest.json', () => {
  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  const title = readme.match(/\*\*バージョン (\d+\.\d+\.\d+)\*\*/);
  const spec = readme.match(/\*\*拡張機能バージョン：\*\* (\d+\.\d+\.\d+)/);
  assert.ok(title, 'README title line「**バージョン x.y.z**」not found');
  assert.ok(spec, 'README 技術仕様「**拡張機能バージョン：** x.y.z」not found');
  assert.equal(title[1], version, 'README title version');
  assert.equal(spec[1], version, 'README 技術仕様 version');
});
