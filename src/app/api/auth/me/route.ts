import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Also fetch profile fields
    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        researchRole: true,
        affiliation: true,
        domains: true,
        expertiseLevel: true,
        reviewFocus: true,
      },
    });

    return NextResponse.json({
      ...user,
      researchRole: full?.researchRole ?? null,
      affiliation: full?.affiliation ?? null,
      domains: full?.domains ? JSON.parse(full.domains) : [],
      expertiseLevel: full?.expertiseLevel ?? null,
      reviewFocus: full?.reviewFocus ? JSON.parse(full.reviewFocus) : [],
    });
  } catch (err) {
    console.error("[api/auth/me] GET error:", err);
    return NextResponse.json(
      { error: "Failed to resolve user" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.researchRole !== undefined) data.researchRole = body.researchRole || null;
    if (body.affiliation !== undefined) data.affiliation = body.affiliation?.trim() || null;
    if (body.expertiseLevel !== undefined) data.expertiseLevel = body.expertiseLevel || null;
    if (body.domains !== undefined) {
      data.domains = Array.isArray(body.domains) && body.domains.length > 0
        ? JSON.stringify(body.domains)
        : null;
    }
    if (body.reviewFocus !== undefined) {
      data.reviewFocus = Array.isArray(body.reviewFocus) && body.reviewFocus.length > 0
        ? JSON.stringify(body.reviewFocus)
        : null;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: {
        id: true, email: true, name: true, role: true, onboardingCompleted: true,
        researchRole: true, affiliation: true, domains: true, expertiseLevel: true, reviewFocus: true,
      },
    });

    return NextResponse.json({
      ...updated,
      domains: updated.domains ? JSON.parse(updated.domains) : [],
      reviewFocus: updated.reviewFocus ? JSON.parse(updated.reviewFocus) : [],
    });
  } catch (err) {
    console.error("[api/auth/me] PATCH error:", err);
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }
}
