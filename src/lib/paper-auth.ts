import { NextResponse } from "next/server";
import type { Prisma, PaperDuplicateState } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { getCurrentUser } from "./auth";
import {
  PAPER_COLLAPSED_INTO_HEADER,
  PAPER_DUPLICATE_STATE_HEADER,
  type PaperDuplicateStateSignal,
  toPaperDuplicateStateSignal,
} from "./papers/duplicate-state";

export type PaperAccessMode = "read" | "mutate" | "duplicate_state";

export interface DuplicateStateCarrier {
  duplicateState: PaperDuplicateStateSignal;
  collapsedIntoPaperId: string | null;
  setDuplicateStateHeaders<T extends Response>(response: T): T;
}

export interface PaperAccessResult<TPaper = {
  id: string;
  userId: string | null;
  duplicateState: PaperDuplicateState;
  collapsedIntoPaperId: string | null;
}> extends DuplicateStateCarrier {
  userId: string;
  paper: TPaper;
}

export class PaperAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly payload: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PaperAccessError";
  }
}

type PaperAccessOptions = {
  mode?: PaperAccessMode;
  select?: Prisma.PaperSelect;
  include?: Prisma.PaperInclude;
};

const PAPER_ACCESS_MINIMAL_SELECT = {
  id: true,
  userId: true,
  duplicateState: true,
  collapsedIntoPaperId: true,
} satisfies Prisma.PaperSelect;

/**
 * Get the current user's ID. Throws if not authenticated.
 */
export async function requireUserId(): Promise<string> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  return user.id;
}

function applyDuplicateStateHeaders<T extends Response>(
  response: T,
  duplicateState: PaperDuplicateStateSignal,
  collapsedIntoPaperId: string | null,
): T {
  response.headers.set(PAPER_DUPLICATE_STATE_HEADER, duplicateState);
  if (collapsedIntoPaperId) {
    response.headers.set(PAPER_COLLAPSED_INTO_HEADER, collapsedIntoPaperId);
  } else {
    response.headers.delete(PAPER_COLLAPSED_INTO_HEADER);
  }
  return response;
}

export function isPaperAccessError(error: unknown): error is PaperAccessError {
  return error instanceof PaperAccessError;
}

export function paperAccessErrorToResponse(error: unknown): NextResponse | null {
  if (!isPaperAccessError(error)) return null;
  return NextResponse.json(error.payload, { status: error.status });
}

export function jsonWithDuplicateState<T>(
  access: DuplicateStateCarrier,
  data: T,
  init?: ResponseInit,
  options?: { includeBodyState?: boolean },
): NextResponse {
  const body = options?.includeBodyState && data && typeof data === "object" && !Array.isArray(data)
    ? {
        ...(data as Record<string, unknown>),
        duplicateState: access.duplicateState,
        collapsedIntoPaperId: access.collapsedIntoPaperId,
      }
    : data;

  return access.setDuplicateStateHeaders(NextResponse.json(body, init));
}

/**
 * Verify a paper belongs to the current user and surface duplicate-state metadata.
 */
export async function requirePaperAccess(
  paperId: string,
  options: PaperAccessOptions = {},
): Promise<PaperAccessResult<any> | null> {
  const userId = await requireUserId();
  const minimalPaper = await prisma.paper.findFirst({
    where: { id: paperId, userId },
    select: PAPER_ACCESS_MINIMAL_SELECT,
  });

  if (!minimalPaper) return null;

  const duplicateState = toPaperDuplicateStateSignal(minimalPaper.duplicateState);
  const collapsedIntoPaperId = minimalPaper.collapsedIntoPaperId;

  if (options.mode === "mutate" && duplicateState === "collapsed") {
    throw new PaperAccessError(
      "Collapsed papers reject mutations",
      409,
      "paper_collapsed",
      {
        error: "paper_collapsed",
        collapsedIntoPaperId,
      },
    );
  }

  let paper: any = minimalPaper;
  if (options.select) {
    paper = await prisma.paper.findFirst({
      where: { id: paperId, userId },
      select: options.select,
    });
  } else if (options.include) {
    paper = await prisma.paper.findFirst({
      where: { id: paperId, userId },
      include: options.include,
    });
  }

  return Object.assign({}, paper, {
    userId,
    paper,
    duplicateState,
    collapsedIntoPaperId,
    setDuplicateStateHeaders<T extends Response>(response: T): T {
      return applyDuplicateStateHeaders(response, duplicateState, collapsedIntoPaperId);
    },
  });
}
