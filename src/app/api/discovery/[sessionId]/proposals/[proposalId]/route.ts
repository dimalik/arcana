import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * PUT /api/discovery/[sessionId]/proposals/[proposalId] — Update proposal status
 * Body: { status: "DISMISSED" | "PENDING" }
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string; proposalId: string }> }
) {
  const { sessionId, proposalId } = await params;
  const body = await req.json();
  const { status } = body;

  if (!["DISMISSED", "PENDING"].includes(status)) {
    return Response.json(
      { error: "status must be DISMISSED or PENDING" },
      { status: 400 }
    );
  }

  const proposal = await prisma.discoveryProposal.findFirst({
    where: { id: proposalId, sessionId },
  });

  if (!proposal) {
    return Response.json({ error: "Proposal not found" }, { status: 404 });
  }

  const updated = await prisma.discoveryProposal.update({
    where: { id: proposalId },
    data: { status },
  });

  return Response.json(updated);
}
