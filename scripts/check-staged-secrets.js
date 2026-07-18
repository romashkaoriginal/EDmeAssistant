const { execFileSync } = require('node:child_process');

const diff = execFileSync('git', ['diff', '--cached', '--no-color', '-U0'], { encoding: 'utf8' });
const addedLines = diff
  .split(/\r?\n/)
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');

const patterns = [
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['OpenAI-compatible API key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['private key', /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/],
  ['database URL with credentials', /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i]
];

const matches = patterns.filter(([, pattern]) => pattern.test(addedLines)).map(([name]) => name);
if (matches.length) {
  console.error(`Commit blocked: possible ${matches.join(', ')} detected in staged changes.`);
  console.error('Move the value to a local .env file or a deployment secret, then stage the fix.');
  process.exit(1);
}
