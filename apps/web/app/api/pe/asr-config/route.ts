import { NextRequest, NextResponse } from "next/server";
import {
  asrConfigView,
  parsePeAsrConfig,
  readPeAsrConfig,
  writePeAsrConfig,
} from "@/lib/pe-asr/config";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(asrConfigView(readPeAsrConfig()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "JSON body required" }, { status: 415 });
  }
  try {
    const saved = writePeAsrConfig(parsePeAsrConfig(await request.json()));
    return NextResponse.json(asrConfigView(saved));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
