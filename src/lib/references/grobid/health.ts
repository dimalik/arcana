import type { GrobidHealthStatus } from "./types";

export async function checkGrobidHealth(
  serverUrl: string,
  timeoutMs = 5_000,
): Promise<{ status: GrobidHealthStatus; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${serverUrl}/api/isalive`, {
      method: "GET",
      signal: controller.signal,
    });

    if (response.ok) {
      return { status: "healthy" };
    }

    return {
      status: "unhealthy",
      detail: `GROBID returned ${response.status}`,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
