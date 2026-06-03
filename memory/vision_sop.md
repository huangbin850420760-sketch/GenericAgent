# Vision API SOP

## ⚠️ 前置规则（必须遵守）

1. **先枚举窗口**：调用 vision 前必须先用 `pygetwindow` 枚举窗口标题，确认目标窗口存在且已激活到前台。窗口不存在就不要截图。
2. **🚫 禁止全屏截图**：必须先利用ljqCtrl截取窗口区域。能截局部（如标题栏）就不截整窗口，能截窗口就绝不全屏。全屏截图在任何场景下都不允许。
3. **优先级（从高到低）**：
   - 🥇 **本地 OCR**（`ocr_utils.py`）：纯文字识别，零成本，最快
   - 🥈 **MCP 视觉工具**（智谱 GLM-4.6V）：图像/视频理解，LLM 自主通过 `mcp_tool()` 调用，支持复杂场景
   - 🥉 **Vision API**（`vision_api.py`）：MCP 不可用时的兜底方案，代码级显式调用
   - 能用 OCR 搞定就不用 MCP，能用 MCP 就不用 Vision API

## 快速用法

```python
from vision_api import ask_vision
result = ask_vision(image, prompt="描述图片内容", timeout=60, max_pixels=1_440_000)
# image: 文件路径(str/Path) 或 PIL Image
# backend: 'claude'(默认) | 'openai' | 'modelscope'
# 返回 str：成功为模型回复，失败为 'Error: ...'
```

## 如果没有 `vision_api.py`，初次构建vision能力

1. 复制 `memory/vision_api.template.py` → `memory/vision_api.py`
2. 只改头部"用户配置区"：去 `mykey.py` 里扫描变量名（⚠️ 只看名字，禁止输出 apikey 值），尝试找能用配置名填入 `CLAUDE_CONFIG_KEY` / `OPENAI_CONFIG_KEY`，`DEFAULT_BACKEND` 选后端，并测试
3. 保底：没有可用 config 时去 `https://modelscope.cn/my/myaccesstoken` 申请 token 填入 `MODELSCOPE_API_KEY`

> ⚠️ `native_claude_config_1`(minimax) 当前 429 限流，不可用。
> ✅ `native_claude_config_2`(智谱 GLM-5.1) 可用，作为 Vision API 兜底。
> 视觉优先走 MCP（智谱 GLM-4.6V），MCP 不可用时走 vision_api.py。
