import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, FileText, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUserId } from "@/lib/paper-auth";
import { getAuthorLibraryView } from "@/lib/papers/authors/library";
import { parsePaperAuthorsJson } from "@/lib/papers/authors/normalize";

function formatAuthors(authors: string | null): string {
  const parsed = parsePaperAuthorsJson(authors);
  if (parsed.length <= 3) return parsed.join(", ");
  return `${parsed.slice(0, 3).join(", ")} et al.`;
}

export default async function AuthorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await requireUserId();
  const { id } = await params;

  const authorView = await getAuthorLibraryView({
    authorId: id,
    userId,
  });

  if (!authorView) {
    notFound();
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to library
        </Link>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {authorView.author.name}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-4 w-4" />
              {authorView.paperCount} paper{authorView.paperCount === 1 ? "" : "s"} in library
            </span>
            {authorView.author.orcid && (
              <a
                href={`https://orcid.org/${authorView.author.orcid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 hover:text-foreground"
              >
                ORCID
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      </div>

      {authorView.papers.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No visible library papers for this author yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {authorView.papers.map((paper) => {
            const displayAuthors = formatAuthors(paper.authors);
            const externalUrl =
              paper.sourceUrl || (paper.doi ? `https://doi.org/${paper.doi}` : null);

            return (
              <Card key={paper.id} className="transition-colors hover:bg-accent/40">
                <CardHeader className="gap-3 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <CardTitle className="text-lg leading-tight">
                        <Link href={`/papers/${paper.id}`} className="hover:underline">
                          {paper.title}
                        </Link>
                      </CardTitle>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        {displayAuthors && (
                          <span className="inline-flex items-center gap-1.5">
                            <Users className="h-3.5 w-3.5" />
                            {displayAuthors}
                          </span>
                        )}
                        {paper.year && <span>{paper.year}</span>}
                        {paper.citationCount != null && (
                          <span className="inline-flex items-center gap-1.5">
                            <FileText className="h-3.5 w-3.5" />
                            {paper.citationCount} citations
                          </span>
                        )}
                        {paper.venue && <span>{paper.venue}</span>}
                      </div>
                    </div>
                    {externalUrl && (
                      <a
                        href={externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </CardHeader>
                {paper.abstract && (
                  <CardContent className="pt-0 text-sm text-muted-foreground">
                    {paper.abstract}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
