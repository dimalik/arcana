/**
 * Resource preference helpers — stores and retrieves per-task-category
 * resource preferences using the existing AgentMemory model.
 */

import { prisma } from "@/lib/prisma";

const CATEGORY = "resource_preference";
const CONFIDENCE_THRESHOLD = 3;

export interface ResourcePreference {
  preference: "local" | "remote" | string; // "remote:<alias>" for specific host
  confidence: number;
}

/**
 * Get the learned resource preference for a task category.
 */
export async function getResourcePreference(
  userId: string,
  taskCategory: string,
  projectId?: string,
): Promise<ResourcePreference> {
  // Look for project-specific first, then global
  const memories = await prisma.agentMemory.findMany({
    where: {
      userId,
      category: CATEGORY,
      lesson: { startsWith: `${taskCategory}:` },
      ...(projectId ? {} : {}),
    },
    orderBy: { usageCount: "desc" },
    take: 5,
  });

  // Prefer project-specific match
  const match = (projectId && memories.find((m) => m.projectId === projectId)) || memories[0];

  if (!match) {
    return { preference: "auto", confidence: 0 };
  }

  // lesson format: "taskCategory:preference" e.g. "training:remote:lab-a100"
  const preference = match.lesson.slice(taskCategory.length + 1);
  return { preference: preference || "auto", confidence: match.usageCount };
}

/**
 * Record a user's resource choice for a task category.
 * Upserts: increments usageCount if same choice, resets if user overrode.
 */
export async function recordResourceChoice(
  userId: string,
  taskCategory: string,
  choice: string, // "local" | "remote" | "remote:<alias>"
  stepTitle: string,
  projectId?: string,
): Promise<void> {
  const lesson = `${taskCategory}:${choice}`;

  // Check for existing preference for this category
  const existing = await prisma.agentMemory.findFirst({
    where: {
      userId,
      category: CATEGORY,
      lesson: { startsWith: `${taskCategory}:` },
      ...(projectId ? { projectId } : {}),
    },
  });

  if (existing) {
    if (existing.lesson === lesson) {
      // Same choice — bump confidence
      await prisma.agentMemory.update({
        where: { id: existing.id },
        data: { usageCount: { increment: 1 }, context: stepTitle },
      });
    } else {
      // User overrode — reset to new choice with count 1
      await prisma.agentMemory.update({
        where: { id: existing.id },
        data: { lesson, usageCount: 1, context: `Override: ${stepTitle}` },
      });
    }
  } else {
    await prisma.agentMemory.create({
      data: {
        userId,
        category: CATEGORY,
        lesson,
        context: stepTitle,
        projectId: projectId || null,
        usageCount: 1,
      },
    });
  }
}

/**
 * Get all resource preferences for a user (for system prompt injection).
 */
export async function getAllResourcePreferences(
  userId: string,
): Promise<{ taskCategory: string; preference: string; usageCount: number }[]> {
  const memories = await prisma.agentMemory.findMany({
    where: { userId, category: CATEGORY },
    orderBy: { usageCount: "desc" },
  });

  return memories.map((m) => {
    const colonIdx = m.lesson.indexOf(":");
    return {
      taskCategory: m.lesson.slice(0, colonIdx),
      preference: m.lesson.slice(colonIdx + 1),
      usageCount: m.usageCount,
    };
  });
}

export { CONFIDENCE_THRESHOLD };
