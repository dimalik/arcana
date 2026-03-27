import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { quickRemoteCommand } from "@/lib/research/remote-executor";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ hostId: string }> };

/**
 * GET — Probe a remote host and generate structured environment notes.
 * Collects OS, CPU, RAM, GPU, CUDA, Python, disk, system packages,
 * and key ML packages into a concise summary for the research agent.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    await requireUserId();
    const { hostId } = await params;

    const host = await prisma.remoteHost.findUnique({ where: { id: hostId } });
    if (!host) return NextResponse.json({ ok: false, error: "Host not found" }, { status: 404 });

    // Determine env activation
    const condaVal = host.conda?.trim() || "";
    let activatePrefix = "";
    if (condaVal.endsWith("/activate")) {
      activatePrefix = `source ${condaVal} && `;
    } else if (condaVal.endsWith("/python") || condaVal.endsWith("/python3")) {
      const binDir = condaVal.replace(/\/python3?$/, "");
      activatePrefix = `source ${binDir}/activate 2>/dev/null || export PATH=${binDir}:$PATH; `;
    } else if (condaVal) {
      activatePrefix = `conda activate ${condaVal} 2>/dev/null || source ${condaVal} 2>/dev/null; `;
    }
    const setupPrefix = host.setupCmd ? `${host.setupCmd}; ` : "";

    // Single SSH call that collects everything
    const probeScript = `${setupPrefix}${activatePrefix}
echo "===OS==="
cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || uname -sr
echo "===KERNEL==="
uname -r
echo "===CPU==="
lscpu 2>/dev/null | grep -E "^(Model name|CPU\\(s\\)|Thread|Socket)" | head -4 || sysctl -n machdep.cpu.brand_string 2>/dev/null
echo "===RAM==="
free -h 2>/dev/null | awk '/^Mem:/{print $2 " total, " $7 " available"}' || echo "unknown"
echo "===DISK==="
df -h ~ 2>/dev/null | awk 'NR==2{print $2 " total, " $4 " free (" $5 " used)"}'
echo "===GPU==="
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null || echo "No NVIDIA GPUs"
echo "===CUDA==="
nvcc --version 2>/dev/null | grep "release" | awk '{print $NF}' || nvidia-smi 2>/dev/null | grep "CUDA Version" | awk '{print $NF}' || echo "unknown"
echo "===PYTHON==="
python3 --version 2>&1
which python3 2>&1
echo "===SYSPACKAGES==="
dpkg -l 2>/dev/null | grep -E "^ii" | awk '{print $2}' | grep -iE "(cuda|cudnn|nccl|libcublas|openmpi|gcc|g\\+\\+|make|cmake|git|tmux|screen|htop|rsync|wget|curl|vim|nano|ffmpeg|libffi|libssl|zlib)" | head -30 || rpm -qa 2>/dev/null | grep -iE "(cuda|gcc|cmake)" | head -15 || echo "unknown"
echo "===PYPACKAGES==="
pip list --format=freeze 2>/dev/null | grep -iE "^(torch|transformers|accelerate|deepspeed|flash.attn|bitsandbytes|datasets|scipy|numpy|pandas|scikit|einops|wandb|tensorboard|peft|trl|vllm|xformers|triton|sentencepiece|tokenizers|safetensors|huggingface|jax|tensorflow)" | sort
echo "===END==="
`;

    const result = await quickRemoteCommand(hostId, probeScript);
    const output = result.output || "";

    // Parse sections
    const getSection = (name: string): string => {
      const pattern = new RegExp(`===\\s*${name}\\s*===\\n([\\s\\S]*?)(?=\\n===|$)`);
      const match = output.match(pattern);
      return match ? match[1].trim() : "";
    };

    const os = getSection("OS") || "Unknown OS";
    const kernel = getSection("KERNEL");
    const cpu = getSection("CPU").split("\n").map(l => l.replace(/^\s+/, "")).join("; ");
    const ram = getSection("RAM");
    const disk = getSection("DISK");
    const gpuRaw = getSection("GPU");
    const cuda = getSection("CUDA");
    const python = getSection("PYTHON").split("\n")[0];
    const sysPackages = getSection("SYSPACKAGES").split("\n").filter(Boolean);
    const pyPackages = getSection("PYPACKAGES").split("\n").filter(Boolean);

    // Parse GPUs
    const gpuLines = gpuRaw.split("\n").filter(l => l.trim() && !l.includes("No NVIDIA"));
    const gpuSummary = gpuLines.length > 0
      ? gpuLines.map(l => {
          const [idx, name, mem] = l.split(",").map(s => s.trim());
          return `GPU ${idx}: ${name} (${mem} MiB)`;
        }).join("\n  ")
      : "No GPUs detected";
    const gpuCount = gpuLines.length;
    const gpuType = gpuLines[0]?.split(",")[1]?.trim() || "None";

    // Build the notes
    const notes: string[] = [];

    notes.push(`## Host: ${host.alias}`);
    notes.push(`OS: ${os}${kernel ? ` (kernel ${kernel})` : ""}`);
    notes.push(`CPU: ${cpu || "unknown"}`);
    notes.push(`RAM: ${ram || "unknown"}`);
    notes.push(`Disk: ${disk || "unknown"}`);
    notes.push("");

    if (gpuCount > 0) {
      notes.push(`## GPU (${gpuCount}x ${gpuType})`);
      notes.push(`  ${gpuSummary}`);
      notes.push(`CUDA: ${cuda || "unknown"}`);
    } else {
      notes.push("## Compute: CPU only (no GPU)");
    }
    notes.push(`Python: ${python || "unknown"}`);
    notes.push("");

    if (pyPackages.length > 0) {
      notes.push("## Key Python Packages");
      notes.push(pyPackages.join("\n"));
      notes.push("");
    }

    if (sysPackages.length > 0) {
      const grouped = {
        cuda: sysPackages.filter(p => /cuda|cudnn|nccl|cublas/i.test(p)),
        build: sysPackages.filter(p => /gcc|g\+\+|make|cmake/i.test(p)),
        tools: sysPackages.filter(p => /git|tmux|screen|htop|rsync|wget|curl|vim|nano|ffmpeg/i.test(p)),
        libs: sysPackages.filter(p => /libffi|libssl|zlib|openmpi/i.test(p)),
      };
      notes.push("## System Packages");
      if (grouped.cuda.length) notes.push(`CUDA/GPU libs: ${grouped.cuda.join(", ")}`);
      if (grouped.build.length) notes.push(`Build tools: ${grouped.build.join(", ")}`);
      if (grouped.libs.length) notes.push(`Libraries: ${grouped.libs.join(", ")}`);
      if (grouped.tools.length) notes.push(`Tools: ${grouped.tools.join(", ")}`);
      notes.push("");
    }

    // Add quirks
    const quirks: string[] = [];
    const cudaVer = parseFloat(cuda) || 0;
    if (gpuType.toLowerCase().includes("v100") || gpuType.toLowerCase().includes("t4")) {
      quirks.push("No bf16 support — use fp16 for mixed precision");
    }
    if (cudaVer > 0 && cudaVer < 11.6) {
      quirks.push("flash-attn requires CUDA 11.6+ — not available here");
    }
    if (gpuCount > 1) {
      quirks.push(`${gpuCount} GPUs available — use accelerate/DeepSpeed for multi-GPU training`);
    }
    if (quirks.length > 0) {
      notes.push("## Notes");
      quirks.forEach(q => notes.push(`- ${q}`));
    }

    const notesText = notes.join("\n");

    return NextResponse.json({ ok: true, notes: notesText });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Probe failed" },
      { status: 500 },
    );
  }
}
