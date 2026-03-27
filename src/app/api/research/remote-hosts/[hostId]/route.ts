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
      const { quickRemoteCommand } = await import("@/lib/research/remote-executor");

      // Determine how to activate the environment
      // conda field can be: a venv activate path, a conda env name, or a python binary path
      const condaVal = host.conda?.trim() || "";
      const setupPreamble = host.setupCmd ? `${host.setupCmd} && ` : "";

      let activateCmd = "";
      if (condaVal.endsWith("/activate")) {
        activateCmd = `source ${condaVal}`;
      } else if (condaVal.endsWith("/python") || condaVal.endsWith("/python3")) {
        // Direct python binary — derive the activate path
        const binDir = condaVal.replace(/\/python3?$/, "");
        activateCmd = `source ${binDir}/activate 2>/dev/null || export PATH=${binDir}:$PATH`;
      } else if (condaVal) {
        activateCmd = `conda activate ${condaVal} 2>/dev/null || source ${condaVal} 2>/dev/null`;
      }

      if (activateCmd) {
        // Has a pre-existing env — discover what's installed and run smoke test
        const testCmd = `${setupPreamble}${activateCmd} && ` +
          `echo "=== Environment ===" && python3 --version 2>&1 && which python3 2>&1 && ` +
          `echo "=== Installed Packages ===" && pip list --format=freeze 2>/dev/null && ` +
          `echo "=== Smoke Test ===" && python3 -c "
try:
    import torch
    print(f'torch={torch.__version__}, cuda={torch.cuda.is_available()}, gpus={torch.cuda.device_count()}')
except ImportError:
    print('torch not installed')
" 2>&1`;

        const result = await quickRemoteCommand(hostId, testCmd);

        // Extract installed packages and auto-populate baseRequirements if empty
        let packages: string[] = [];
        const output = result.output || "";
        const pkgSection = output.split("=== Installed Packages ===")[1]?.split("=== Smoke Test ===")[0];
        if (pkgSection) {
          packages = pkgSection.trim().split("\n").filter(l => l.trim() && l.includes("=="));
        }

        // If no base requirements configured, auto-populate from discovered packages
        let autoPopulated = false;
        if (!host.baseRequirements?.trim() && packages.length > 0) {
          // Filter to key ML/science packages (don't include every transitive dep)
          const keyPkgPatterns = /^(torch|transformers|accelerate|deepspeed|flash.attn|bitsandbytes|datasets|scipy|numpy|pandas|scikit|einops|wandb|tensorboard|peft|trl|vllm|xformers|triton|sentencepiece|tokenizers|safetensors|huggingface)/i;
          const keyPackages = packages.filter(p => keyPkgPatterns.test(p));
          if (keyPackages.length > 0) {
            await prisma.remoteHost.update({
              where: { id: hostId },
              data: { baseRequirements: keyPackages.join("\n") },
            });
            autoPopulated = true;
          }
        }

        return NextResponse.json({
          ok: result.ok,
          output: output.slice(-3000),
          packages,
          autoPopulated,
          error: result.ok ? undefined : "Environment test failed — check output",
        });
      }

      // No pre-existing env and no base requirements — nothing to test
      if (!host.baseRequirements?.trim()) {
        return NextResponse.json({ ok: false, error: "No environment configured. Set a conda/venv path or add base requirements." });
      }

      // No pre-existing env but has base requirements: create temp venv, install, test, clean up
      const testCmd = `cd ~ && mkdir -p .arcana_env_test && cat > .arcana_env_test/requirements.txt << 'ARCANA_EOF'\n${host.baseRequirements}\nARCANA_EOF\n` +
        `cd .arcana_env_test && python3 -m venv .venv 2>&1 && source .venv/bin/activate && ` +
        `pip install --upgrade pip -q 2>&1 && pip install -r requirements.txt 2>&1 && ` +
        `echo "=== Smoke Test ===" && python3 -c "import torch; print(f'torch={torch.__version__}, cuda={torch.cuda.is_available()}, gpus={torch.cuda.device_count()}')" 2>&1; ` +
        `EXIT=$?; rm -rf ~/.arcana_env_test; exit $EXIT`;

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
