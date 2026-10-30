---
name: windows-intranet-service-deploy
description: Deploy a Windows intranet service (FastAPI/uvicorn or another long-running console app) and register it with NSSM as an auto-start Windows service. Covers prerequisites, foreground/background start, health checks, Windows Firewall inbound rules, NSSM download/install, service logs, LAN access verification, upgrades, uninstall, and the Windows-specific traps (single worker, LocalSystem environment, parent/child Python processes, TIME_WAIT vs LISTENING). Use when a local Python web service must be reachable from other machines on the LAN and survive a reboot.
license: MIT
compatibility: Windows 10/11, PowerShell 5.1+, Python virtualenv, NSSM (the installer can fetch it with winget). Run install/uninstall in an elevated PowerShell.
---

# Windows Intranet Service Deploy

把本机的 Python Web 服务（FastAPI / uvicorn）变成：

- 内网其他机器能访问；
- Windows 服务，开机自动启动；
- 有固定日志、可查询、可重启、可卸载。

适合：BugReport、内部工具、测试平台、任何用 `python -m uvicorn ...` 跑起来的服务。

---

## 什么时候用

- 服务已经能在 `http://127.0.0.1:8000` 跑，但别的机器访问不了；
- 电脑重启后服务不会自己起来；
- `nssm` 注册服务、防火墙、日志路径每次都要重新查；
- 服务注册后启动失败，需要区分“端口没监听 / 防火墙没放行 / 服务卡住”。

不适合：只在本机临时跑一次、不需要开机自启的场景。

---

## 最快用法

在**管理员 PowerShell**里执行（脚本会自动申请 UAC，也可以先手动以管理员打开）：

```powershell
cd <skill目录>\scripts

.\install-service.ps1 `
  -ProjectDir "E:\bug-report" `
  -ServiceName "BugReport" `
  -Port 8000 `
  -ForceReinstall
```

然后验证：

```powershell
.\verify.ps1 `
  -ProjectDir "E:\bug-report" `
  -ServiceName "BugReport" `
  -Port 8000
```

脚本做这些事：

1. 检查管理员权限，必要时弹 UAC；
2. 检查 `.venv\Scripts\python.exe`；
3. 没有 NSSM 时用 `winget download` 下载并解压到 `$ProjectDir\tools\nssm.exe`；
4. 停止旧的 uvicorn 进程；
5. 停止并移除同名旧服务（`-ForceReinstall` 时）；
6. `nssm install` + 设置工作目录、日志、自动启动；
7. 添加入站防火墙规则；
8. 启动服务；
9. 轮询 `/api/health` 验证；
10. 打印内网访问地址。

如果 PowerShell 拦截脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-service.ps1 `
  -ProjectDir "E:\bug-report" -ServiceName "BugReport" -Port 8000
```

---

## 脚本一览

| 脚本 | 作用 | 是否需要管理员 |
|---|---|---|
| `scripts/install-service.ps1` | 下载 NSSM、注册服务、防火墙、启动、健康检查 | 是（脚本可弹 UAC） |
| `scripts/verify.ps1` | 查服务、端口、健康检查、防火墙、访问地址 | 否 |
| `scripts/uninstall-service.ps1` | 停止/删除服务，可选删除防火墙规则 | 是（脚本可弹 UAC） |

---

## 手动流程（脚本失败时照这个排查）

### 1. 先确认项目自己能跑

```powershell
cd E:\bug-report
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

另开一个 PowerShell：

```powershell
curl.exe --noproxy "*" http://127.0.0.1:8000/api/health
```

必须返回业务健康信息，再继续注册服务。  
如果这一步就失败，先解决项目本身，不要先动 NSSM 和防火墙。

### 2. 检查前置文件

```powershell
dir E:\bug-report\.env
dir E:\bug-report\private.pem, E:\bug-report\public.pem
dir E:\bug-report\frontend\dist\index.html
```

后端 `.env` 里要有数据库、日志目录、Jira/LLM 配置；前端若是同端口托管，`frontend/dist` 必须存在。

### 3. 停掉旧的 uvicorn

```powershell
Get-CimInstance Win32_Process -Filter "name='python.exe'" |
  Where-Object { $_.CommandLine -like '*uvicorn*app.main:app*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 4. 放行防火墙

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
  Get-NetFirewallPortFilter |
  Select-Object Protocol, LocalPort
```

### 5. 获取 NSSM

优先用脚本自动下载。手动方式：

```powershell
$tmp = "$env:TEMP\nssm-download"
New-Item -ItemType Directory -Force $tmp | Out-Null

winget download --id NSSM.NSSM -e `
  --accept-source-agreements --accept-package-agreements `
  --download-directory $tmp

$zip = Get-ChildItem $tmp -Filter *.zip | Select-Object -First 1
$extract = "$tmp\extract"
Expand-Archive -Path $zip.FullName -DestinationPath $extract -Force

$nssm = Get-ChildItem $extract -Recurse -Filter nssm.exe |
  Where-Object { $_.FullName -match '\\win64\\' } |
  Select-Object -First 1

New-Item -ItemType Directory -Force "E:\bug-report\tools" | Out-Null
Copy-Item $nssm.FullName "E:\bug-report\tools\nssm.exe" -Force

E:\bug-report\tools\nssm.exe version
```

如果机器没有 `winget`，从内部软件源获取 NSSM 2.24+ 的 `win64\nssm.exe`，放到 `E:\bug-report\tools\nssm.exe`。

### 6. 注册服务

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

### 7. 验证

```powershell
Get-Service BugReport | Format-List Name,Status,StartType
E:\bug-report\tools\nssm.exe status BugReport
curl.exe --noproxy "*" http://127.0.0.1:8000/api/health
```

应看到：

```text
Status    : Running
StartType : Automatic
```

监听检查：

```powershell
Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

重点看 `0.0.0.0:8000` 和 `OwningProcess`。  
这台机器上 `State` 可能为空，`netstat` 可能只显示 `TIME_WAIT`，**以健康检查为准**。

---

## 关键规则

### 1. 只能 `--workers 1`

FastAPI 服务若使用 SQLite、进程内 token 缓存、内存锁、信号量，必须单 worker。多 worker 会导致：

- 登录态在 A worker，请求打到 B worker → 401；
- 同用例锁失效；
- SQLite 写冲突概率变高。

### 2. NSSM 服务默认用 LocalSystem

LocalSystem 没有当前用户的 `HTTP_PROXY` / `HTTPS_PROXY` / PATH 等环境变量。  
如果服务依赖代理，需要在 NSSM 的 `AppEnvironmentExtra` 里显式配置，或在启动脚本里设置。

### 3. 两个 python 进程是正常的

`.venv\Scripts\python.exe` 如果是 uv 创建的启动器，会再拉起 uv 管理的 base Python。  
所以正常运行时可能看到：

```text
PID A  E:\project\.venv\Scripts\python.exe -m uvicorn ...
PID B  C:\Users\...\uv\python\...\python.exe -m uvicorn ...
```

这是父/子进程，不是重复启动。停止服务时用 `nssm stop`，不要只杀一个。

### 4. 看不到 `Uvicorn running` 是正常的

项目常把 `uvicorn.error` 日志压到 WARNING，启动日志只剩自己的 INFO。  
不要用“有没有 Uvicorn running”判断服务是否成功，用：

```powershell
curl.exe --noproxy "*" http://127.0.0.1:8000/api/health
```

### 5. `TIME_WAIT` 不是监听

```text
TCP 127.0.0.1:54328 127.0.0.1:8000 TIME_WAIT 0
```

这是客户端连接残留，不是服务在监听。只有 `LISTENING` 或健康检查成功才算端口打开。

### 6. 启停服务需要管理员

普通 PowerShell 可以查：

```powershell
Get-Service BugReport
E:\bug-report\tools\nssm.exe status BugReport
```

但 `start / stop / restart / remove` 需要管理员 PowerShell，否则会出现：

```text
Can't open service! OpenService()
```

---

## 日志位置

### 应用日志

```text
<ProjectDir>\logs\default.log
<ProjectDir>\logs\error.log
<ProjectDir>\logs\error.csv
<ProjectDir>\logs\result.csv
```

### 服务控制台日志（NSSM）

```text
<ProjectDir>\logs\service.out.log
<ProjectDir>\logs\service.err.log
```

实时看：

```powershell
Get-Content E:\bug-report\logs\service.out.log -Tail 100 -Wait
Get-Content E:\bug-report\logs\service.err.log -Tail 100 -Wait
```

排障顺序：

1. `service.err.log`：启动失败、端口绑定失败；
2. `service.out.log`：标准输出、访问日志；
3. `default.log`：业务日志；
4. `error.log`：异常和失败；
5. `result.csv`：请求/响应留痕。

---

## 内网访问验证

本机：

```powershell
curl.exe --noproxy "*" http://127.0.0.1:8000/api/health
```

本机 IP：

```powershell
ipconfig | findstr IPv4
```

另一台内网设备：

```powershell
Test-NetConnection 172.20.84.125 -Port 8000
```

浏览器：

```text
http://172.20.84.125:8000/
```

如果本机能访问、别的机器不行，按顺序查：

1. 服务是否监听 `0.0.0.0:8000`；
2. 防火墙规则是否启用；
3. 两台机器是否同一网段/VPN；
4. 杀毒/终端安全软件是否拦截；
5. 本机 IP 是否变化。

---

## 升级服务

```powershell
E:\bug-report\tools\nssm.exe stop BugReport

cd E:\bug-report
git pull
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

cd frontend
npm ci
npm run build
cd ..

E:\bug-report\tools\nssm.exe start BugReport
```

如果依赖/路径没变，不需要重新 `nssm install`。

---

## 卸载

```powershell
cd <skill目录>\scripts
.\uninstall-service.ps1 -ServiceName BugReport -Port 8000
```

默认会停止/删除服务并删除防火墙规则，**不会删除**数据库、日志、代码。  
需要保留防火墙规则时加 `-KeepFirewallRule`。

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `Get-NetTCPConnection -State Listen` 查不到，但 curl 通 | Windows 查询怪癖 / 状态字段为空 | 用 `Get-NetTCPConnection -LocalPort 8000` 或健康检查 |
| `netstat` 只有 `TIME_WAIT` | 客户端残留，不是监听 | 重新启动服务并看健康检查 |
| 启动日志停在三行，没有 Uvicorn 日志 | 项目压掉了 uvicorn.error | 正常；用 curl 验证 |
| `[WinError 10048]` / `10013` | 端口被占用或被系统保留 | `netstat -ano | findstr :8000`；`netsh interface ipv4 show excludedportrange protocol=tcp`；换 8001 |
| `Can't open service! OpenService()` | 普通用户没有服务控制权限 | 用管理员 PowerShell |
| 服务启动但端口没监听 | 工作目录/参数/权限/环境变量问题 | 看 `service.err.log`；确认 `AppDirectory`、`AppParameters` |
| LocalSystem 下访问不了外部 API | 代理/证书/环境变量与当前用户不同 | 在 NSSM `AppEnvironmentExtra` 配置代理，或改用有权限的服务账号 |
| 服务名重复 | 已注册过 | 加 `-ForceReinstall`，或先 `nssm remove BugReport confirm` |

---

## BugReport 实际案例

本机这次部署的完整命令、当前 IP、服务名、日志路径和踩坑记录：

[`references/bugreport.md`](references/bugreport.md)

核心值：

```text
项目：E:\bug-report
服务：BugReport
端口：8000
NSSM：E:\bug-report\tools\nssm.exe
日志：E:\bug-report\logs\service.out.log / service.err.log
访问：http://172.20.84.125:8000/
```

内网 IP 会变，以 `ipconfig` 为准；防火墙规则和服务注册会保留。