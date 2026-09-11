import { NextResponse } from "next/server";
import { isPeMultiUserMode } from "@/lib/pe-multi-user-paths";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    { multi_user: isPeMultiUserMode(), execution: "local" },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
