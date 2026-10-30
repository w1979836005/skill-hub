param(
    [string]$ProjectDir = "E:\bug-report",
    [string]$ServiceName = "BugReport",
    [int]$Port = 8000,
    [string]$NssmPath = "",
    [string]$HealthPath = "/api/health"
)

$ErrorActionPreference = "Continue"

if (-not $NssmPath) {
    $NssmPath = Join-Path $ProjectDir "tools\nssm.exe"
}
$RuleName = "$ServiceName $Port"
$HealthUrl = "http://127.0.0.1:$Port$HealthPath"
$failed = $false

Write-Host "== Service =="
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    $service | Format-List Name, Status, StartType
    if ($service.Status -ne "Running") { $failed = $true }
} else {
    Write-Host "Service not found: $ServiceName" -ForegroundColor Red
    $failed = $true
}

Write-Host "== NSSM config =="
if (Test-Path $NssmPath) {
    if ($service) {
        & $NssmPath status $ServiceName
        & $NssmPath get $ServiceName Application
        & $NssmPath get $ServiceName AppParameters
        & $NssmPath get $ServiceName AppDirectory
        & $NssmPath get $ServiceName Start
    }
} else {
    Write-Host "NSSM not found: $NssmPath" -ForegroundColor Yellow
}

Write-Host "== Listener =="
$listeners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess
if ($listeners) {
    $listeners | Format-Table -AutoSize
} else {
    Write-Host "No listener found on port $Port" -ForegroundColor Yellow
    $failed = $true
}

Write-Host "== Health =="
$body = & curl.exe --noproxy "*" -sS -m 5 $HealthUrl 2>$null
if ($LASTEXITCODE -eq 0 -and $body) {
    Write-Host $body
} else {
    Write-Host "Health check failed: $HealthUrl" -ForegroundColor Red
    $failed = $true
}

Write-Host "== Firewall =="
$rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($rule) {
    $rule | Select-Object DisplayName, Enabled, Direction, Action, Profile | Format-List
    $rule | Get-NetFirewallPortFilter | Select-Object Protocol, LocalPort | Format-List
} else {
    Write-Host "Firewall rule not found: $RuleName" -ForegroundColor Yellow
    $failed = $true
}

Write-Host "== Access URLs =="
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress -Unique

foreach ($ip in $ips) {
    Write-Host "  http://$ip`:$Port/"
}

Write-Host "== Logs =="
$outLog = Join-Path $ProjectDir "logs\service.out.log"
$errLog = Join-Path $ProjectDir "logs\service.err.log"
Write-Host "  $outLog"
Write-Host "  $errLog"
if ($failed) {
    Write-Host ""
    Write-Host "Recent service error log:" -ForegroundColor Yellow
    Get-Content $errLog -Tail 30 -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ""
Write-Host "OK" -ForegroundColor Green
exit 0