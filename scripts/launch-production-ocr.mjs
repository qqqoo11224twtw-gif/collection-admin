import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'),
  directory = resolve(root, '.secrets');
mkdirSync(directory, { recursive: true });
const lock = resolve(directory, 'production-release.lock'),
  log = resolve(directory, 'last-production-release.log');
if (existsSync(lock)) {
  const previous = Number(readFileSync(lock, 'utf8'));
  let active = false;
  try {
    process.kill(previous, 0);
    active = true;
  } catch (error) {
    if (error.code !== 'ESRCH') active = true;
  }
  if (active) {
    console.error('已有發布工具執行中，請勿重複啟動。');
    process.exit(1);
  }
  unlinkSync(lock);
}
writeFileSync(lock, String(process.pid), { flag: 'wx' });
writeFileSync(log, '');
const print = (value) => {
  appendFileSync(log, value);
  process.stdout.write(value);
};
print('正在執行檢查與發布，請勿關閉視窗。進度會持續顯示。\n');
const child = spawn(
  process.execPath,
  [resolve(root, process.argv.includes('--interface') ? 'scripts/release-ocr-interface.mjs' : 'scripts/release-production-ocr.mjs'), '--deploy'],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
);
child.stdout.on('data', (bytes) => print(bytes.toString()));
child.stderr.on('data', (bytes) => print(bytes.toString()));
const start = Date.now();
const timer = setInterval(
  () =>
    print(
      `仍在執行中，已經過 ${Math.round((Date.now() - start) / 1000)} 秒。\n`,
    ),
  15000,
);
process.on('SIGINT', () => {
  print('已要求安全停止；正在等待目前步驟完成及版本回復，請勿強制關閉。\n');
  if (child.connected) child.send({ type: 'cancel-release' });
});
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid))
    unlinkSync(lock);
  print(`\n發布工具結束，結束代碼：${code}。\n`);
  process.exitCode = code;
}
child.on('error', () => finish(1));
child.on('exit', (code) => finish(code ?? 1));
