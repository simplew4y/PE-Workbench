import { NextResponse } from "next/server";
import { homedir } from "os";
import { getPeUserRoot, isPeMultiUserMode } from "@/lib/pe-multi-user-paths";

export async function GET() {
  return NextResponse.json({ home: isPeMultiUserMode() ? getPeUserRoot() : homedir() });
}
