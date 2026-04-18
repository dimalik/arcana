import { NextResponse } from "next/server";
import { processingQueue } from "@/lib/processing/queue";
import { readPersistedProcessingStatus } from "@/lib/processing/runtime-ledger";

export async function GET() {
  await processingQueue.ensureInitialized();
  const status = await readPersistedProcessingStatus();
  return NextResponse.json(status);
}
