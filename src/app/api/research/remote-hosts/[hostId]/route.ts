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
    for (const key of ["alias", "host", "port", "user", "keyPath", "workDir", "gpuType", "conda", "setupCmd", "backend", "isDefault", "baseRequirements", "envNotes"]) {
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

// POST — Test connection or environment
export async function POST(request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { hostId } = await params;

    let body: { testEnv?: boolean } = {};
    try { body = await request.json(); } catch { /* no body = test connection */ }

    if (body.testEnv) {
      // Test environment: install base requirements in a temp venv
      const host = await prisma.remoteHost.findUnique({ where: { id: hostId } });
      if (!host) return NextResponse.json({ ok: false, error: "Host not found" }, { status: 404 });
      if (!host.baseRequirements?.trim()) {
        return NextResponse.json({ ok: false, error: "No base requirements configured" });
      }

      const { quickRemoteCommand } = await import("@/lib/research/remote-executor");
      const setupResult = await quickRemoteCommand(hostId,
        `cd ~ && mkdir -p .arcana_env_test && cat > .arcana_env_test/requirements.txt << 'ARCANA_EOF'\n${host.baseRequirements}\nARCANA_EOF\n` +
        `cd .arcana_env_test && python3 -m venv .venv 2>&1 && source .venv/bin/activate && ` +
        `pip install --upgrade pip -q 2>&1 && pip install -r requirements.txt 2>&1 && ` +
        `python3 -c "import torch; print(f'torch={torch.__version__}, cuda={torch.cuda.is_available()}, gpus={torch.cuda.device_count()}')" 2>&1; ` +
        `EXIT=$?; rm -rf ~/.arcana_env_test; exit $EXIT`
      );

      return NextResponse.json({
        ok: setupResult.ok,
        output: setupResult.output.slice(-3000),
        error: setupResult.ok ? undefined : "Environment test failed — check output",
      });
    }

    const result = await testConnection(hostId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Test failed" },
      { status: 500 },
    );
  }
}
