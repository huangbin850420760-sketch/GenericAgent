# Codebase Index SOP

**触发**：进入新代码仓库需要理解结构 / Plan 探索态 task_type=code / 用户问"X 在哪/这个仓库怎么用"
**禁用**：仓库代码文件 < 30 个（直接 `rg --files` 列出即可）/ 已有 `.ga_index/index.md` 且指纹未变

> 目的：用 **ripgrep + 分块摘要** 替代 embedding，让 GA 在大仓库下保持 token 经济性，
> 把"全仓库符号速查"做到与 Cursor codebase indexing 同等可用。

---

## 一、核心原则

1. **不做 embedding**：靠 ripgrep 符号正则 + LLM 短摘要 + 文件指纹增量
2. **本地化**：索引写在**目标仓库**的 `.ga_index/`（不是 GA 自身 memory），避免污染
3. **增量优先**：第二次进入同仓库 → fingerprint 一致 → 直接复用，0 token 开销
4. **委托 subagent**：摘要生成必须 Map 模式并行，主 agent 只收最终汇总
5. **可被检索接口消费**：后续工具调用 `file_read('.ga_index/index.md')` 即可定位任何符号

---

## 二、流程（首次索引）

### 步骤 1：判断是否启用

```python
code_run({'inline_eval': True, 'script': '''
import sys; sys.path.insert(0, "memory")
from codebase_indexer import should_index
ok, reason = should_index(".")
print(ok, reason)
'''})
```

`ok=False` 直接 SKIP（输出 reason）。

### 步骤 2：计算指纹 + 增量判断

```python
code_run({'inline_eval': True, 'script': '''
import sys; sys.path.insert(0, "memory")
from codebase_indexer import compute_fingerprint, read_index_fingerprint
new_fp = compute_fingerprint(".")
old_fp = read_index_fingerprint(".ga_index/index.md")
print("NEW" if new_fp != old_fp else "REUSE", new_fp)
'''})
```

- `REUSE` → 跳到步骤 6
- `NEW` → 继续步骤 3

### 步骤 3：抽取符号清单（主 agent 一次 ripgrep）

```python
code_run({'inline_eval': True, 'script': '''
import sys; sys.path.insert(0, "memory")
from codebase_indexer import collect_symbols, dump_symbols
sym = collect_symbols(".")          # {file: [{kind, name, line}]}
dump_symbols(sym, ".ga_index/symbols.json")
print(f"files={len(sym)} symbols={sum(len(v) for v in sym.values())}")
'''})
```

抽取规则按语言：
- Python: `^\s*(class|def|async def)\s+\w+`
- TS/JS: `^\s*(export\s+)?(class|function|interface|type|const)\s+\w+`
- Go: `^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+`
- Java/C#: `^\s*(public|private|protected)?\s*(static\s+)?(class|interface|enum)\s+\w+`
- Rust: `^\s*(pub\s+)?(fn|struct|trait|impl|enum)\s+\w+`
- C/C++: `^\s*(\w+[\w\s\*]*?)\s+(\w+)\s*\([^)]*\)\s*\{?$`

### 步骤 4：分批生成文件摘要（[D] 委托 subagent，Map 模式）

按目录分组，每组 ≤ 20 个文件起一个 subagent。主 agent 只调度，不读源码：

```
分组依据：
  - 取 collect_symbols 返回的文件列表
  - 按二级目录分组（src/foo/* 一组、tests/* 一组）
  - 每组 > 20 个文件再二分

input 给每个 subagent：
  - 目录: src/foo/
  - 文件列表: [bar.py, baz.py, ...]（最多 20 个）
  - 任务: 对每个文件
    1. file_read 首 200 行（>2K 行时再补尾 100 行）
    2. 生成 1 行摘要：
       `<file> — <用途 1 句> | exports: <顶层符号 ≤5> | deps: <import 自仓内目录>`
  - 约束: ≤ 8 次工具调用，禁修改文件
  - 输出: 写到 .ga_index/sections/<dirname>.md
```

并行起 N 个 subagent（N = ceil(files / 20)），按 `subagent.md` Map 模式管理。

### 步骤 5：合并产出 `.ga_index/index.md`

```python
code_run({'inline_eval': True, 'script': '''
import sys; sys.path.insert(0, "memory")
from codebase_indexer import build_index
build_index(".", ".ga_index/sections/", out=".ga_index/index.md")
'''})
```

**index.md 标准格式**：

```markdown
# Codebase Index
fingerprint: <sha1-12>
generated_at: <ISO8601>
git_head: <commit-hash | "no-git">
files: <N>
symbols: <M>

## 项目概述
<2-3 句，由主 agent 综合各 section 撰写>

## 入口点
- `path/to/main.py:run()` — 一句话
- ...

## 模块树
### src/foo/
- `bar.py` — 用途 | exports: `Foo`, `bar()` | deps: src/baz
- `baz.py` — ...

### src/utils/
- ...

## 关键符号速查
| symbol | location | brief |
|---|---|---|
| `parse_config` | `src/foo/bar.py:42` | 解析 YAML 配置 |
```

### 步骤 6：写 L1 Insight 触发词（仅 SOP 首次部署时做一次）

按 `memory_management_sop.md` 同步规则，向 `global_mem_insight.txt` 第二层（低频场景）添加：

```
codebase_index(代码摸排/找符号)
```

> 不要写入 How-to 细节，只加触发词。

---

## 三、增量更新（同仓库再次进入）

```python
code_run({'inline_eval': True, 'script': '''
import sys; sys.path.insert(0, "memory")
from codebase_indexer import diff_changed_files
changed = diff_changed_files(".", ".ga_index/symbols.json")
print(changed)   # [(path, status), ...]   status in {added, modified, deleted}
'''})
```

只对 `added/modified` 的文件重新走步骤 4，`deleted` 直接从 index 移除。指纹更新写回头部。

> **token 预算**：单次 SOP 调用对索引的写入 ≤ 4K token；超出分多轮。

---

## 四、检索接口（被其他 SOP / 工具消费）

后续任何"找符号 / 找文件 / 理解某模块"任务：

1. **首选**：`file_read('.ga_index/index.md')` — 一次读全
2. **大仓库**（index.md > 8K 行）：`file_read('.ga_index/sections/<dirname>.md')`
3. **精确符号**：grep `.ga_index/symbols.json`，定位具体行号

VS Code 插件侧可暴露 `@codebase` 上下文：取 `index.md` 注入对话首消息。

---

## 五、与 Plan SOP 集成

`plan_sop.md` 探索态对 task_type=code 任务，在「步骤 2：探索 subagent」之前先执行：

```
[ ] (前置) 检查 .ga_index/index.md，没有则按 codebase_index_sop.md 建索引
```

这样 plan 阶段的探索 subagent 直接读 index 而非 ls/cat 整个仓库，节省大量 token。

---

## 六、强制约束

- 主 agent 不直接读代码源文件做摘要（必须委托 subagent）
- `.ga_index/` 必须加入目标仓库的 `.gitignore`（默认仅本地缓存）
- `index.md` 顶部 `fingerprint` 行必须是第 2 行（脚本依赖位置）
- 不能用 ripgrep 抽符号的语言（HTML/CSS/Markdown）→ 仅记 file 列表，不进 symbol 表
- fingerprint 计算 > 5s 时降级为 mtime 近似（脚本内置）
- 仓库 > 5000 个代码文件时 → 强制提示用户是否分目录索引（避免一次性爆 token）
