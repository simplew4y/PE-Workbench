import { NextResponse } from "next/server";
import { peStorageErrorResponse } from "@/lib/pe-storage-errors";
import {
  activatePeProject,
  createPeProject,
  deletePeProject,
  listPeProjects,
} from "@/lib/pe-project-store";

export const runtime = "nodejs";

function projectErrorResponse(error: unknown): NextResponse {
  const storageError = peStorageErrorResponse(error);
  if (storageError) return storageError;
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json(
    { error: message },
    { status: /already exists/iu.test(message) ? 409 : 400 },
  );
}

export async function GET() {
  try {
    const catalog = listPeProjects();
    return NextResponse.json(catalog);
  } catch (error) {
    return peStorageErrorResponse(error) ?? NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      name?: unknown;
      companyName?: unknown;
      companyTicker?: unknown;
    };
    const project = createPeProject({
      name: typeof body.name === "string" ? body.name : "",
      companyName: typeof body.companyName === "string" ? body.companyName : "",
      companyTicker: typeof body.companyTicker === "string" ? body.companyTicker : "",
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { datasetId?: unknown };
    const datasetId = typeof body.datasetId === "string" ? body.datasetId.trim() : "";
    if (!datasetId) {
      return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
    }
    const project = activatePeProject(datasetId);
    return NextResponse.json({ project });
  } catch (error) {
    return projectErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { datasetId?: unknown };
    const datasetId = typeof body.datasetId === "string" ? body.datasetId.trim() : "";
    if (!datasetId) {
      return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
    }
    const catalog = deletePeProject(datasetId);
    return NextResponse.json(catalog);
  } catch (error) {
    return projectErrorResponse(error);
  }
}
