import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// GET — List remote hosts
export async function GET() {
  try {
    await requireUserId();
    const hosts = await prisma.remoteHost.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { jobs: true } },
      },
    });
    return NextResponse.json(hosts);
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch hosts" }, { status: 500 });
  }
}

// POST — Add a remote host
export async function POST(request: NextRequest) {
  try {
    await requireUserId();
    const body = await request.json();

    const { alias, host, port, user, keyPath, workDir, gpuType, conda, setupCmd, backend } = body as {
      alias: string;
      host: string;
      port?: number;
      user: string;
      keyPath?: string;
      workDir?: string;
      gpuType?: string;
      conda?: string;
      setupCmd?: string;
      backend?: string;
    };

    if (!alias?.trim() || !host?.trim()) {
      return NextResponse.json({ error: "alias and host are required" }, { status: 400 });
    }

    const remoteHost = await prisma.remoteHost.create({
      data: {
        alias: alias.trim(),
        backend: backend || "ssh",
        host: host.trim(),
        port: port || 22,
        user: user?.trim() || "-",
        keyPath: keyPath?.trim() || null,
        workDir: workDir?.trim() || "~/experiments",
        gpuType: gpuType?.trim() || null,
        conda: conda?.trim() || null,
        setupCmd: setupCmd?.trim() || null,
      },
    });

    return NextResponse.json(remoteHost, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create host";
    // Handle unique constraint on alias
    if (message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A host with this alias already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
