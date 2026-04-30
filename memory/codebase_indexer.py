"""Codebase indexer helper for codebase_index_sop.md.

Provides:
    should_index(repo)        -> (bool, reason)
    compute_fingerprint(repo) -> str
    read_index_fingerprint(p) -> str | None
    collect_symbols(repo)     -> {file: [{kind, name, line}]}
    dump_symbols(syms, path)
    diff_changed_files(repo, symbols_json) -> [(path, status)]
    build_index(repo, sections_dir, out)

Design constraints:
  - Pure stdlib + ripgrep CLI (rg). No embedding, no extra deps.
  - All paths relative to `repo` root; absolute writes confined under .ga_index/.
  - Fingerprint deterministic across runs on the same checkout.
  - Single-file repos / small repos short-circuit out.
"""
from __future__ import annotations
import hashlib, json, os, re, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

INDEX_DIR = ".ga_index"
INDEX_FILE = "index.md"
SYMBOLS_FILE = "symbols.json"
SECTIONS_DIR = "sections"

CODE_TYPES = ["py", "ts", "tsx", "js", "jsx", "go", "java", "rs", "cpp", "c", "h", "hpp", "cs", "rb", "php", "kt", "swift"]

# language -> regex for top-level symbol detection (anchored to line start)
SYMBOL_REGEX = {
    "py":   re.compile(r"^\s*(?P<kind>class|def|async def)\s+(?P<name>\w+)"),
    "ts":   re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?P<kind>class|function|interface|type|enum|const)\s+(?P<name>\w+)"),
    "tsx":  re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?P<kind>class|function|interface|type|enum|const)\s+(?P<name>\w+)"),
    "js":   re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?P<kind>class|function|const)\s+(?P<name>\w+)"),
    "jsx":  re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?P<kind>class|function|const)\s+(?P<name>\w+)"),
    "go":   re.compile(r"^\s*(?P<kind>func|type)\s+(?:\(\w+\s+\*?\w+\)\s+)?(?P<name>\w+)"),
    "java": re.compile(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?P<kind>class|interface|enum)\s+(?P<name>\w+)"),
    "rs":   re.compile(r"^\s*(?:pub\s+)?(?P<kind>fn|struct|trait|impl|enum)\s+(?P<name>\w+)"),
    "cs":   re.compile(r"^\s*(?:public|private|internal|protected)?\s*(?:static\s+)?(?P<kind>class|interface|struct|enum)\s+(?P<name>\w+)"),
    "rb":   re.compile(r"^\s*(?P<kind>class|module|def)\s+(?P<name>\w+)"),
    "kt":   re.compile(r"^\s*(?:public\s+|internal\s+|private\s+)?(?P<kind>class|fun|interface|object)\s+(?P<name>\w+)"),
}

DEFAULT_EXCLUDES = ["node_modules", ".git", ".ga_index", "__pycache__", "dist", "build", ".venv", "venv", "out"]


def _rg_files(repo: str) -> list[str]:
    """List code files via ripgrep, falling back to os.walk."""
    try:
        args = ["rg", "--files"] + [a for t in CODE_TYPES for a in ("-t", t)]
        out = subprocess.check_output(args, cwd=repo, stderr=subprocess.DEVNULL, timeout=10)
        return [ln for ln in out.decode("utf-8", "replace").splitlines() if ln]
    except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        # fallback: os.walk
        files: list[str] = []
        exts = {"." + e for e in CODE_TYPES}
        for root, dirs, fns in os.walk(repo):
            dirs[:] = [d for d in dirs if d not in DEFAULT_EXCLUDES and not d.startswith(".")]
            for fn in fns:
                if Path(fn).suffix.lower() in exts:
                    rel = os.path.relpath(os.path.join(root, fn), repo).replace("\\", "/")
                    files.append(rel)
        return files


def should_index(repo: str = ".") -> tuple[bool, str]:
    files = _rg_files(repo)
    if len(files) < 30:
        return False, f"small repo ({len(files)} code files < 30)"
    idx = Path(repo) / INDEX_DIR / INDEX_FILE
    if idx.exists() and read_index_fingerprint(str(idx)) == compute_fingerprint(repo):
        return False, "fingerprint matches existing index (REUSE)"
    return True, f"{len(files)} files, ready to index"


def compute_fingerprint(repo: str = ".") -> str:
    """SHA1 of (sorted file list + sizes + git HEAD if available). Truncated to 12 chars."""
    h = hashlib.sha1()
    files = sorted(_rg_files(repo))
    for f in files:
        try:
            sz = (Path(repo) / f).stat().st_size
        except OSError:
            sz = -1
        h.update(f.encode("utf-8", "replace"))
        h.update(b"\0")
        h.update(str(sz).encode())
        h.update(b"\n")
    head = ""
    try:
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, stderr=subprocess.DEVNULL, timeout=3).decode().strip()
    except Exception:
        pass
    h.update(head.encode())
    return h.hexdigest()[:12]


def read_index_fingerprint(index_path: str) -> str | None:
    p = Path(index_path)
    if not p.exists():
        return None
    try:
        with p.open("r", encoding="utf-8", errors="replace") as f:
            for _ in range(5):
                line = f.readline()
                if line.startswith("fingerprint:"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        return None
    return None


def collect_symbols(repo: str = ".") -> dict[str, list[dict]]:
    """For every code file under repo, extract top-level symbols using SYMBOL_REGEX."""
    files = _rg_files(repo)
    result: dict[str, list[dict]] = {}
    for f in files:
        ext = Path(f).suffix.lstrip(".").lower()
        rgx = SYMBOL_REGEX.get(ext)
        if rgx is None:
            result[f] = []
            continue
        full = Path(repo) / f
        try:
            with full.open("r", encoding="utf-8", errors="replace") as fh:
                syms = []
                for ln_no, line in enumerate(fh, 1):
                    if ln_no > 5000:  # hard cap per file
                        break
                    m = rgx.match(line)
                    if m:
                        syms.append({"kind": m.group("kind"), "name": m.group("name"), "line": ln_no})
                result[f] = syms
        except OSError:
            result[f] = []
    return result


def dump_symbols(syms: dict, path: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        json.dump(syms, f, ensure_ascii=False, indent=1)


def diff_changed_files(repo: str, symbols_json: str) -> list[tuple[str, str]]:
    """Compare on-disk file list+sizes against the previous symbols.json snapshot.

    The status mtime is approximate but sufficient for incremental rebuild.
    Returns list of (relpath, status) where status in {added, modified, deleted}.
    """
    p = Path(symbols_json)
    if not p.exists():
        return [(f, "added") for f in _rg_files(repo)]
    try:
        with p.open("r", encoding="utf-8", errors="replace") as f:
            old = json.load(f)
    except (json.JSONDecodeError, OSError):
        return [(f, "added") for f in _rg_files(repo)]
    cur_files = set(_rg_files(repo))
    old_files = set(old.keys())
    out: list[tuple[str, str]] = []
    for f in sorted(cur_files - old_files):
        out.append((f, "added"))
    for f in sorted(old_files - cur_files):
        out.append((f, "deleted"))
    snap_path = p.parent / (p.stem + ".meta.json")
    snap = {}
    if snap_path.exists():
        try:
            snap = json.loads(snap_path.read_text(encoding="utf-8", errors="replace"))
        except (json.JSONDecodeError, OSError):
            snap = {}
    new_meta = {}
    for f in sorted(cur_files & old_files):
        full = Path(repo) / f
        try:
            st = full.stat()
            sig = f"{st.st_size}-{int(st.st_mtime)}"
        except OSError:
            sig = ""
        new_meta[f] = sig
        if snap.get(f) != sig:
            out.append((f, "modified"))
    snap_path.write_text(json.dumps(new_meta, ensure_ascii=False), encoding="utf-8")
    return out


def build_index(repo: str = ".", sections_dir: str = None, out: str = None) -> str:
    """Combine sections/*.md plus symbols.json into a single index.md.

    Sections are expected to follow `### <dir>/\n- file.py — desc | exports: ... | deps: ...` lines.
    If sections directory is empty (e.g., subagents not run yet), falls back to a bare symbol-only index.
    """
    repo_p = Path(repo)
    sections_p = Path(sections_dir or repo_p / INDEX_DIR / SECTIONS_DIR)
    out_p = Path(out or repo_p / INDEX_DIR / INDEX_FILE)
    out_p.parent.mkdir(parents=True, exist_ok=True)

    fp = compute_fingerprint(repo)
    git_head = "no-git"
    try:
        git_head = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=repo, stderr=subprocess.DEVNULL, timeout=3).decode().strip() or "no-git"
    except Exception:
        pass

    syms_path = repo_p / INDEX_DIR / SYMBOLS_FILE
    syms = {}
    if syms_path.exists():
        try:
            syms = json.loads(syms_path.read_text(encoding="utf-8", errors="replace"))
        except (json.JSONDecodeError, OSError):
            syms = {}

    n_files = len(syms)
    n_syms = sum(len(v) for v in syms.values())

    head = [
        "# Codebase Index",
        f"fingerprint: {fp}",
        f"generated_at: {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
        f"git_head: {git_head}",
        f"files: {n_files}",
        f"symbols: {n_syms}",
        "",
        "## 项目概述",
        "<TODO: 主 agent 综合各 section 撰写 2-3 句>",
        "",
        "## 入口点",
        "<TODO: 主 agent 从 sections 中提取 main/run/start 类入口>",
        "",
        "## 模块树",
    ]

    # merge sections
    if sections_p.exists():
        for sec in sorted(sections_p.glob("*.md")):
            try:
                content = sec.read_text(encoding="utf-8", errors="replace").strip()
                if content:
                    head.append(content)
                    head.append("")
            except OSError:
                continue

    # symbol table: skip dunders and private helpers, keep classes + public top-level fns.
    # Sorted by file then line so it reads like a TOC.
    head.append("## 关键符号速查")
    head.append("")
    head.append("| symbol | location | kind |")
    head.append("|---|---|---|")
    PUBLIC_KINDS = {"class", "interface", "type", "enum", "struct", "trait", "module", "fn", "func", "function", "def", "async def"}
    rows = []
    for f, sl in syms.items():
        for s in sl:
            name = s["name"]
            kind = s["kind"]
            if name.startswith("_"):  # skip private and dunder
                continue
            if kind not in PUBLIC_KINDS:
                continue
            rows.append((f, s["line"], name, kind))
    rows.sort(key=lambda r: (r[0].lower(), r[1]))
    for f, line, name, kind in rows[:400]:
        head.append(f"| `{name}` | `{f}:{line}` | {kind} |")

    out_p.write_text("\n".join(head) + "\n", encoding="utf-8")
    return str(out_p)


# Convenience CLI: `python memory/codebase_indexer.py status` / `... fingerprint` / `... index`
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    repo = sys.argv[2] if len(sys.argv) > 2 else "."
    if cmd == "status":
        ok, reason = should_index(repo)
        print(f"should_index={ok} ({reason})")
    elif cmd == "fingerprint":
        print(compute_fingerprint(repo))
    elif cmd == "symbols":
        s = collect_symbols(repo)
        out = Path(repo) / INDEX_DIR / SYMBOLS_FILE
        dump_symbols(s, str(out))
        print(f"wrote {out} ({len(s)} files, {sum(len(v) for v in s.values())} symbols)")
    elif cmd == "index":
        s = collect_symbols(repo)
        dump_symbols(s, str(Path(repo) / INDEX_DIR / SYMBOLS_FILE))
        out = build_index(repo)
        print(f"wrote {out}")
    else:
        print("usage: codebase_indexer.py [status|fingerprint|symbols|index] [repo]")
        sys.exit(1)
