/**
 * Recovery script: re-import all PDFs from uploads/ directory.
 *
 * Creates paper records with extracted text, ready for batch processing.
 * Run: npx tsx scripts/recover-papers-from-uploads.ts
 */
import path from "path";
import { readdir, stat } from "fs/promises";
import { PrismaClient } from "../src/generated/prisma/client";
import { PDFParse } from "pdf-parse";
import { readFile } from "fs/promises";

const dbPath = path.join(process.cwd(), "prisma", "dev.db");
const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
const UPLOADS_DIR = path.join(process.cwd(), "uploads");

async function extractText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  if (buffer.length === 0) return "";
  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return result.text;
  } catch (err) {
    console.warn(`  Failed to extract text: ${(err as Error).message}`);
    return "";
  }
}

function extractTitleFromText(text: string): string {
  // Take the first non-empty line as a rough title
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return "Untitled Paper";
  // Title is usually the first line, capped at 200 chars
  const candidate = lines[0];
  if (candidate.length > 200) return candidate.slice(0, 200);
  return candidate;
}

async function main() {
  console.log("=== Paper Recovery from uploads/ ===\n");

  // 1. Ensure default user exists
  let user = await prisma.user.findFirst();
  if (!user) {
    console.log("Creating default user...");
    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update("1234").digest("hex");
    user = await prisma.user.create({
      data: {
        email: "user@localhost",
        passwordHash: hash,
        name: "Default User",
        role: "admin",
        onboardingCompleted: true,
      },
    });
    console.log(`  Created user: ${user.id}`);
  } else {
    // Ensure onboarding is completed so the app doesn't redirect
    if (!user.onboardingCompleted) {
      await prisma.user.update({
        where: { id: user.id },
        data: { onboardingCompleted: true },
      });
      console.log("  Marked onboarding complete");
    }
  }

  // 2. Create a session so the user is logged in
  const existingSession = await prisma.userSession.findFirst({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
  });
  if (!existingSession) {
    const { randomUUID } = await import("crypto");
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
    await prisma.userSession.create({
      data: { userId: user.id, token, expiresAt },
    });
    console.log(`  Created session (set cookie 'arcana_session' to: ${token})`);
  }

  // 3. Scan uploads/
  const files = await readdir(UPLOADS_DIR);
  const pdfs = files.filter(f => f.endsWith(".pdf"));
  console.log(`\nFound ${pdfs.length} PDFs in uploads/\n`);

  // 4. Check which already exist (by filename = old paper ID)
  const existingPapers = await prisma.paper.findMany({
    select: { id: true, filePath: true },
  });
  const existingFilePaths = new Set(existingPapers.map(p => p.filePath).filter(Boolean));

  let created = 0;
  let skipped = 0;
  let failed = 0;
  let empty = 0;

  for (let i = 0; i < pdfs.length; i++) {
    const filename = pdfs[i];
    const filePath = path.join(UPLOADS_DIR, filename);
    const relPath = `uploads/${filename}`;

    if (existingFilePaths.has(relPath)) {
      skipped++;
      continue;
    }

    const fileInfo = await stat(filePath);
    if (fileInfo.size === 0) {
      empty++;
      continue;
    }

    process.stdout.write(`  [${i + 1}/${pdfs.length}] ${filename.slice(0, 40)}... `);

    try {
      const text = await extractText(filePath);
      if (!text || text.length < 50) {
        console.log("too short, skipping");
        empty++;
        continue;
      }

      const title = extractTitleFromText(text);

      await prisma.paper.create({
        data: {
          userId: user.id,
          title,
          filePath: relPath,
          fullText: text,
          processingStatus: "TEXT_EXTRACTED",
        },
      });

      console.log(`OK (${Math.round(text.length / 1000)}k chars)`);
      created++;
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Created: ${created}`);
  console.log(`  Skipped (already exist): ${skipped}`);
  console.log(`  Empty/too short: ${empty}`);
  console.log(`  Failed: ${failed}`);
  console.log(`\nNext step: Go to Settings > Maintenance > "Batch Process All" to trigger LLM processing.`);
  console.log(`Or call: POST /api/papers/maintenance/batch { "action": "create" }`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
