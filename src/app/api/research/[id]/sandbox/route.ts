import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/paper-auth";
import { createProjectSandbox } from "@/lib/research/project-sandbox";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const {
      title,
      phase,
      copyWorkspace,
    } = body as {
      title?: string;
      phase?: string;
      copyWorkspace?: boolean;
    };

    const sandbox = await createProjectSandbox({
      sourceProjectId: id,
      userId,
      title,
      phase,
      copyWorkspace,
    });

    return NextResponse.json(sandbox, { status: 201 });
  } catch (err) {
    console.error("[api/research/[id]/sandbox] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create sandbox" },
      { status: 500 },
    );
  }
}
