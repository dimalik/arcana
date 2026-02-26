import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { formatBibtex, formatAPA } from "@/lib/references/citation";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; refId: string }> }
) {
  const { id, refId } = await params;
  const format = req.nextUrl.searchParams.get("format") || "bibtex";

  const reference = await prisma.reference.findFirst({
    where: { id: refId, paperId: id },
  });

  if (!reference) {
    return Response.json({ error: "Reference not found" }, { status: 404 });
  }

  let authors: string[] = [];
  try {
    if (reference.authors) authors = JSON.parse(reference.authors);
  } catch {
    // ignore
  }

  const citationData = {
    title: reference.title,
    authors,
    year: reference.year,
    venue: reference.venue,
    doi: reference.doi,
  };

  let citation: string;
  if (format === "apa") {
    citation = formatAPA(citationData);
  } else {
    citation = formatBibtex(citationData);
  }

  return Response.json({ citation, format });
}
