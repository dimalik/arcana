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

const globalForTagClusters = globalThis as typeof globalThis & {
  tagClusterBootstrapPromise?: Promise<ClusterResult | null>;
};

interface TagRow {
  id: string;
  name: string;
  _count: { papers: number };
}

interface ClusterDraft {
  name: string;
  description: string;
}

const MAX_TAXONOMY_TAGS = 80;
const ASSIGNMENT_BATCH_SIZE = 20;
const MIN_CLUSTER_COUNT = 5;
const MAX_CLUSTER_COUNT = 7;

function normalizeTagName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeClusterDraft(cluster: ClusterDraft): ClusterDraft {
  return {
    name: cluster.name.trim(),
    description: cluster.description.trim(),
  };
}

function chunkTags(tags: TagRow[], size: number): TagRow[][] {
  const chunks: TagRow[][] = [];
  for (let index = 0; index < tags.length; index += size) {
    chunks.push(tags.slice(index, index + size));
  }
  return chunks;
}

async function generateClusterTaxonomy(
  tags: TagRow[],
  llm: { provider: Awaited<ReturnType<typeof getDefaultModel>>["provider"]; modelId: string; proxyConfig: Awaited<ReturnType<typeof getDefaultModel>>["proxyConfig"] },
): Promise<ClusterDraft[]> {
  const taxonomyTags = tags
    .filter((tag) => tag._count.papers > 0)
    .slice(0, MAX_TAXONOMY_TAGS);

  const tagList = taxonomyTags
    .map((tag) => `- ${tag.name} (${tag._count.papers} papers)`)
    .join("\n");

  const system = `You are an expert research librarian creating top-level thematic categories for a paper library.

Create ${MIN_CLUSTER_COUNT}-${MAX_CLUSTER_COUNT} broad, reusable clusters that cover the tags below.

Return valid JSON:
{
  "clusters": [
    {
      "name": "Cluster Name",
      "description": "Short description"
    }
  ]
}

Rules:
- Cluster names must be broad themes, not individual tags.
- Prefer concise names of 2-4 words.
- Do not include a tags field.
- Return ONLY JSON.`;

  const prompt = `Representative tags:\n${tagList}`;

  const response = await generateLLMResponse({
    provider: llm.provider,
    modelId: llm.modelId,
    system,
    prompt,
    maxTokens: 900,
    proxyConfig: llm.proxyConfig,
  });

  const parsed = JSON.parse(cleanJsonResponse(response)) as {
    clusters?: ClusterDraft[];
  };

  const clusters = (parsed.clusters ?? [])
    .map(normalizeClusterDraft)
    .filter((cluster) => cluster.name.length > 0)
    .slice(0, MAX_CLUSTER_COUNT);

  if (clusters.length < MIN_CLUSTER_COUNT) {
    throw new Error(`LLM returned too few tag clusters (${clusters.length})`);
  }

  return clusters;
}

async function assignTagBatchToClusters(
  tags: TagRow[],
  clusters: ClusterDraft[],
  llm: { provider: Awaited<ReturnType<typeof getDefaultModel>>["provider"]; modelId: string; proxyConfig: Awaited<ReturnType<typeof getDefaultModel>>["proxyConfig"] },
): Promise<Map<string, string>> {
  const clusterList = clusters
    .map((cluster) => `- ${cluster.name}: ${cluster.description}`)
    .join("\n");
  const tagList = tags
    .map((tag) => `- ${tag.name}`)
    .join("\n");

  const system = `You are assigning research-library tags into an existing set of broad thematic clusters.

Return valid JSON:
{
  "assignments": [
    {
      "tag": "tag-name",
      "cluster": "Exact Cluster Name"
    }
  ]
}

Rules:
- Assign every tag to exactly one existing cluster.
- The cluster value must exactly match one of the provided cluster names.
- Do not invent new clusters.
- Return ONLY JSON.`;

  const prompt = `Clusters:\n${clusterList}\n\nTags to assign:\n${tagList}`;

  const response = await generateLLMResponse({
    provider: llm.provider,
    modelId: llm.modelId,
    system,
    prompt,
    maxTokens: 900,
    proxyConfig: llm.proxyConfig,
  });

  const parsed = JSON.parse(cleanJsonResponse(response)) as {
    assignments?: Array<{ tag?: string; cluster?: string }>;
  };

  const validClusterNames = new Set(clusters.map((cluster) => cluster.name));
  const assignments = new Map<string, string>();

  for (const assignment of parsed.assignments ?? []) {
    const tagName = normalizeTagName(assignment.tag ?? "");
    const clusterName = (assignment.cluster ?? "").trim();
    if (!tagName || !validClusterNames.has(clusterName)) continue;
    assignments.set(tagName, clusterName);
  }

  return assignments;
}

/**
 * Ask an LLM to group existing tags into thematic clusters,
 * then upsert TagCluster records and assign each tag.
 */
export async function generateTagClusters(): Promise<ClusterResult> {
  const tags = await prisma.tag.findMany({
    orderBy: [{ score: "desc" }, { name: "asc" }],
    include: { _count: { select: { papers: true } } },
  });

  if (tags.length === 0) {
    return { clusters: [], unassigned: [] };
  }

  const { provider, modelId, proxyConfig } = await getDefaultModel();
  const llm = { provider, modelId, proxyConfig };
  const parsedClusters = await generateClusterTaxonomy(tags, llm);

  const tagNameMap = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const assignedTagIds = new Set<string>();
  const clusterResults: ClusterResult["clusters"] = [];
  const assignmentByCluster = new Map<string, Set<string>>();

  for (const cluster of parsedClusters) {
    assignmentByCluster.set(cluster.name, new Set<string>());
  }

  for (const batch of chunkTags(tags, ASSIGNMENT_BATCH_SIZE)) {
    const assignments = await assignTagBatchToClusters(batch, parsedClusters, llm);
    for (const tag of batch) {
      const clusterName = assignments.get(normalizeTagName(tag.name));
      if (!clusterName) continue;
      assignmentByCluster.get(clusterName)?.add(tag.id);
    }
  }

  // Clear existing cluster assignments
  await prisma.tag.updateMany({
    data: { clusterId: null },
  });

  for (let i = 0; i < parsedClusters.length; i++) {
    const c = parsedClusters[i];

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
    for (const tagId of Array.from(assignmentByCluster.get(c.name) ?? [])) {
      if (!assignedTagIds.has(tagId)) {
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

export async function ensureTagClusters(): Promise<ClusterResult | null> {
  const existingClusterCount = await prisma.tagCluster.count();
  if (existingClusterCount > 0) {
    return null;
  }

  const tagCount = await prisma.tag.count();
  if (tagCount < 5) {
    return null;
  }

  if (!globalForTagClusters.tagClusterBootstrapPromise) {
    globalForTagClusters.tagClusterBootstrapPromise = (async () => {
      const recheckClusterCount = await prisma.tagCluster.count();
      if (recheckClusterCount > 0) {
        return null;
      }
      return generateTagClusters();
    })().finally(() => {
      globalForTagClusters.tagClusterBootstrapPromise = undefined;
    });
  }

  return globalForTagClusters.tagClusterBootstrapPromise;
}
