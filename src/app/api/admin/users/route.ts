import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, listUsers, createUser } from "@/lib/auth";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const users = await listUsers();
    return NextResponse.json(users);
  } catch (err) {
    console.error("[api/admin/users] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { email, password, name } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    const newUser = await createUser(email, password || "changeme", name);
    return NextResponse.json(newUser, { status: 201 });
  } catch (err) {
    console.error("[api/admin/users] POST error:", err);
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 }
    );
  }
}
