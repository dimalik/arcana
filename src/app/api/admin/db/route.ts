import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// All models in dependency order (parents before children)
const MODEL_ORDER = [
  "user",
  "setting",
  "agentCapability",
  "tag",
  "collection",
  "paper",
  "userSession",
  "llmUsageLog",
  "appEvent",
  "paperTag",
  "collectionPaper",
  "agentSession",
  "tagCluster",
  "chatMessage",
  "promptResult",
  "concept",
  "paperRelation",
  "reference",
  "conversation",
  "conversationPaper",
  "notebookEntry",
  "discoverySession",
  "discoverySeed",
  "discoveryProposal",
  "paperEngagement",
  "mindPalaceRoom",
  "insight",
  "synthesisSession",
  "synthesisPaper",
  "synthesisSection",
  "researchProject",
  "researchIteration",
  "researchStep",
  "researchHypothesis",
  "researchLogEntry",
  "remoteHost",
  "remoteJob",
] as const;

/**
 * GET — Export entire database as JSON.
 * Returns { version, exportedAt, tables: { modelName: rows[] } }
 */
export async function GET() {
  try {
    await requireUserId();

    const tables: Record<string, unknown[]> = {};

    for (const model of MODEL_ORDER) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegate = (prisma as any)[model];
        if (delegate?.findMany) {
          tables[model] = await delegate.findMany();
        }
      } catch {
        // Model may not exist yet — skip
      }
    }

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      tables,
    };

    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="arcana-db-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (err) {
    console.error("[admin/db] GET error:", err);
    return NextResponse.json({ error: "Failed to export" }, { status: 500 });
  }
}

/**
 * POST — Import database from JSON.
 * Body: the full export JSON from GET.
 *
 * Strategy: clear all tables (in reverse order), then insert (in forward order).
 * This is a full replace, not a merge.
 */
export async function POST(request: NextRequest) {
  try {
    await requireUserId();

    const data = await request.json();
    if (!data.version || !data.tables) {
      return NextResponse.json({ error: "Invalid export format" }, { status: 400 });
    }

    const tables = data.tables as Record<string, Record<string, unknown>[]>;
    const stats: Record<string, number> = {};

    // 1. Delete all data in reverse dependency order
    for (const model of [...MODEL_ORDER].reverse()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegate = (prisma as any)[model];
        if (delegate?.deleteMany) {
          await delegate.deleteMany();
        }
      } catch {
        // Skip if model doesn't exist
      }
    }

    // 2. Insert data in forward order
    for (const model of MODEL_ORDER) {
      const rows = tables[model];
      if (!rows || !Array.isArray(rows) || rows.length === 0) continue;

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegate = (prisma as any)[model];
        if (!delegate?.create) continue;

        let imported = 0;
        for (const row of rows) {
          // Strip relation fields that Prisma won't accept in create
          const cleaned = stripRelations(row);
          try {
            await delegate.create({ data: cleaned });
            imported++;
          } catch (err) {
            console.warn(`[admin/db] Failed to import ${model} row:`, (err as Error).message?.slice(0, 100));
          }
        }
        stats[model] = imported;
      } catch (err) {
        console.warn(`[admin/db] Skipping ${model}:`, (err as Error).message?.slice(0, 100));
      }
    }

    return NextResponse.json({ ok: true, stats });
  } catch (err) {
    console.error("[admin/db] POST error:", err);
    return NextResponse.json({ error: "Failed to import" }, { status: 500 });
  }
}

/**
 * Remove nested relation objects from a row so Prisma create accepts it.
 * Keeps only scalar fields and JSON strings.
 */
function stripRelations(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      cleaned[key] = value;
    } else if (value instanceof Date || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      cleaned[key] = value;
    } else if (Array.isArray(value)) {
      // Skip relation arrays
    } else if (typeof value === "object") {
      // Check if it's a Date serialized as string (from JSON)
      const str = String(value);
      if (str.match(/^\d{4}-\d{2}-\d{2}T/)) {
        cleaned[key] = new Date(str);
      }
      // Otherwise skip (it's a nested relation)
    }
  }
  return cleaned;
}
