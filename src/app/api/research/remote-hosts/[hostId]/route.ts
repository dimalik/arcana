import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { testConnection } from "@/lib/research/remote-executor";

type Params = { params: Promise<{ hostId: string }> };

// PATCH — Update a remote host
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { hostId } = await params;
    const body = await request.json();

    const data: Record<string, unknown> = {};
    for (const key of ["alias", "host", "port", "user", "keyPath", "workDir", "gpuType", "conda", "setupCmd", "backend", "isDefault"]) {
      if (body[key] !== undefined) data[key] = body[key];
    }

    // If setting as default, unset others first
    if (body.isDefault === true) {
      await prisma.remoteHost.updateMany({ data: { isDefault: false } });
    }

    const host = await prisma.remoteHost.update({
      where: { id: hostId },
      data,
    });

    return NextResponse.json(host);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update host" },
      { status: 500 },
    );
  }
}

// DELETE — Remove a remote host
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { hostId } = await params;

    await prisma.remoteHost.delete({ where: { id: hostId } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Failed to delete host" }, { status: 500 });
  }
}

// POST — Test connection to this host
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { hostId } = await params;

    const result = await testConnection(hostId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Test failed" },
      { status: 500 },
    );
  }
}
