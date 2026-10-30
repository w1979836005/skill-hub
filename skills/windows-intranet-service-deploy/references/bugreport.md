# BugReport 实际部署案例（Windows 内网 + NSSM）

这是 `windows-intranet-service-deploy` 技能在本机落地时的实际参数和命令，供复盘/迁移参考。

## 环境

| 项 | 值 |
|---|---|
| 项目目录 | `E:\bug-report` |
| Python | `E:\bug-report\.venv\Scripts\python.exe` |
| Web 入口 | `app.main:app` |
| 端口 | `8000` |
| 服务名 | `BugReport` |
| NSSM | `E:\bug-report\tools\nssm.exe` |
| 服务账号 | `LocalSystem` |
| 启动类型 | `Automatic` |
| 本机内网 IP | `172.20.84.125`（以 `ipconfig` 为准） |
| 内网主机名 | `wangm.landi.landicorp.com` |
| 访问地址 | `http://172.20.84.125:8000/` |
| 健康检查 | `http://127.0.0.1:8000/api/health` |

## 下载 NSSM

本机用 winget 的便携包下载，再解压出 `win64\nssm.exe`：

```powershell
$tmp = "E:\bug-report\tools\nssm"
New-Item -ItemType Directory -Force $tmp | Out-Null

winget download --id NSSM.NSSM -e `
  --accept-source-agreements --accept-package-agreements `
  --download-directory $tmp

$zip = Get-ChildItem $tmp -Filter *.zip | Select-Object -First 1
Expand-Archive -Path $zip.FullName -DestinationPath "$tmp\extracted" -Force

$nssm = Get-ChildItem "$tmp\extracted" -Recurse -Filter nssm.exe |
  Where-Object { $_.FullName -match '\\win64\\' } |
  Select-Object -First 1

Copy-Item $nssm.FullName "E:\bug-report\tools\nssm.exe" -Force
E:\bug-report\tools\nssm.exe version
```

版本：

```text
NSSM 2.24-101-g897c7ad 64-bit 2017-04-26
```

## 停止旧进程

```powershell
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
  Where-Object { $_.CommandLine -like '*uvicorn*app.main:app*' } |
  ForEach-Object {
    Write-Host "Stop PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force
  }
```

## 注册服务

管理员 PowerShell：

```powershell
$nssm = "E:\bug-report\tools\nssm.exe"

& $nssm install BugReport "E:\bug-report\.venv\Scripts\python.exe" `
  "-m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1"

& $nssm set BugReport AppDirectory "E:\bug-report"
& $nssm set BugReport AppStdout "E:\bug-report\logs\service.out.log"
& $nssm set BugReport AppStderr "E:\bug-report\logs\service.err.log"
& $nssm set BugReport AppRotateFiles 1
& $nssm set BugReport AppRotateBytes 10485760
& $nssm set BugReport Start SERVICE_AUTO_START
& $nssm set BugReport Description "BugReport 内网服务"

& $nssm start BugReport
```

实际安装输出：

```text
Service "BugReport" installed successfully!
Set parameter "AppDirectory" for service "BugReport".
Set parameter "AppStdout" for service "BugReport".
Set parameter "AppStderr" for service "BugReport".
Set parameter "Start" for service "BugReport".
BugReport: START: 操作成功完成。
SERVICE_RUNNING
```

## 防火墙

规则名：

```text
BugReport 8000
```

管理员 PowerShell：

```powershell
if (Get-NetFirewallRule -DisplayName "BugReport 8000" -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -DisplayName "BugReport 8000" -Enabled True -Action Allow -Direction Inbound
} else {
    New-NetFirewallRule `
      -DisplayName "BugReport 8000" `
      -Direction Inbound `
      -Protocol TCP `
      -LocalPort 8000 `
      -Action Allow
}
```

验证：

```powershell
Get-NetFirewallRule -DisplayName "BugReport 8000" |
  Select-Object DisplayName, Enabled, Direction, Action, Profile

Get-NetFirewallRule -DisplayName "BugReport 8000" |
  Get-NetFirewallPortFilter |
  Select-Object Protocol, LocalPort
```

## 验证

```powershell
Get-Service BugReport | Format-List Name, Status, StartType
E:\bug-report\tools\nssm.exe status BugReport
curl.exe --noproxy "*" http://127.0.0.1:8000/api/health
```

结果：

```text
Status    : Running
StartType : Automatic

SERVICE_RUNNING

{"code":0,"data":"bug-report v1.0.0","message":"服务健康启动"}
```

监听：

```powershell
Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

结果类似：

```text
LocalAddress LocalPort OwningProcess
0.0.0.0            8000         27728
```

## 本次遇到的坑

### 1. 两个 python 进程不是重复启动

实际看到：

```text
PID 26500  E:\bug-report\.venv\Scripts\python.exe -m uvicorn ...
PID 27728  C:\Users\wangm\AppData\Roaming\uv\python\...\python.exe -m uvicorn ...
```

`26500` 是 uv 的 venv 启动器，`27728` 是实际监听子进程。  
不要只杀 `26500`，用 `nssm stop` 或按命令行匹配一起停。

### 2. `Get-NetTCPConnection -State Listen` 查不到

本机查询时 `State` 字段可能为空，`netstat` 只显示 `TIME_WAIT`，但服务实际正常。  
判断标准改成：

```powershell
Get-NetTCPConnection -LocalPort 8000 |
  Select-Object LocalAddress, LocalPort, OwningProcess

curl.exe --noproxy "*" http://127.0.0.1:8000/api/health
```

### 3. 看不到 `Uvicorn running`

项目把 `uvicorn.error` 压到 WARNING：

```python
logging.getLogger("uvicorn.error").setLevel(logging.WARNING)
```

启动日志只显示：

```text
服务启动：...
已托管 web 前端：...
```

这是正常的，用健康检查判断。

### 4. 普通用户不能启停服务

普通 PowerShell：

```text
Can't open service! OpenService()
```

启停/重启必须用管理员 PowerShell：

```powershell
E:\bug-report\tools\nssm.exe restart BugReport
```

## 日志

应用日志：

```text
E:\bug-report\logs\default.log
E:\bug-report\logs\error.log
E:\bug-report\logs\error.csv
E:\bug-report\logs\result.csv
```

服务输出：

```text
E:\bug-report\logs\service.out.log
E:\bug-report\logs\service.err.log
```

安装过程日志：

```text
E:\bug-report\logs\install_service.log
```

实时看：

```powershell
Get-Content E:\bug-report\logs\service.out.log -Tail 100 -Wait
Get-Content E:\bug-report\logs\service.err.log -Tail 100 -Wait
```

## 访问

```text
http://172.20.84.125:8000/
http://wangm.landi.landicorp.com:8000/
```

其他设备验证：

```powershell
Test-NetConnection 172.20.84.125 -Port 8000
```

## 卸载

```powershell
E:\bug-report\tools\nssm.exe stop BugReport
E:\bug-report\tools\nssm.exe remove BugReport confirm
```

默认不删除数据库、日志、代码。  
防火墙规则需要另外删：

```powershell
Remove-NetFirewallRule -DisplayName "BugReport 8000"
```