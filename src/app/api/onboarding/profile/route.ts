import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const VALID_ROLES = ["phd_student", "postdoc", "professor", "industry_researcher", "engineer", "student", "other"];
const VALID_LEVELS = ["beginner", "intermediate", "expert"];
const VALID_FOCUS = ["methodology", "novelty", "applications", "reproducibility", "theoretical_rigor", "clinical_relevance"];

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { name, researchRole, affiliation, domains, expertiseLevel, reviewFocus } = body;

  if (researchRole && !VALID_ROLES.includes(researchRole)) {
    return NextResponse.json({ error: "Invalid research role" }, { status: 400 });
  }
  if (expertiseLevel && !VALID_LEVELS.includes(expertiseLevel)) {
    return NextResponse.json({ error: "Invalid expertise level" }, { status: 400 });
  }

  const validFocus = Array.isArray(reviewFocus)
    ? reviewFocus.filter((f: string) => VALID_FOCUS.includes(f))
    : [];

  const validDomains = Array.isArray(domains)
    ? domains.filter((d: string) => typeof d === "string" && d.trim().length > 0).map((d: string) => d.trim().toLowerCase())
    : [];

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(name !== undefined ? { name: name.trim() || null } : {}),
      researchRole: researchRole || null,
      affiliation: affiliation?.trim() || null,
      domains: validDomains.length > 0 ? JSON.stringify(validDomains) : null,
      expertiseLevel: expertiseLevel || null,
      reviewFocus: validFocus.length > 0 ? JSON.stringify(validFocus) : null,
    },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    researchRole: updated.researchRole,
    affiliation: updated.affiliation,
    domains: updated.domains ? JSON.parse(updated.domains) : [],
    expertiseLevel: updated.expertiseLevel,
    reviewFocus: updated.reviewFocus ? JSON.parse(updated.reviewFocus) : [],
  });
}
