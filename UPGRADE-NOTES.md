# 本次改动说明

## 1. 上游 muse2api 升级 1.6.9 → 1.6.12

`upstream/muse2api` 是 vendored 的上游源码，平台作者在 1.6.9 上做过简化改造，所以**不能直接覆盖**，用三方合并处理：

**合并方式**

1. 以官方 `v1.6.9` 为基线，把平台作者的版本作为一次提交
2. merge 官方 `v1.6.12`
3. 3 处冲突，处理结果：

| 文件 | 冲突原因 | 处理 |
|---|---|---|
| `app.py` | 上游新增排队租约（`QUEUE_POLICY` / `on_queue`），作者把参数硬编码 | 采用上游新版（上游本身已带 `rotate=True`，等价） |
| `engine.py` | 发送按钮点击实现，上游改为共用选择器常量 | 采用上游新版（返回值 `clicked`/`disabled`/`no-button` 约定一致） |
| `README.md` | 文档改动 | 采用上游新版 |

`config.py`、`store.py` 自动合并成功，作者的定制（并发默认值、账号粘性逻辑）保留。

**新版带来的能力**

- 生成队列（`/admin/generation-queue`）
- 视频缩略图（`/v1/media/{name}/thumbnail`，依赖 ffmpeg）
- 会话 cookie 轮换
- 版本上报（`/v1/models` 等接口带版本）
- 图片全屏查看器

**依赖**：`requirements.txt` 无变化，不需要重装 Python 包。

## 2. 修掉上游仍存在的 MIME bug

`get_media` 没指定 `media_type`，`.webp` 会以 `application/octet-stream` 返回，导致「把生成图当下一镜参考图」时上游判定「不是图片」并返回 400。

已在 `app.py` 的 `get_media` 加入扩展名 → MIME 映射（`.webp` / `.mp4` / `.png` 等）。

> 这个 bug 在 1.6.12 官方版里依然存在，属于上游问题，值得单独提 issue。

## 3. 新增 MCP 桥接层 `mcp/`

单文件 `mcp/server.py`，零依赖（只用标准库），把平台 HTTP 接口包成 MCP 工具：

`platform_health` / `platform_accounts` / `platform_meta` / `generate_video` / `generate_image` / `job_status` / `list_jobs`

配置见 `mcp/README.md`。已实测：握手成功、7 个工具可用、平台未启动时返回可读错误。

## 还没做的验证

端到端没跑过，因为平台要占用 `18610` 端口，和现有那套 muse2api 网关冲突。需要先停旧网关再 `.\start.ps1`。
