import { NextResponse } from "next/server";

/** Keep server storage failures distinct from invalid project names or uploads. */
export function peStorageErrorResponse(error: unknown): NextResponse | null {
  const visited = new Set<unknown>();
  let current = error;
  let inaccessible = false;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const failure = current as { code?: unknown; errcode?: unknown; cause?: unknown };
    const sqliteCode = typeof failure.errcode === "number" ? failure.errcode & 0xff : undefined;
    if (failure.code === "ENOSPC" || failure.code === "EDQUOT" || sqliteCode === 13) {
      console.error("PE project storage failure:", error);
      return NextResponse.json(
        { error: "服务器存储空间不足，无法读写项目资料。释放空间后请重试。" },
        { status: 507 },
      );
    }
    inaccessible ||= sqliteCode === 14 || failure.code === "EACCES" || failure.code === "EPERM";
    current = failure.cause;
  }
  if (!inaccessible) return null;
  console.error("PE project storage failure:", error);
  return NextResponse.json(
    { error: "无法访问项目数据库或资料目录，请检查服务器磁盘空间和目录读写权限后重试。" },
    { status: 500 },
  );
}
