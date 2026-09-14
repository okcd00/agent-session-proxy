// Extracts the real renderer functions out of public/app.js and exercises them,
// so the test cannot drift from the shipped source.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function grab(pattern, label) {
  const match = src.match(pattern);
  if (!match) throw new Error(`could not locate ${label} in app.js`);
  return match[0];
}

const pieces = [
  grab(/function escapeHtml\(value\) \{[\s\S]*?\n\}/, 'escapeHtml'),
  grab(/const FILE_PATH_RE = .*;/, 'FILE_PATH_RE'),
  grab(/function downloadUrl\(absPath\) \{[\s\S]*?\n\}/, 'downloadUrl'),
  grab(/function linkifyPaths\(escaped\) \{[\s\S]*?\n\}/, 'linkifyPaths'),
  grab(/function inlineMd\(escaped\) \{[\s\S]*?\n\}/, 'inlineMd'),
];

const state = { token: 'TOK' };
// eslint-disable-next-line no-new-func
const factory = new Function('state', `${pieces.join('\n\n')}\nreturn { escapeHtml, inlineMd, linkifyPaths };`);
const { escapeHtml, inlineMd } = factory(state);

let failures = 0;
function check(label, actual, mustInclude, mustNotInclude = []) {
  const missing = mustInclude.filter((needle) => !actual.includes(needle));
  const present = mustNotInclude.filter((needle) => actual.includes(needle));
  const ok = !missing.length && !present.length;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    failures += 1;
    if (missing.length) console.log(`      缺少: ${JSON.stringify(missing)}`);
    if (present.length) console.log(`      不该出现: ${JSON.stringify(present)}`);
    console.log(`      实际: ${actual}`);
  }
}

// The renderer always receives already-escaped text.
const md = (raw) => inlineMd(escapeHtml(raw));

console.log('### 路径链接化');
check('普通绝对路径变成下载链接',
  md('结果在 /Users/dian/Github/shared_workspace/report.pdf 里'),
  ['<a class="file-link"', 'download', 'report.pdf', 'path=%2FUsers%2Fdian'],
  []);

check('反引号里的路径也能下载（最常见的写法）',
  md('完整路径：`/Users/dian/Github/out/summary.md`'),
  ['<code>', '<a class="file-link"', 'summary.md'],
  []);

check('没有扩展名的目录不链接',
  md('看看 /Users/dian/Github/shared_workspace 这个目录'),
  [],
  ['file-link']);

check('行首的路径也能匹配',
  md('/tmp/a/b.txt 已生成'),
  ['<a class="file-link"', 'b.txt'],
  []);

check('中文标点后面紧跟路径也能匹配',
  md('文件：/tmp/x/y.csv，请查收'),
  ['<a class="file-link"', 'y.csv'],
  []);

console.log('\n### 不能破坏 http 链接');
check('markdown 链接里的路径不被误伤',
  md('[文档](http://a.com/b.txt)'),
  ['<a href="http://a.com/b.txt" target="_blank"', '>文档</a>'],
  ['file-link', '&#39;', '&amp;amp;']);

check('裸 URL 保持纯文本（原有行为）',
  md('见 http://a.com/path/file.txt 这个地址'),
  ['http://a.com/path/file.txt'],
  ['file-link', '<a href="http']);

check('URL 里的 & 不被双重转义',
  md('[x](http://a.com/p?q=1&r=2)'),
  ['href="http://a.com/p?q=1&amp;r=2"'],
  ['&amp;amp;']);

console.log('\n### XSS');
check('脚本标签被转义',
  md('<script>alert(1)</script>'),
  ['&lt;script&gt;'],
  ['<script>']);

check('路径位置注入引号无法逃出属性',
  md('/tmp/x" onmouseover="alert(1).txt'),
  [],
  ['onmouseover="alert']);

check('img onerror 注入无效',
  md('<img src=x onerror=alert(1)>'),
  ['&lt;img'],
  ['<img']);

check('链接文本里的 HTML 已转义',
  md('[<b>粗</b>](http://a.com/x)'),
  ['&lt;b&gt;'],
  ['<b>粗</b>']);

console.log(`\n${failures ? `FAILED: ${failures}` : 'RENDERER OK'}`);
process.exit(failures ? 1 : 0);
