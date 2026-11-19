# 兼容性测试报告

目标：**一套上游，两条操作路径** —— 画布侧能配 Agent（Codex），WorkBuddy 侧能直接调用，互不抢占端口。

测试时间：2026-11-19 / Windows 11 / Node 22.22.2 / Python 3.12 / muse2api 1.6.12

## 端口拓扑

| 端口 | 服务 | 作用 |
|---|---|---|
| 18610 | muse2api（**唯一实例**） | 所有生成请求的唯一出口 |
| 3000 | 无限画布前端 | 画布 UI |
| 17371 | Canvas Agent | Codex 侧边栏 agent |
| 8787 | 平台后端 | MuseAPI-Video（复用 18610，**不再起自己的上游**） |

关键点：平台 `start.ps1` 会先探测 18610，**已在运行就跳过启动自己的上游**，所以两边共用同一个 18610，不会抢端口、不会出现两套 Chrome 会话。

## 测试项与结果

| # | 路径 | 操作 | 结果 |
|---|---|---|---|
| 1 | 网关 | `GET /healthz` | ✅ 200 |
| 2 | 画布生成 | `POST /v1/images/generations` | ✅ 返回 `55637f60….webp` |
| 3 | 画布前端 | `GET :3000` | ✅ 200 |
| 4 | Agent 服务 | `GET :17371` | ✅ 401（有响应即活，需 token） |
| 5 | 画布 MCP | `tools/list` | ✅ 34 个工具，含 `canvas_generate_*` / `workbench_*` |
| 6 | 平台健康 | `GET :8787/api/health` | ✅ `upstream: http://127.0.0.1:18610` |
| 7 | 平台登录 | `POST /api/auth/login` | ✅ 返回 JWT（187 字符） |
| 8 | 平台选项 | `GET /api/meta` | ✅ 时长 5/6/8/10，画幅 5 种 |
| 9 | 平台 MCP 只读 | `platform_health` / `meta` / `accounts` | ✅ 账号池读到 `5731486a4e60` |
| 10 | 平台 MCP 写 | `generate_image` → `job_status` | ✅ job 完成，产物 `/media/job_98c855cdd070d71dd3.webp` |

## 两条路径怎么用

**A. 画布 + Agent（Codex）**

1. `start-canvas.bat` → 3000
2. `start-agent.bat` → 17371，窗口里拿 token
3. 画布 Agent 设置填 `http://127.0.0.1:17371` + token
4. 侧边栏对话，Codex 通过 canvas MCP 操作画布

**B. WorkBuddy 直接操作**

1. `start-platform.bat` → 8787（自动复用 18610）
2. 重启 WorkBuddy，连接器页信任 `museapi-video` / `infinite-canvas`
3. 对话直接调 `generate_video` / `generate_image` / `job_status`

两条路径共用 18610 的账号池和额度，互不冲突。

## 配置要点

平台 `server/.env`：

```ini
MUSE_BASE=http://127.0.0.1:18610
MUSE_KEY=<必须与 D:\muse-canvas\muse2api\.env 里的 MUSE2API_KEY 完全一致>
```

**key 不一致 = 平台所有生成都会 401**，这是最容易踩的坑。

## 已知边界

- **不要同时跑两个 muse2api**：会抢 18610，且两套 Chrome 会话会互相挤掉 muse 登录态
- 平台默认管理员 `admin@muse.local / admin123456`，上线前必须改，同时改 `JWT_SECRET`
- 平台前端产物（`web/dist`）本次未构建，UI 需要 `.\start.ps1 -Build` 或 `npm run build`
- 画布数据仍在浏览器 IndexedDB（平台侧有自己的作品库，是两套存储）

## 复现命令

```powershell
# 1 上游
cd D:\muse-canvas\muse2api; .\start-muse.bat

# 2 画布（可选，走路径 A 才需要）
cd D:\muse-canvas\infinite-canvas; .\start-canvas.bat
cd D:\muse-canvas\canvas-agent-mcp; .\start-agent.bat

# 3 平台（自动复用 18610）
cd D:\muse-canvas\museAPI-video2\server; node src\index.js

# 4 验证
curl http://127.0.0.1:18610/healthz
curl http://127.0.0.1:8787/api/health
```
