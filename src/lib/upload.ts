import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

export async function saveUploadedFile(file: File): Promise<{
  filePath: string;
  originalName: string;
}> {
  await mkdir(UPLOAD_DIR, { recursive: true });

  const ext = path.extname(file.name) || ".pdf";
  const filename = `${uuidv4()}${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  return {
    filePath: `uploads/${filename}`,
    originalName: file.name,
  };
}
