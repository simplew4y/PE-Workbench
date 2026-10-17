"""打印本机爱马仕项目当前已保存的投资框架；仅使用 Python 标准库。

运行：python3 test_script/print_hermes_framework.py
"""

import json
import re
import sqlite3
import sys
from pathlib import Path


def load_framework():
    dataset_id = "dataset_5fb3039323d218c96356"
    database_path = (
        Path.home()
        / ".pi/agent/pe-workbench/projects"
        / dataset_id
        / "meta/collection.sqlite3"
    )
    # 无 WAL 时使用 immutable，避免 SQLite 为只读数据库创建共享内存文件。
    mode = "mode=ro" if Path(f"{database_path}-wal").exists() else "immutable=1"
    database = sqlite3.connect(f"{database_path.as_uri()}?{mode}", uri=True)
    try:
        row = database.execute(
            "SELECT v.version_no, v.created_at, v.content_json "
            "FROM research_frameworks f "
            "JOIN research_versions v ON v.version_id = f.current_version_id "
            "WHERE f.dataset_id = ?",
            (dataset_id,),
        ).fetchone()
    finally:
        database.close()
    if row is None:
        raise ValueError("爱马仕项目没有已保存的当前投资框架。")

    version, created_at, content = row
    return version, created_at, json.loads(content)


def main():
    version, created_at, report = load_framework()
    identity = re.match(r"^(.+?)（([^）]+)）", report["title"])
    if identity is None:
        raise ValueError("当前框架标题未包含可提取的公司全名和股票代码。")
    lines = [report["title"], f"保存版本：v{version}", f"保存时间（UTC）：{created_at}"]
    for key, label in (("objective", "研究目标"), ("horizon", "投资期限")):
        if report.get(key):
            lines.extend(("", label, report[key]))

    labels = {
        "id": "条目编号",
        "kind": "类型",
        "subject": "主题",
        "claim": "判断",
        "rationale": "依据与调整原因",
        "verification": "验证方法",
        "invalidation": "失效条件",
        "origin": "来源类型",
        "evidenceIds": "证据编号",
    }
    for index, item in enumerate(report["items"], 1):
        lines.extend(("", f"{index}. {item.get('subject') or item['id']}"))
        for key, value in item.items():
            lines.append(f"{labels.get(key, key)}：")
            lines.append("\n".join(str(entry) for entry in value) if isinstance(value, list) else str(value))

    if report.get("coverageGaps"):
        lines.extend(("", "研究缺口"))
        lines.extend(f"{index}. {gap}" for index, gap in enumerate(report["coverageGaps"], 1))
    lines.extend(("", f"公司全名：{identity.group(1)}", f"股票代码（报告原文）：{identity.group(2)}"))
    print("\n".join(lines))


if __name__ == "__main__":
    try:
        main()
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError) as error:
        print(f"无法打印爱马仕投资框架：{error}", file=sys.stderr)
        sys.exit(1)
