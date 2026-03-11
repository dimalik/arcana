import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from "crypto";

const SESSION_COOKIE = "arcana_session";
const SESSION_DURATION_DAYS = 30;

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  onboardingCompleted: boolean;
}

export interface UserProfile {
  researchRole: string | null;
  affiliation: string | null;
  domains: string[];
  expertiseLevel: string | null;
  reviewFocus: string[];
}

// ── Password helpers ───────────────────────────────────────────────

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

// ── Session helpers ────────────────────────────────────────────────

async function createSession(userId: string): Promise<string> {
  const token = randomUUID();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);

  await prisma.userSession.create({
    data: { userId, token, expiresAt },
  });

  return token;
}

async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60,
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Resolve the current user from the session cookie.
 * Returns null if no valid session exists (caller decides what to do).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) return null;

  const session = await prisma.userSession.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!session || session.expiresAt <= new Date()) {
    if (session) {
      await prisma.userSession.delete({ where: { id: session.id } }).catch(() => {});
    }
    return null;
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    onboardingCompleted: session.user.onboardingCompleted,
  };
}

/**
 * Require an authenticated user. Throws if not logged in.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  return user;
}

/**
 * Login with email + password. Sets session cookie.
 */
export async function login(email: string, password: string): Promise<CurrentUser> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    throw new Error("Invalid email or password");
  }

  if (!verifyPassword(password, user.passwordHash)) {
    throw new Error("Invalid email or password");
  }

  const token = await createSession(user.id);
  await setSessionCookie(token);

  return { id: user.id, email: user.email, name: user.name, role: user.role, onboardingCompleted: user.onboardingCompleted };
}

/**
 * Sign up a new user. Sets session cookie.
 */
export async function signup(
  email: string,
  password: string,
  name?: string
): Promise<CurrentUser> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      name: name || null,
      role: "member",
    },
  });

  const token = await createSession(user.id);
  await setSessionCookie(token);

  return { id: user.id, email: user.email, name: user.name, role: user.role, onboardingCompleted: user.onboardingCompleted };
}

/**
 * Logout: delete session and clear cookie.
 */
export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await prisma.userSession.deleteMany({ where: { token } }).catch(() => {});
  }

  cookieStore.set(SESSION_COOKIE, "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
}

/**
 * Seed the default user if no users exist.
 */
export async function seedDefaultUser(): Promise<void> {
  const count = await prisma.user.count();
  if (count > 0) return;

  await prisma.user.create({
    data: {
      email: "user@localhost",
      passwordHash: hashPassword("1234"),
      name: "Default User",
      role: "admin",
    },
  });
}

/**
 * Create a user without setting session (for admin use).
 */
export async function createUser(
  email: string,
  password: string,
  name?: string,
  role = "member"
): Promise<CurrentUser> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      name: name || null,
      role,
    },
  });

  return { id: user.id, email: user.email, name: user.name, role: user.role, onboardingCompleted: user.onboardingCompleted };
}

// ── User management ──────────────────────────────────────────────

export async function listUsers() {
  return prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      _count: { select: { llmUsageLogs: true, appEvents: true } },
    },
  });
}
