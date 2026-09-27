import { NextResponse } from "next/server";
import { isPeMultiUserMode } from "@/lib/pe-multi-user-paths";
import { isPeDesktopMode } from "@/lib/pe-desktop-mode";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    { multi_user: isPeMultiUserMode(), desktop: isPeDesktopMode(), execution: "local" },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
