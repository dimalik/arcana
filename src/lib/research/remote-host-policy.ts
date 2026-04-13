import { prisma } from "@/lib/prisma";

export function isSyntheticTestHostname(hostname: string): boolean {
  return hostname.trim().toLowerCase().endsWith(".invalid");
}

export function isSyntheticTestHost(host: { host: string }): boolean {
  return isSyntheticTestHostname(host.host);
}

export async function listDefaultResearchHosts(params?: {
  take?: number;
  includeSynthetic?: boolean;
}) {
  const where = params?.includeSynthetic ? undefined : {
    NOT: {
      host: {
        endsWith: ".invalid",
      },
    },
  };

  return prisma.remoteHost.findMany({
    where,
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    ...(params?.take ? { take: params.take } : {}),
  });
}

export async function findPreferredRemoteHost(params?: {
  alias?: string;
  includeSynthetic?: boolean;
}) {
  if (params?.alias) {
    return prisma.remoteHost.findFirst({
      where: { alias: params.alias },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  }

  const defaultHost = await prisma.remoteHost.findFirst({
    where: {
      isDefault: true,
      ...(params?.includeSynthetic ? {} : {
        NOT: {
          host: {
            endsWith: ".invalid",
          },
        },
      }),
    },
    orderBy: [{ createdAt: "asc" }],
  });
  if (defaultHost) return defaultHost;

  const hosts = await listDefaultResearchHosts({
    take: 1,
    includeSynthetic: params?.includeSynthetic,
  });
  return hosts[0] || null;
}

export async function countDefaultResearchHosts(params?: {
  includeSynthetic?: boolean;
}) {
  return prisma.remoteHost.count({
    where: params?.includeSynthetic ? undefined : {
      NOT: {
        host: {
          endsWith: ".invalid",
        },
      },
    },
  });
}
