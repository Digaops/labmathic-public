# Local Windows storage only. This script never starts the app or calls an API.
# Run normally to enter a key; -Check prints status without revealing the key.
[CmdletBinding()]
param([switch]$Check)

function Assert-LabMathicKeyPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ([System.IO.Path]::GetFileName($fullPath) -ne '.env.openai-key.dpapi') { throw 'INVALID_TARGET' }
    $directory = Get-Item -LiteralPath ([System.IO.Path]::GetDirectoryName($fullPath)) -Force -ErrorAction Stop
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'INVALID_DIRECTORY'
    }
    if (Test-Path -LiteralPath $fullPath) {
        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'INVALID_TARGET' }
    }
    return $fullPath
}

function Save-LabMathicLocalKey {
    param(
        [Parameter(Mandatory = $true)][System.Security.SecureString]$Secret,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $destination = Assert-LabMathicKeyPath -Path $Path
    if (Test-Path -LiteralPath $destination) { throw 'ALREADY_EXISTS' }
    $pointer = [IntPtr]::Zero
    $plain = $null
    try {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        # Format check only: it does not establish validity, permissions or credit.
        if ($plain.Length -lt 20 -or $plain.Length -gt 1024 -or $plain -cnotmatch '\Ask-[A-Za-z0-9_-]+\z') {
            throw 'INVALID_KEY_FORMAT'
        }
    } finally {
        $plain = $null
        if ($pointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    # Without -Key/-SecureKey, Windows protects this value with the current user's DPAPI.
    $protected = ConvertFrom-SecureString -SecureString $Secret -ErrorAction Stop
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($protected)
    $stream = $null
    try {
        # CreateNew also refuses an existing target if it appears after the check above.
        $stream = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    # The file already contains ciphertext only; restrict filesystem access as well.
    $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($userSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($userSid, $systemSid)) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    }
    Set-Acl -LiteralPath $destination -AclObject $acl -ErrorAction Stop
}

function Test-LabMathicLocalKey {
    param([Parameter(Mandatory = $true)][string]$Path)
    $source = Assert-LabMathicKeyPath -Path $Path
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $source -Force).Length -gt 32768) { throw 'INVALID_STORED_FILE' }
    $protected = [System.IO.File]::ReadAllText($source)
    if ($protected -cnotmatch '\A[0-9a-fA-F]+\z') { throw 'INVALID_STORED_FILE' }
    $secret = $null
    try {
        $secret = ConvertTo-SecureString -String $protected -ErrorAction Stop
        if ($secret.Length -lt 20 -or $secret.Length -gt 1024) { throw 'INVALID_STORED_FILE' }
        $acl = Get-Acl -LiteralPath $source -ErrorAction Stop
        if (-not $acl.AreAccessRulesProtected) { throw 'UNSAFE_FILE_PERMISSIONS' }
        $allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
        $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) {
                throw 'UNSAFE_FILE_PERMISSIONS'
            }
        }
        return $true
    } finally {
        if ($null -ne $secret) { $secret.Dispose() }
    }
}

# Dot-sourcing exposes helpers for offline tests without prompting or writing.
if ($MyInvocation.InvocationName -eq '.') { return }

$ErrorActionPreference = 'Stop'
$enteredKey = $null
try {
    $serverDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $destination = Join-Path $serverDirectory '.env.openai-key.dpapi'
    & git -C $serverDirectory check-ignore --quiet -- '.env.openai-key.dpapi'
    if ($LASTEXITCODE -ne 0) { throw 'GIT_PROTECTION_REQUIRED' }
    if ($Check) {
        if (Test-LabMathicLocalKey -Path $destination) {
            Write-Host 'OK: chave local protegida e legivel por este usuario do Windows.'
            Write-Host 'A validade na OpenAI nao foi testada. A integracao nao foi ativada.'
            exit 0
        }
        Write-Host 'PENDENTE: nenhuma chave foi armazenada por este assistente.'
        exit 2
    }
    $null = Assert-LabMathicKeyPath -Path $destination
    if (Test-Path -LiteralPath $destination) { throw 'ALREADY_EXISTS' }
    Write-Host 'LabMathic - guardar chave apenas neste computador'
    Write-Host 'Cole somente a chave no campo abaixo. Ela ficara oculta.'
    Write-Host 'Nenhuma chamada paga, alteracao de banco ou publicacao sera feita.'
    $enteredKey = Read-Host 'Chave OpenAI' -AsSecureString
    Save-LabMathicLocalKey -Secret $enteredKey -Path $destination
    if (-not (Test-LabMathicLocalKey -Path $destination)) { throw 'STORAGE_CHECK_FAILED' }
    Write-Host 'OK: chave guardada com protecao do Windows e fora do Git.'
    Write-Host 'A chave ainda NAO esta instalada no servidor de homologacao.'
    Write-Host 'Voce pode fechar este terminal. Nao envie a chave nem o arquivo pelo chat.'
} catch {
    # Never print exception details, stack, input or ciphertext to the transcript.
    Write-Host 'Nao foi possivel guardar/verificar a chave. Nenhuma API foi chamada.'
    Write-Host 'Se ja existe uma chave local, ela nao foi substituida. Avise pelo chat sem enviar segredos.'
    exit 1
} finally {
    if ($null -ne $enteredKey) { $enteredKey.Dispose() }
}
