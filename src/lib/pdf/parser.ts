import { readFile } from "fs/promises";
import path from "path";
import { PDFParse } from "pdf-parse";

export async function extractTextFromPdf(filePath: string): Promise<string> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  const buffer = await readFile(absolutePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
}
