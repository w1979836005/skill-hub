param(
    [string]$ProjectDir = "E:\bug-report",
    [string]$ServiceName = "BugReport",
    [int]$Port = 8000,
    [string]$PythonExe = "",
    [string]$NssmPath = "",
    [string]$AppModule = "app.main:app",
    [string]$HealthPath = "/api/health",
    [switch]$SkipFirewall,
    [switch]$ForceReinstall
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Resolve before UAC so the elevated child gets an absolute path.
$ProjectDir = (Resolve-Path -Path $ProjectDir).Path

if (-not (Test-IsAdmin)) {
    Write-Host "Administrator rights required. Requesting UAC..." -ForegroundColor Yellow
    $argList = @(
        "-NoProfile",
        "-ExecutionPolicy Bypass",
        "-File `"$PSCommandPath`"",
        "-ProjectDir `"$ProjectDir`"",
        "-ServiceName `"$ServiceName`"",
        "-Port $Port",
        "-AppModule `"$AppModule`"",
        "-HealthPath `"$HealthPath`""
    )
    if ($PythonExe) { $argList += "-PythonExe `"$PythonExe`"" }
    if ($NssmPath) { $argList += "-NssmPath `"$NssmPath`"" }
    if ($SkipFirewall) { $argList += "-SkipFirewall" }
    if ($ForceReinstall) { $argList += "-ForceReinstall" }

    Start-Process powershell.exe -Verb RunAs -ArgumentList ($argList -join " ")
    exit 0
}

if (-not $PythonExe) {
    $PythonExe = Join-Path $ProjectDir ".venv\Scripts\python.exe"
}
if (-not $NssmPath) {
    $NssmPath = Join-Path $ProjectDir "tools\nssm.exe"
}

$LogDir = Join-Path $ProjectDir "logs"
$ServiceOut = Join-Path $LogDir "service.out.log"
$ServiceErr = Join-Path $LogDir "service.err.log"
$RuleName = "$ServiceName $Port"
$ServiceArgs = "-m uvicorn $AppModule --host 0.0.0.0 --port $Port --workers 1"
$HealthUrl = "http://127.0.0.1:$Port$HealthPath"

Write-Host "Project : $ProjectDir"
Write-Host "Service : $ServiceName"
Write-Host "Port    : $Port"
Write-Host "Python  : $PythonExe"
Write-Host "NSSM    : $NssmPath"
Write-Host ""

if (-not (Test-Path $PythonExe)) {
    throw "Python executable not found: $PythonExe"
}
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Ensure-Nssm {
    param([string]$Path)

    if (Test-Path $Path) { return }

    Write-Host "NSSM not found at $Path. Trying winget download..." -ForegroundColor Yellow
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "NSSM is missing and winget is unavailable. Download NSSM 2.24+ win64\nssm.exe and place it at $Path."
    }

    $tmp = Join-Path $env:TEMP ("nssm-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $tmp | Out-Null

    & winget download --id NSSM.NSSM -e --accept-source-agreements --accept-package-agreements --download-directory $tmp | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "winget download failed with exit code $LASTEXITCODE"
    }

    $zip = Get-ChildItem $tmp -Filter *.zip | Select-Object -First 1
    if (-not $zip) {
        throw "winget download did not produce a zip file."
    }

    $extract = Join-Path $tmp "extract"
    Expand-Archive -Path $zip.FullName -DestinationPath $extract -Force

    $candidate = Get-ChildItem $extract -Recurse -Filter nssm.exe |
        Where-Object { $_.FullName -match '\\win64\\' } |
        Select-Object -First 1
    if (-not $candidate) {
        $candidate = Get-ChildItem $extract -Recurse -Filter nssm.exe | Select-Object -First 1
    }
    if (-not $candidate) {
        throw "nssm.exe was not found in the downloaded zip."
    }

    New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
    Copy-Item $candidate.FullName $Path -Force
    Write-Host "NSSM installed to $Path"
}

function Stop-AppProcesses {
    param([string]$Module)

    Get-CimInstance Win32_Process -Filter "name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*uvicorn*$Module*" } |
        ForEach-Object {
            Write-Host "Stopping old process PID $($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

Ensure-Nssm -Path $NssmPath

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if (-not $ForceReinstall) {
        throw "Service '$ServiceName' already exists. Re-run with -ForceReinstall to replace it."
    }
    Write-Host "Stopping and removing existing service '$ServiceName'..."
    & $NssmPath stop $ServiceName | Out-Host
    Start-Sleep -Seconds 2
    & $NssmPath remove $ServiceName confirm | Out-Host
    Start-Sleep -Seconds 2
}

Stop-AppProcesses -Module $AppModule
Start-Sleep -Seconds 1

Write-Host "Installing service '$ServiceName'..."
& $NssmPath install $ServiceName $PythonExe $ServiceArgs | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "nssm install failed with exit code $LASTEXITCODE"
}

& $NssmPath set $ServiceName AppDirectory $ProjectDir | Out-Null
& $NssmPath set $ServiceName AppStdout $ServiceOut | Out-Null
& $NssmPath set $ServiceName AppStderr $ServiceErr | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmPath set $ServiceName Description "$ServiceName intranet service" | Out-Null

if (-not $SkipFirewall) {
    Write-Host "Ensuring firewall rule '$RuleName'..."
    if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
        Set-NetFirewallRule -DisplayName $RuleName -Enabled True -Action Allow -Direction Inbound | Out-Null
    } else {
        New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
    }
}

Write-Host "Starting service..."
& $NssmPath start $ServiceName | Out-Host
Start-Sleep -Seconds 2

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service -or $service.Status -ne "Running") {
    Write-Warning "Service is not running. Recent logs:"
    Get-Content $ServiceErr -Tail 50 -ErrorAction SilentlyContinue
    Get-Content $ServiceOut -Tail 50 -ErrorAction SilentlyContinue
    throw "Service '$ServiceName' failed to start."
}

Write-Host "Waiting for health check: $HealthUrl"
$healthy = $false
$body = ""
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    $body = & curl.exe --noproxy "*" -sS -m 2 $HealthUrl 2>$null
    if ($LASTEXITCODE -eq 0 -and $body) {
        $healthy = $true
        break
    }
}

if (-not $healthy) {
    Write-Warning "Health check failed. Recent logs:"
    Get-Content $ServiceErr -Tail 50 -ErrorAction SilentlyContinue
    Get-Content $ServiceOut -Tail 50 -ErrorAction SilentlyContinue
    throw "Service is running but health check failed: $HealthUrl"
}

Write-Host ""
Get-Service -Name $ServiceName | Format-List Name, Status, StartType
Write-Host "Health : $body"
Write-Host "Logs   : $ServiceOut"
Write-Host "         $ServiceErr"

$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress -Unique

foreach ($ip in $ips) {
    Write-Host "LAN    : http://$ip`:$Port/"
}

Write-Host ""
Write-Host "Done. The service starts automatically at boot." -ForegroundColor Green