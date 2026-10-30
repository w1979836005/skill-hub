param(
    [string]$ProjectDir = "E:\bug-report",
    [string]$ServiceName = "BugReport",
    [int]$Port = 8000,
    [string]$NssmPath = "",
    [switch]$KeepFirewallRule
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$ProjectDir = (Resolve-Path -Path $ProjectDir).Path

if (-not (Test-IsAdmin)) {
    Write-Host "Administrator rights required. Requesting UAC..." -ForegroundColor Yellow
    $argList = @(
        "-NoProfile",
        "-ExecutionPolicy Bypass",
        "-File `"$PSCommandPath`"",
        "-ProjectDir `"$ProjectDir`"",
        "-ServiceName `"$ServiceName`"",
        "-Port $Port"
    )
    if ($NssmPath) { $argList += "-NssmPath `"$NssmPath`"" }
    if ($KeepFirewallRule) { $argList += "-KeepFirewallRule" }

    Start-Process powershell.exe -Verb RunAs -ArgumentList ($argList -join " ")
    exit 0
}

if (-not $NssmPath) {
    $NssmPath = Join-Path $ProjectDir "tools\nssm.exe"
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Stopping service '$ServiceName'..."
    if (Test-Path $NssmPath) {
        & $NssmPath stop $ServiceName | Out-Host
        Start-Sleep -Seconds 2
        & $NssmPath remove $ServiceName confirm | Out-Host
    } else {
        Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        & sc.exe delete $ServiceName | Out-Host
    }
} else {
    Write-Host "Service not found: $ServiceName"
}

if (-not $KeepFirewallRule) {
    $ruleName = "$ServiceName $Port"
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
        Write-Host "Removing firewall rule '$ruleName'..."
        Remove-NetFirewallRule -DisplayName $ruleName
    } else {
        Write-Host "Firewall rule not found: $ruleName"
    }
}

Write-Host ""
Write-Host "Service removed. Database, logs and code were NOT deleted." -ForegroundColor Green
Write-Host "Logs: $(Join-Path $ProjectDir 'logs')"