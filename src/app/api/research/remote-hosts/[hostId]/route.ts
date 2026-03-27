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

      // If host has a pre-existing env (conda/venv), test against that
      // Otherwise, create a temp venv and install base requirements
      const activateCmd = host.conda
        ? `source ${host.conda} 2>/dev/null || conda activate ${host.conda} 2>/dev/null`
        : null;
      const setupPreamble = host.setupCmd ? `${host.setupCmd} && ` : "";

      let testCmd: string;
      if (activateCmd) {
        // Pre-existing env: activate it, check installed packages, verify base reqs are met, smoke test
        const reqLines = host.baseRequirements.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
        const pkgNames = reqLines.map(l => l.split(/[>=<!\[]/)[0].trim().replace(/-/g, "_")).filter(Boolean);
        const importTest = pkgNames.length > 0
          ? `python3 -c "\nimport sys; missing = []\nfor p in ${JSON.stringify(pkgNames)}:\n    try: __import__(p)\n    except ImportError: missing.append(p)\nif missing: print('MISSING: ' + ', '.join(missing)); sys.exit(1)\nelse: print('All base packages importable')\n" 2>&1`
          : `echo "No packages to verify"`;

        testCmd = `${setupPreamble}${activateCmd} && ` +
          `echo "=== Environment ===" && python3 --version && ` +
          `echo "=== Installed ===" && pip list --format=freeze 2>/dev/null | head -30 && ` +
          `echo "=== Base Requirements Check ===" && ${importTest} && ` +
          `echo "=== Smoke Test ===" && python3 -c "import torch; print(f'torch={torch.__version__}, cuda={torch.cuda.is_available()}, gpus={torch.cuda.device_count()}')" 2>&1`;
      } else {
        // No pre-existing env: create temp venv, install, test, clean up
        testCmd = `cd ~ && mkdir -p .arcana_env_test && cat > .arcana_env_test/requirements.txt << 'ARCANA_EOF'\n${host.baseRequirements}\nARCANA_EOF\n` +
          `cd .arcana_env_test && python3 -m venv .venv 2>&1 && source .venv/bin/activate && ` +
          `pip install --upgrade pip -q 2>&1 && pip install -r requirements.txt 2>&1 && ` +
          `echo "=== Smoke Test ===" && python3 -c "import torch; print(f'torch={torch.__version__}, cuda={torch.cuda.is_available()}, gpus={torch.cuda.device_count()}')" 2>&1; ` +
          `EXIT=$?; rm -rf ~/.arcana_env_test; exit $EXIT`;
      }

      const setupResult = await quickRemoteCommand(hostId, testCmd);

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
