# MCP 桥接层

把平台后端（`http://127.0.0.1:8787`）的 HTTP 接口包成 MCP 工具，让 WorkBuddy / Claude Code / Codex 直接调用。

单文件、零依赖，只用 Python 标准库，不需要 `pip install` 任何东西。

## 工具

| 工具 | 作用 |
|---|---|
| `platform_health` | 检查平台是否在线 |
| `platform_accounts` | 列出已导入的 muse 账号与状态、额度 |
| `platform_meta` | 支持的时长、画幅、模型 |
| `generate_video` | 提交视频任务，返回 job |
| `generate_image` | 提交图片任务，返回 job |
| `job_status` | 查单个任务进度与结果 |
| `list_jobs` | 最近任务列表 |
| `canvas_list` | 列出服务端画布 |
| `canvas_create` | 新建画布 |
| `canvas_get` | 读取画布完整内容 |
| `canvas_ops` | 批量操作画布（建节点/改文字/移动/连线/删除） |
| `canvas_replace` | 整体覆盖画布（慎用） |

### 画布操作语义

`canvas_ops` 的 `ops` 与前端 AI 助手完全一致：

```json
{"op":"add_text","x":420,"y":240,"text":"镜头1","as":"s1"}
{"op":"add_text","x":740,"y":240,"text":"镜头2","as":"s2"}
{"op":"link","from":"s1","to":"s2"}
```

`as` 是本批次别名，`link` 可用别名引用，因此一轮就能"建 N 个节点并串起来"。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PLATFORM_BASE` | `http://127.0.0.1:8787` | 平台地址 |
| `PLATFORM_EMAIL` | `admin@muse.local` | 登录邮箱 |
| `PLATFORM_PASSWORD` | `admin123456` | 登录密码，**改过平台密码就要同步改这里** |
| `PLATFORM_TOKEN` | 空 | 已有 JWT 可直接填，省一次登录 |

## 接入 WorkBuddy

`~/.workbuddy/mcp.json`：

```json
{
  "mcpServers": {
    "museapi-video": {
      "command": "D:\\muse-canvas\\muse2api\\venv\\Scripts\\python.exe",
      "args": ["D:\\muse-canvas\\museAPI-video2\\mcp\\server.py"],
      "env": {
        "PLATFORM_BASE": "http://127.0.0.1:8787",
        "PLATFORM_EMAIL": "admin@muse.local",
        "PLATFORM_PASSWORD": "admin123456"
      }
    }
  }
}
```

`command` 用任意 Python 3.10+ 的绝对路径即可（Windows 下别用 `python`，那是 Microsoft Store 占位符）。

## 手工调试

MCP 走 stdio JSON-RPC，可以直接喂：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | python mcp/server.py
```

平台没启动时会返回：`连不上平台 ... （先启动 start.ps1）`。

## 注意

- **前提是平台在跑**：`.\start.ps1`。MCP 只是客户端，不做生成。
- 生成消耗账号积分，平台会先校验余额（不足返回 402）。
- 视频任务异步：`generate_video` 返回 job 后要 `job_status` 轮询。
