import { prisma } from "@/lib/prisma";

export interface UserContext {
  researchRole: string | null;
  affiliation: string | null;
  domains: string[];
  expertiseLevel: string | null;
  reviewFocus: string[];
}

const ROLE_LABELS: Record<string, string> = {
  phd_student: "PhD student",
  postdoc: "postdoctoral researcher",
  professor: "professor",
  industry_researcher: "industry researcher",
  engineer: "engineer",
  student: "student",
};

const FOCUS_LABELS: Record<string, string> = {
  methodology: "methodology and experimental design",
  novelty: "novelty and originality of contributions",
  applications: "practical applications and real-world impact",
  reproducibility: "reproducibility and code/data availability",
  theoretical_rigor: "theoretical rigor and mathematical correctness",
  clinical_relevance: "clinical relevance and translational potential",
};

const LEVEL_INSTRUCTIONS: Record<string, string> = {
  beginner: "Explain technical concepts clearly with background context. Define jargon and acronyms. Use analogies where helpful.",
  intermediate: "Assume familiarity with standard methods but explain novel or unusual techniques.",
  expert: "Be technically precise. Skip basic explanations. Focus on subtle methodological choices and their implications.",
};

/**
 * Fetch user profile from DB and return a UserContext.
 */
export async function getUserContext(userId: string): Promise<UserContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      researchRole: true,
      affiliation: true,
      domains: true,
      expertiseLevel: true,
      reviewFocus: true,
    },
  });

  if (!user) return null;

  const domains = user.domains ? JSON.parse(user.domains) as string[] : [];
  const reviewFocus = user.reviewFocus ? JSON.parse(user.reviewFocus) as string[] : [];

  // Return null if profile is essentially empty
  if (!user.researchRole && domains.length === 0 && !user.expertiseLevel && reviewFocus.length === 0) {
    return null;
  }

  return {
    researchRole: user.researchRole,
    affiliation: user.affiliation,
    domains,
    expertiseLevel: user.expertiseLevel,
    reviewFocus,
  };
}

/**
 * Build a system prompt preamble from the user's profile.
 * Returns empty string if no profile data is available.
 */
export function buildUserContextPreamble(ctx: UserContext | null): string {
  if (!ctx) return "";

  const parts: string[] = [];

  // Describe who the reader is
  const roleParts: string[] = [];
  if (ctx.researchRole) {
    roleParts.push(ROLE_LABELS[ctx.researchRole] || ctx.researchRole);
  }
  if (ctx.affiliation) {
    roleParts.push(`at ${ctx.affiliation}`);
  }
  if (ctx.domains.length > 0) {
    roleParts.push(`working in ${ctx.domains.join(", ")}`);
  }
  if (roleParts.length > 0) {
    parts.push(`The reader is a ${roleParts.join(" ")}.`);
  }

  // Expertise level instructions
  if (ctx.expertiseLevel && LEVEL_INSTRUCTIONS[ctx.expertiseLevel]) {
    parts.push(LEVEL_INSTRUCTIONS[ctx.expertiseLevel]);
  }

  // Review focus priorities
  if (ctx.reviewFocus.length > 0) {
    const focusLabels = ctx.reviewFocus
      .map((f) => FOCUS_LABELS[f] || f)
      .join(", ");
    parts.push(`Pay special attention to: ${focusLabels}.`);
  }

  if (parts.length === 0) return "";

  return `\n\n--- Reader Context ---\n${parts.join(" ")}\n--- End Reader Context ---`;
}
