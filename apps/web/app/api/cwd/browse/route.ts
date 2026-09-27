import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { getPeUserRoot, isPeMultiUserMode, isPeUserPathAllowed } from "@/lib/pe-multi-user-paths";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("path")?.trim();

    const multiUserMode = isPeMultiUserMode();
    if (!multiUserMode && shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = multiUserMode ? requested || getPeUserRoot() : getBrowseStartDirectory(requested);

    if (!isPeUserPathAllowed(candidate)) {
      return NextResponse.json({ error: "Path is outside the current PE user workspace" }, { status: 403 });
    }

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    if (!isPeUserPathAllowed(resolved)) {
      return NextResponse.json({ error: "Path is outside the current PE user workspace" }, { status: 403 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const directoryCandidates = await listDirectories(resolved);
    const directories = multiUserMode
      ? directoryCandidates.filter((entry) => isPeUserPathAllowed(entry.path))
      : directoryCandidates;
    const parent = getParentDirectory(resolved);

    return NextResponse.json({
      path: resolved,
      parentPath: parent && isPeUserPathAllowed(parent) ? parent : null,
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
