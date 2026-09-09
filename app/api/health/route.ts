import { NextResponse } from "next/server";
import { getPeRuntimeRole } from "@/lib/pe-runtime-role";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", role: getPeRuntimeRole() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
