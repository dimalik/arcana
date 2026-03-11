import { NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/auth";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    const user = await login(email, password);

    logger.info(`User logged in: ${email}`, {
      category: "auth",
      userId: user.id,
    });

    return NextResponse.json(user);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Login failed";
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}
