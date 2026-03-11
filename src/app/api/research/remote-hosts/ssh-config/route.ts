import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/paper-auth";
import { parseSSHConfig } from "@/lib/research/ssh-config";

// GET — List available SSH config host aliases
export async function GET() {
  try {
    await requireUserId();
    const entries = await parseSSHConfig();
    return NextResponse.json(entries);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read SSH config" },
      { status: 500 },
    );
  }
}
