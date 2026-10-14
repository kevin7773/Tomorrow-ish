[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProtectedAuthorizationPath,
    [string]$PrivateDirectory = '.release/private/notification-acceptance',
    [string]$ServerDirectory = 'dist/server'
)

$ErrorActionPreference = 'Stop'
$plainAuthorization = $null
$process = $null
$completed = $false
$stage = 'protected-input'
$generatedFiles = @(
    (Join-Path $ServerDirectory 'wrangler.acceptance.json'),
    (Join-Path $ServerDirectory 'wrangler.acceptance.pause.json'),
    (Join-Path $ServerDirectory 'wrangler.acceptance.restore.json')
)

function Protect-OperatorFile([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.WindowsIdentity]::GetCurrent().Name,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

try {
    $stage = 'protected-input-read'
    $cipherText = (Get-Content -LiteralPath $ProtectedAuthorizationPath -Raw).Trim()
    $stage = 'protected-input-decrypt'
    $secureStringCommand = Get-Command ConvertTo-SecureString -ErrorAction Stop
    $secureAuthorization = & $secureStringCommand -String $cipherText
    $stage = 'protected-input-memory-transfer'
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAuthorization)
    try { $plainAuthorization = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }

    $stage = 'in-memory-validation'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command node).Source
    $start.ArgumentList.Add((Resolve-Path 'scripts/release/prepare-notification-acceptance-transition.mjs').Path)
    foreach ($argument in @('--private-dir', $PrivateDirectory, '--server-dir', $ServerDirectory)) {
        $start.ArgumentList.Add($argument)
    }
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    $process.StandardInput.Write((@{ authorizationId = $plainAuthorization } | ConvertTo-Json -Compress))
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw $stderr.Trim() }
    $stage = 'local-file-protection'
    foreach ($path in $generatedFiles) { Protect-OperatorFile (Resolve-Path $path).Path }
    Protect-OperatorFile (Resolve-Path (Join-Path $PrivateDirectory 'production-baseline.acceptance-enabled.json')).Path
    Protect-OperatorFile (Resolve-Path (Join-Path $PrivateDirectory 'preparation-redacted.json')).Path
    $completed = $true
    Write-Output $stdout.Trim()
}
catch {
    $failureType = $_.Exception.GetType().FullName
    $failureCode = $_.Exception.HResult
    if (-not $completed) {
        foreach ($path in $generatedFiles) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $PrivateDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw "Acceptance-transition preparation failed closed at stage $stage ($failureType/$failureCode). Protected input was not disclosed."
}
finally {
    $plainAuthorization = $null
    if ($process) { $process.Dispose() }
}
