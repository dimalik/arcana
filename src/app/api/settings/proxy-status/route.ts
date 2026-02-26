import { NextResponse } from "next/server";
import { isProxyConfigured } from "@/lib/llm/proxy-settings";

export async function GET() {
  const enabled = await isProxyConfigured();
  return NextResponse.json({ enabled });
}
