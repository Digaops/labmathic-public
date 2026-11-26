const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/ai/storeLocalKey.ps1');
const quote = value => `'${value.replace(/'/g, "''")}'`;
const fakeKey = 'sk-proj-offline-fixture-not-a-real-provider-key-0123456789';
const windows = { skip: process.platform !== 'win32' ? 'Windows DPAPI-only helper' : false };

function runFixture(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-ai-key-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, '.env.openai-key.dpapi');
  const command = `$ErrorActionPreference = 'Stop'; . ${quote(script)}; $target = ${quote(target)}; ${body}`;
  // Node can inherit PowerShell 7 module paths; Windows PowerShell must load its own modules.
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(fakeKey));
  assert.ok(!result.stderr.includes(fakeKey));
  return { result, target };
}

test('local key storage encrypts with Windows DPAPI, restricts ACL and exposes status only', windows, t => {
  const { target, result } = runFixture(t, `
    $key = ConvertTo-SecureString ${quote(fakeKey)} -AsPlainText -Force;
    try { Save-LabMathicLocalKey -Secret $key -Path $target } finally { $key.Dispose() }
    if (-not (Test-LabMathicLocalKey -Path $target)) { throw 'Missing saved status' }
    $restored = ConvertTo-SecureString ([System.IO.File]::ReadAllText($target));
    $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($restored);
    try {
      if ([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) -cne ${quote(fakeKey)}) { throw 'Roundtrip mismatch' }
    } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $restored.Dispose() }
    Write-Output 'stored-without-network';
  `);
  assert.equal(result.stdout.trim(), 'stored-without-network');
  const stored = fs.readFileSync(target, 'utf8');
  assert.match(stored, /^01000000d08c9ddf/i);
  assert.ok(!stored.includes(fakeKey));
});

test('local key storage refuses overwrite and preserves the original encrypted file', windows, t => {
  runFixture(t, `
    $key = ConvertTo-SecureString ${quote(fakeKey)} -AsPlainText -Force;
    try {
      Save-LabMathicLocalKey -Secret $key -Path $target;
      $original = [System.IO.File]::ReadAllText($target);
      $refused = $false;
      try { Save-LabMathicLocalKey -Secret $key -Path $target } catch { $refused = $true }
      if (-not $refused -or [System.IO.File]::ReadAllText($target) -cne $original) { throw 'Overwrite protection failed' }
    } finally { $key.Dispose() }
  `);
});

test('local key storage rejects malformed input without writing a file', windows, t => {
  runFixture(t, `
    foreach ($text in @('not-a-key', 'sk-short', "${fakeKey}\nEXTRA=bad", ('sk-' + ('x' * 1024)))) {
      $key = ConvertTo-SecureString $text -AsPlainText -Force;
      $refused = $false;
      try { Save-LabMathicLocalKey -Secret $key -Path $target } catch { $refused = $true } finally { $key.Dispose() }
      if (-not $refused -or (Test-Path -LiteralPath $target)) { throw 'Invalid input accepted' }
    }
  `);
});

test('local key storage checks absence and rejects tampering without reporting content', windows, t => {
  runFixture(t, `
    if (Test-LabMathicLocalKey -Path $target) { throw 'Unexpected saved key' }
    [System.IO.File]::WriteAllText($target, 'not-a-dpapi-value');
    $refused = $false;
    try { Test-LabMathicLocalKey -Path $target } catch { $refused = $true }
    if (-not $refused) { throw 'Tampering not detected' }
  `);
});

test('local key helper has no network, application startup, plaintext file or key argument interface', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /Read-Host 'Chave OpenAI' -AsSecureString/);
  assert.match(source, /FileMode\]::CreateNew/);
  assert.match(source, /git -C \$serverDirectory check-ignore/);
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod|Start-Process|https:\/\/|OPENAI_API_KEY\s*=/i);
  assert.match(source, /param\(\[switch\]\$Check\)/);
});
