# Explicit paid-test wrapper. The key travels only through the child's private stdin.
[CmdletBinding()]
param([switch]$LiveOnce)
$ErrorActionPreference = 'Stop'
$secret = $null
$pointer = [IntPtr]::Zero
$child = $null
$childStarted = $false
$stage = 'preflight'
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $serverDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $runner = Join-Path $PSScriptRoot 'localSmoke.cjs'
    $mode = '--offline'
    if ($LiveOnce) {
        . (Join-Path $PSScriptRoot 'storeLocalKey.ps1')
        & git -C $serverDirectory check-ignore --quiet -- '.env.openai-key.dpapi'
        if ($LASTEXITCODE -ne 0) { throw 'GIT_PROTECTION_REQUIRED' }
        $source = Join-Path $serverDirectory '.env.openai-key.dpapi'
        if (-not (Test-LabMathicLocalKey -Path $source)) { throw 'KEY_NOT_READY' }
        $secret = ConvertTo-SecureString ([System.IO.File]::ReadAllText($source))
        $mode = '--live-once'
    }
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $info.Arguments = '"' + $runner + '" ' + $mode
    $info.WorkingDirectory = $serverDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    foreach ($name in @($info.EnvironmentVariables.Keys)) {
        if ($name -match '^(OPENAI_|AI_|NODE_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)') {
            $info.EnvironmentVariables.Remove($name)
        }
    }
    $child = [System.Diagnostics.Process]::new()
    $child.StartInfo = $info
    $stage = 'start'
    if (-not $child.Start()) { throw 'START_FAILED' }
    $childStarted = $true
    $stage = 'execute'
    $outputTask = $child.StandardOutput.ReadToEndAsync()
    $errorTask = $child.StandardError.ReadToEndAsync()
    if ($LiveOnce) {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $child.StandardInput.WriteLine([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $pointer = [IntPtr]::Zero
    }
    $child.StandardInput.Close()
    if (-not $child.WaitForExit(60000)) { $child.Kill(); throw 'TEST_TIMEOUT_NO_RETRY' }
    $output = $outputTask.GetAwaiter().GetResult()
    $null = $errorTask.GetAwaiter().GetResult() # Never print an unexpected runtime exception.
    Write-Output $output
    if ($child.ExitCode -ne 0) { Write-Output 'Teste nao concluido. Nao repetir sem analisar a tentativa.' }
    exit $child.ExitCode
} catch {
    Write-Output ('Teste interrompido na etapa ' + $stage + '. Nao repetir sem conferir se houve tentativa registrada.')
    exit 1
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($null -ne $secret) { $secret.Dispose() }
    if ($null -ne $child) { if ($childStarted -and -not $child.HasExited) { $child.Kill() }; $child.Dispose() }
}
