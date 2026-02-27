import { PDFParse } from "pdf-parse";

export async function extractTextFromPdf(filePath: string): Promise<string> {
  // Dynamic imports prevent Turbopack TP1004 static analysis of fs operations
  const fs = await import("fs/promises");
  const path = await import("path");
  const absolutePath = path.resolve(process.cwd(), filePath);

  const buffer = await fs.readFile(absolutePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
}
