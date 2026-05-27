# ljqCtrl 使用与坐标转换 SOP

> **must call update working ckp**：`ljqCtrl一律使用物理坐标｜禁pyautogui｜操作前先gw激活窗口`

## 0. API 快速参考 (Signatures)

### 屏幕常量
- `ljqCtrl.dpi_scale`: float — 缩放系数 = 逻辑宽度 / 物理宽度
- `ljqCtrl.swidth / sheight`: int — 屏幕物理分辨率（像素）
- `ljqCtrl.cwidth / cheight`: int — 屏幕逻辑分辨率

### 鼠标控制
- `ljqCtrl.Click(x, y=None)`: 模拟左键单击。支持 `Click((x, y))` 或 `Click(x, y)`。内部调用 SetCursorPos + MouseClick
- `ljqCtrl.click`: Click 的别名
- `ljqCtrl.SetCursorPos(z)`: 移动鼠标到**物理坐标** z=(x, y)。内部自动乘 dpi_scale 转换为 win32 逻辑坐标
- `ljqCtrl.MouseClick(staytime=0.05)`: 在当前位置执行左键单击。按下→等待 staytime→释放→等待 0.05s
- `ljqCtrl.MouseDClick(staytime=0.05)`: 在当前位置执行左键双击。连续两次快速 MouseDown+MouseUp
- `ljqCtrl.MouseDown()`: 在当前位置按下左键（不释放）。用于拖拽起点
- `ljqCtrl.MouseUp()`: 释放左键。用于拖拽终点

### 键盘控制
- `ljqCtrl.Press(cmd, staytime=0)`: 模拟组合键。如 `Press('ctrl+c')`、`Press('alt+f4')`、`Press(['ctrl','shift','esc'])`。staytime 为每个键按下后的间隔
- `ljqCtrl.press`: Press 的别名
- `ljqCtrl.VK_CODE`: dict — 完整虚拟键码映射表（键名小写→16进制码），包含字母/数字/F1-F24/方向键/修饰键/多媒体键/符号键等 100+ 项

### 图像与窗口
- `ljqCtrl.GrabWindow(hwnd)`: DPI安全的窗口截图。自动前台激活窗口→等待0.3s→按窗口物理矩形截图→返回 PIL.Image。`hwnd` 通过 `win32gui.FindWindow()` 或 `gw.getWindowsWithTitle()[0]._hWnd` 获取
- `ljqCtrl.GrabWindowBg(hwnd_or_name, timeout=5)`: WGC后台截图(Win10+, pip install windows-capture), 传hwnd(int)或窗口标题子串(str), 返回PIL Image
- `ljqCtrl.FindBlock(fn, wrect=None, verbose=0, threshold=0.8)`: 模板匹配找图。`fn` 为图片路径(str)或 PIL.Image；`wrect` 可为 `[l,u,r,b]` 物理矩形 / 区域字符串(如`'right2'`) / PIL.Image(直接用做背景图)。返回 `((center_x_physical, center_y_physical), is_found)`
- `ljqCtrl.GetWRect(sr)`: 从字符串计算物理屏幕区域矩形。格式：方向+分割数，如 `'left2'`=左半屏、`'right3'`=右三分之一、`'top4'`=上四分之一。返回 `[left, up, right, bottom]` 物理坐标列表
- `ljqCtrl.imshow(mt, sec=0)`: 调试用 OpenCV 显示。`mt` 为 numpy/OpenCV 图像，`sec` 为等待毫秒数（0=阻塞等按键）

## 1. 环境载入
必须先将 `../memory` 加入路径，才能导入工具模块：
```python
import sys, os, pygetwindow as gw
sys.path.append("../memory")
import ljqCtrl
```

## 2. 核心：High-DPI 物理坐标换算
`ljqCtrl` 的 `Click/MoveTo` 接口接收的是**物理像素坐标**。
当使用 `pygetwindow` 等工具获取窗口位置（逻辑坐标）时，必须除以缩放系数。

- **换算公式**：`物理坐标 = 逻辑坐标 / ljqCtrl.dpi_scale`
- **注意**：3840 (4K) 仅为当前开发机示例，实际物理边界由系统环境决定，代码应始终通过 `dpi_scale` 动态计算。

## 3. 窗口操作与点击流程
1. **激活窗口**：使用 `gw.getWindowsWithTitle('标题')` 获取窗口，执行 `restore()` 和 `activate()`。
2. **坐标计算**：
```python
win = gw.getWindowsWithTitle('微信')[0]
# 计算窗口内某个点的逻辑坐标 (lx, ly)
# 转换为物理坐标并点击
px, py = lx / ljqCtrl.dpi_scale, ly / ljqCtrl.dpi_scale
ljqCtrl.Click(px, py)
```

## 4. 常用场景示例

### 4.1 窗口截图 + 找图点击
```python
import win32gui, pygetwindow as gw
hwnd = gw.getWindowsWithTitle('记事本')[0]._hWnd
img = ljqCtrl.GrabWindow(hwnd)          # 返回 PIL.Image，DPI安全
obj, found = ljqCtrl.FindBlock('button.png', img)  # 直接用截图做背景
if found:
    ljqCtrl.Click(obj)                  # obj已是物理坐标，直接点击
```

### 4.2 拖拽操作 (MouseDown + MouseUp)
```python
# 从 (100, 200) 拖拽到 (500, 200)，物理坐标
ljqCtrl.SetCursorPos((100, 200))
ljqCtrl.MouseDown()
# 分步移动更自然（可选）
for x in range(100, 500, 20):
    ljqCtrl.SetCursorPos((x, 200))
    time.sleep(0.02)
ljqCtrl.MouseUp()
```

### 4.3 屏幕区域搜索 (GetWRect)
```python
# 只在右半屏搜索，提升速度
rect = ljqCtrl.GetWRect('right2')        # → [swidth//2, 0, swidth, sheight]
obj, found = ljqCtrl.FindBlock('icon.png', wrect=rect, threshold=0.85)

# 上三分之一屏
rect_top = ljqCtrl.GetWRect('top3')      # → [0, 0, swidth, sheight//3]
```

### 4.4 键盘快捷键与 VK_CODE
```python
# 组合键
ljqCtrl.Press('ctrl+a')                 # 全选
ljqCtrl.Press('ctrl+c')                 # 复制
ljqCtrl.Press('alt+f4')                 # 关闭窗口
ljqCtrl.Press('win+d')                  # 显示桌面(VK_CODE含'win'需手动加)

# 多键组合用列表
ljqCtrl.Press(['ctrl', 'shift', 'escape'])  # 打开任务管理器

# 查看可用键名
print(list(ljqCtrl.VK_CODE.keys())[:20])  # 查看前20个键名
```

### 4.5 调试辅助 (imshow)
```python
import cv2, numpy as np
img = ljqCtrl.GrabWindow(hwnd)
arr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
ljqCtrl.imshow(arr, 3000)               # 显示3秒
ljqCtrl.imshow(arr, 0)                  # 阻塞等待按键关闭
```

## 5. 避坑指南
- **⚠️ 一律使用物理坐标**：传给 ljqCtrl.Click/SetCursorPos 的坐标必须是物理坐标（=截图像素坐标）。从 pygetwindow 获取的逻辑坐标需先 `/ dpi_scale` 转换。禁止传入逻辑坐标。
- **物理验证**：模拟操作前必须确保窗口已通过 `activate()` 置于前台。
- **偏移量**：所有的相对偏移像素值（如“向右移动 10 像素”）同样需要除以 `dpi_scale`。
- **坐标对齐**: 物理坐标 = 截图坐标；ljqCtrl 自动处理 DPI 换算，禁止手动重复计算。
- **⚠️ 窗口坐标转换陷阱**：使用 `win32gui.GetWindowRect(hwnd)` 获取的矩形包含标题栏和边框，而截图内容是客户区。点击截图内元素时，必须用 `win32gui.ClientToScreen(hwnd, (0, 0))` 获取客户区原点的屏幕坐标，再加上截图内坐标。禁止直接用 GetWindowRect 左上角 + 截图坐标。
- **⚠️ win32 DPI 坐标陷阱**：未调用 `SetProcessDPIAware()` 时，`GetWindowRect/ClientToScreen/GetClientRect` 等拿到的窗口/客户区坐标通常是**逻辑坐标**；若后续截图或 `ljqCtrl` 使用的是物理像素，必须统一做 `坐标 / ljqCtrl.dpi_scale`。等价方案：先 `SetProcessDPIAware()`，之后全流程直接使用 raw 物理坐标，禁止逻辑/物理坐标混用。
- **文本输入**：ljqCtrl 无 TypeText/SendKeys。向输入框键入文本：先点击/三击选中字段，再 `pyperclip.copy('文本'); ljqCtrl.Press('ctrl+v')`。