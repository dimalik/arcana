/**
 * LLM-based tag clustering: group surviving tags into 5-7 thematic clusters.
 */

import { prisma } from "@/lib/prisma";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { generateLLMResponse } from "@/lib/llm/provider";
import { cleanJsonResponse } from "@/lib/llm/prompts";

const CLUSTER_COLORS = [
  "#6366F1", // indigo
  "#EC4899", // pink
  "#F59E0B", // amber
  "#10B981", // emerald
  "#3B82F6", // blue
  "#EF4444", // red
  "#8B5CF6", // violet
];

export interface ClusterResult {
  clusters: { name: string; description: string; tagCount: number }[];
  unassigned: string[];
}

/**
 * Ask an LLM to group existing tags into thematic clusters,
 * then upsert TagCluster records and assign each tag.
 */
export async function generateTagClusters(): Promise<ClusterResult> {
  const tags = await prisma.tag.findMany({
    include: { _count: { select: { papers: true } } },
  });

  if (tags.length === 0) {
    return { clusters: [], unassigned: [] };
  }

  const { provider, modelId, proxyConfig } = await getDefaultModel();

  const tagList = tags
    .map((t) => `${t.name} (${t._count.papers} papers)`)
    .join("\n");

  const system = `You are an expert research librarian. Group the following tags into 5-7 thematic clusters. Each cluster should have a short name (2-3 words) and a brief description.

Return a JSON object:
{
  "clusters": [
    {
      "name": "Cluster Name",
      "description": "What this cluster covers",
      "tags": ["tag-name-1", "tag-name-2"]
    }
  ]
}

Rules:
- Every tag must appear in exactly one cluster.
- Cluster names should be broad research themes (e.g., "Language Models", "Computer Vision", "Training Methods").
- Aim for 5-7 clusters. Fewer is fine if the tags are focused.
- Return ONLY valid JSON. No markdown fences, no extra text.`;

  const prompt = `Here are the tags to cluster:\n\n${tagList}`;

  const result = await generateLLMResponse({
    provider,
    modelId,
    system,
    prompt,
    maxTokens: 2000,
    proxyConfig,
  });

  const cleaned = cleanJsonResponse(result);
  const parsed = JSON.parse(cleaned) as {
    clusters: { name: string; description: string; tags: string[] }[];
  };

  const tagNameMap = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const assignedTagIds = new Set<string>();
  const clusterResults: ClusterResult["clusters"] = [];

  // Clear existing cluster assignments
  await prisma.tag.updateMany({
    data: { clusterId: null },
  });

  for (let i = 0; i < parsed.clusters.length; i++) {
    const c = parsed.clusters[i];

    // Upsert the cluster
    const cluster = await prisma.tagCluster.upsert({
      where: { name: c.name },
      create: {
        name: c.name,
        description: c.description,
        color: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
        sortOrder: i,
      },
      update: {
        description: c.description,
        color: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
        sortOrder: i,
      },
    });

    // Assign tags to this cluster
    let count = 0;
    for (const tagName of c.tags) {
      const tagId = tagNameMap.get(tagName.toLowerCase());
      if (tagId && !assignedTagIds.has(tagId)) {
        await prisma.tag.update({
          where: { id: tagId },
          data: { clusterId: cluster.id },
        });
        assignedTagIds.add(tagId);
        count++;
      }
    }

    clusterResults.push({ name: c.name, description: c.description, tagCount: count });
  }

  // Delete clusters with 0 tags (stale from prior runs)
  const activeClusters = await prisma.tagCluster.findMany({
    include: { _count: { select: { tags: true } } },
  });
  const emptyIds = activeClusters
    .filter((c) => c._count.tags === 0)
    .map((c) => c.id);
  if (emptyIds.length > 0) {
    await prisma.tagCluster.deleteMany({ where: { id: { in: emptyIds } } });
  }

  // Tags not assigned by LLM
  const unassigned = tags
    .filter((t) => !assignedTagIds.has(t.id))
    .map((t) => t.name);

  return { clusters: clusterResults, unassigned };
}
