"""MuseAPI-Video 的 MCP 桥接层（单文件，零依赖，stdio JSON-RPC）。

把平台后端（默认 http://127.0.0.1:8787）的 HTTP 接口包成 MCP 工具，
让 WorkBuddy / Claude Code / Codex 这类客户端可以直接调用。

启动：
    python mcp/server.py
环境变量：
    PLATFORM_BASE      平台地址，默认 http://127.0.0.1:8787
    PLATFORM_EMAIL     登录邮箱，默认 admin@muse.local
    PLATFORM_PASSWORD  登录密码，默认 admin123456
    PLATFORM_TOKEN     已有 JWT 时可直接给，省一次登录
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("PLATFORM_BASE", "http://127.0.0.1:8787").rstrip("/")
EMAIL = os.environ.get("PLATFORM_EMAIL", "admin@muse.local")
PASSWORD = os.environ.get("PLATFORM_PASSWORD", "admin123456")
TOKEN = os.environ.get("PLATFORM_TOKEN", "")

_OPEN = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class HttpError(Exception):
    pass


def _call(method, path, body=None, auth=True, timeout=300):
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if auth and TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    try:
        with _OPEN.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise HttpError("HTTP %s %s: %s" % (e.code, path, detail))
    except urllib.error.URLError as e:
        raise HttpError("连不上平台 %s：%s（先启动 start.ps1）" % (BASE, e.reason))


def login():
    global TOKEN
    if TOKEN:
        return TOKEN
    out = _call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD}, auth=False)
    TOKEN = out.get("token") or (out.get("data") or {}).get("token") or ""
    if not TOKEN:
        raise HttpError("登录未返回 token：%s" % json.dumps(out, ensure_ascii=False)[:200])
    return TOKEN


def with_auth(path, method="GET", body=None, **kw):
    try:
        login()
        return _call(method, path, body, **kw)
    except HttpError as e:
        if "HTTP 401" in str(e):
            globals()["TOKEN"] = ""
            login()
            return _call(method, path, body, **kw)
        raise


TOOLS = [
    {
        "name": "platform_health",
        "description": "检查平台是否在线，返回服务状态与版本。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "platform_accounts",
        "description": "列出已导入的 muse 账号及其可用状态、额度。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "platform_meta",
        "description": "读取平台支持的时长、画幅、模型等可选项。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "generate_video",
        "description": "提交一个视频生成任务，返回 job（含 id 与状态）。生成较慢，用 job_status 轮询。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "画面描述，30~300 字，只写一个主动作"},
                "duration": {"type": "number", "description": "时长秒数，默认 5"},
                "size": {"type": "string", "description": "画幅，如 16:9 / 9:16，默认 16:9"},
                "model": {"type": "string", "description": "模型名，默认 muse-video"},
                "images": {"type": "array", "items": {"type": "string"},
                           "description": "参考图（首帧/尾帧）数组，可填 /api/upload 返回的地址"},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "generate_image",
        "description": "提交一个图片生成任务，返回 job。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "画面描述"},
                "size": {"type": "string", "description": "画幅或尺寸，默认 1:1"},
                "images": {"type": "array", "items": {"type": "string"}, "description": "参考图数组"},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "job_status",
        "description": "查询单个任务的进度与结果。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "job id"}},
            "required": ["id"],
        },
    },
    {
        "name": "list_jobs",
        "description": "列出最近的任务。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "canvas_list",
        "description": "列出平台上的画布（服务端存储），返回 id / 名称 / 节点数。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "canvas_create",
        "description": "新建一个画布，返回画布 id。",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "画布名称"}},
        },
    },
    {
        "name": "canvas_get",
        "description": "读取指定画布的完整内容（节点与连线）。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "画布 id"}},
            "required": ["id"],
        },
    },
    {
        "name": "canvas_ops",
        "description": (
            "对画布执行一批操作。可选 op："
            "add_text(x,y,text,as) / add_image(x,y,as) / add_video(x,y,text,as) / "
            "set_text(id,text) / move(id,x,y) / link(from,to) / delete(id) / "
            "generate_video 占位节点。add 的 as 是别名，同批次 link 可用别名引用。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "画布 id"},
                "ops": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "操作数组，例如 [{\"op\":\"add_text\",\"x\":420,\"y\":240,\"text\":\"镜头1\",\"as\":\"s1\"}]",
                },
            },
            "required": ["id", "ops"],
        },
    },
    {
        "name": "canvas_replace",
        "description": "整体覆盖画布内容（doc = {nodes:[], links:[]}）。慎用。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "画布 id"},
                "doc": {"type": "object", "description": "完整画布文档"},
            },
            "required": ["id", "doc"],
        },
    },
]


def dispatch(name, args):
    if name == "platform_health":
        return _call("GET", "/api/health", auth=False)
    if name == "platform_accounts":
        return with_auth("/api/accounts")
    if name == "platform_meta":
        return with_auth("/api/meta")
    if name == "generate_video":
        body = {"prompt": args.get("prompt", "")}
        for k in ("duration", "size", "model", "images"):
            if args.get(k) not in (None, "", []):
                body[k] = args[k]
        return with_auth("/api/videos", "POST", body, timeout=600)
    if name == "generate_image":
        body = {"prompt": args.get("prompt", "")}
        for k in ("size", "images"):
            if args.get(k) not in (None, "", []):
                body[k] = args[k]
        return with_auth("/api/images", "POST", body, timeout=600)
    if name == "job_status":
        return with_auth("/api/jobs/%s" % urllib.parse.quote(args.get("id", "")))
    if name == "list_jobs":
        return with_auth("/api/jobs")
    if name == "canvas_list":
        return with_auth("/api/canvases")
    if name == "canvas_create":
        return with_auth("/api/canvases", "POST", {"name": args.get("name") or "主画布"})
    if name == "canvas_get":
        return with_auth("/api/canvases/%s" % urllib.parse.quote(args.get("id", "")))
    if name == "canvas_ops":
        cid = urllib.parse.quote(args.get("id", ""))
        return with_auth("/api/canvases/%s/ops" % cid, "POST", {"ops": args.get("ops") or []})
    if name == "canvas_replace":
        cid = urllib.parse.quote(args.get("id", ""))
        return with_auth("/api/canvases/%s" % cid, "PUT", {"doc": args.get("doc") or {}})
    raise HttpError("未知工具：%s" % name)


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(rid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": rid}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    send(msg)


def handle(msg):
    method = msg.get("method")
    rid = msg.get("id")

    if method == "initialize":
        return reply(rid, {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "museapi-video", "version": "1.0.0"},
        })
    if method in ("notifications/initialized", "initialized"):
        return
    if method == "ping":
        return reply(rid, {})
    if method == "tools/list":
        return reply(rid, {"tools": TOOLS})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            data = dispatch(name, args)
            text = json.dumps(data, ensure_ascii=False, indent=2)
            return reply(rid, {"content": [{"type": "text", "text": text}]})
        except HttpError as e:
            return reply(rid, {"content": [{"type": "text", "text": "调用失败：%s" % e}],
                               "isError": True})
        except Exception as e:  # noqa: BLE001
            return reply(rid, {"content": [{"type": "text", "text": "异常：%s: %s" % (type(e).__name__, e)}],
                               "isError": True})
    if rid is not None:
        return reply(rid, error={"code": -32601, "message": "method not found: %s" % method})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        handle(msg)


if __name__ == "__main__":
    main()
