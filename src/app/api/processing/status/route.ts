import { NextResponse } from "next/server";
import { processingQueue } from "@/lib/processing/queue";

export async function GET() {
  const status = processingQueue.getStatus();
  return NextResponse.json(status);
}
