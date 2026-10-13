[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string]$LiveSnapshot,
    [Parameter(Mandatory = $true)][string]$Evidence,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Message
)

$ErrorActionPreference = 'Stop'

function Convert-ProtectedValue([Security.SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$secureValues = @{}
$plainValues = @{}
$process = $null
try {
    foreach ($name in @(
        'EDITORIAL_NOTIFICATION_TO_EMAIL',
        'RESEND_API_KEY',
        'RESEND_WEBHOOK_SIGNING_SECRET',
        'REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN'
    )) {
        $secureValues[$name] = Read-Host "Enter protected value for $name" -AsSecureString
        $plainValues[$name] = Convert-ProtectedValue $secureValues[$name]
    }

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command node).Source
    $start.ArgumentList.Add((Resolve-Path 'scripts/release/provision-resend-secrets.mjs').Path)
    foreach ($argument in @(
        '--execute', '--commit', $Commit,
        '--live-snapshot', $LiveSnapshot,
        '--evidence', $Evidence,
        '--tag', $Tag,
        '--message', $Message
    )) { $start.ArgumentList.Add($argument) }
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true

    $process = [Diagnostics.Process]::Start($start)
    $process.StandardInput.Write(($plainValues | ConvertTo-Json -Compress))
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "Inactive secret-version provisioning stopped. Review the non-secret operator output; do not retry automatically. $stderr"
    }
    Write-Output $stdout
}
finally {
    foreach ($name in @($plainValues.Keys)) { $plainValues[$name] = $null }
    $plainValues.Clear()
    $secureValues.Clear()
    if ($process) { $process.Dispose() }
}
