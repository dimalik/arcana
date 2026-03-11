import { NextRequest, NextResponse } from "next/server";
import { signup } from "@/lib/auth";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const { email, password, name } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    if (password.length < 4) {
      return NextResponse.json(
        { error: "Password must be at least 4 characters" },
        { status: 400 }
      );
    }

    const user = await signup(email, password, name);

    logger.info(`New user signed up: ${email}`, {
      category: "auth",
      userId: user.id,
    });

    return NextResponse.json(user);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Signup failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
