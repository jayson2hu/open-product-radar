import { execFileSync } from 'node:child_process';

// Inspect the Git index, which is the exact content about to be committed/pushed.
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const files = git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean);
const forbidden = /(^|\/)(?:node_modules|dist|data|backups|artifacts|\.codex|\.agents|__pycache__)(\/|$)|(^|\/)\.env(?!\.example$)(?:[./]|$)|\.(?:sqlite(?:-[\w]+)?|db(?:-[\w]+)?|eml|pem|key|p12|pfx|log)$/i;
const patterns = [
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['API secret', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];
const failures = [];
for (const path of files) {
  if (forbidden.test(path) || path === 'docs/PRODUCT_SPEC.md') { failures.push(`${path}: local/private artifact must not be committed`); continue; }
  const content = git(['show', `:${path}`]);
  if (content.includes('\0')) continue;
  content.split(/\r?\n/).forEach((line, index) => {
    for (const [label, pattern] of patterns) if (pattern.test(line)) failures.push(`${path}:${index + 1}: possible ${label}`);
  });
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Publication check passed: ${files.length} indexed files; local data and known credential patterns excluded.`);
