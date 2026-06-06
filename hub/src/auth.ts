import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { removeUserFromAllChannels } from "./channels.js";
import { dbDeleteUser, dbListUsers, dbSaveUser } from "./db.js";
import type { User, UserRole } from "./types.js";

const users = new Map<string, User>();
const tokenToName = new Map<string, string>();
let nextSessionEpoch = 1;

export function getUserToken(name: string): string | null {
  return users.get(name)?.token ?? null;
}

export function registerUser(name: string, role: UserRole = "agent"): User {
  if (users.has(name)) {
    throw new Error(`User "${name}" is already registered`);
  }
  const token = randomBytes(32).toString("hex");
  const user: User = { name, token, role, registeredAt: Date.now(), epoch: nextSessionEpoch++ };
  users.set(name, user);
  tokenToName.set(token, name);
  dbSaveUser(user.name, user.token, user.role, user.registeredAt, user.epoch);
  return user;
}

export function unregisterUser(name: string, options: { preserveMemberships?: boolean } = {}): void {
  const user = users.get(name);
  if (user) {
    tokenToName.delete(user.token);
    users.delete(name);
    dbDeleteUser(name);
    if (!options.preserveMemberships) {
      removeUserFromAllChannels(name);
    }
  }
}

export function authenticateRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return tokenToName.get(token) ?? null;
}

export function getRegisteredUsers(): string[] {
  return Array.from(users.keys());
}

export function getUserRole(name: string): UserRole | null {
  return users.get(name)?.role ?? null;
}

export function getSessionEpoch(name: string): number | null {
  return users.get(name)?.epoch ?? null;
}

export function isCurrentSession(name: string, epoch: number | undefined): boolean {
  return epoch !== undefined && users.get(name)?.epoch === epoch;
}

export function getUsersByRole(role: UserRole): string[] {
  return Array.from(users.values())
    .filter((u) => u.role === role)
    .map((u) => u.name);
}

export function isUserRegistered(name: string): boolean {
  return users.has(name);
}

export function resetAuthState(): void {
  users.clear();
  tokenToName.clear();
  nextSessionEpoch = 1;
}

export function loadUsersFromDB(): void {
  users.clear();
  tokenToName.clear();
  let maxEpoch = 0;
  for (const row of dbListUsers()) {
    const role: UserRole = row.role === "bridge" ? "bridge" : "agent";
    const user: User = {
      name: row.name,
      token: row.token,
      role,
      registeredAt: row.registered_at,
      epoch: row.epoch,
    };
    users.set(user.name, user);
    tokenToName.set(user.token, user.name);
    maxEpoch = Math.max(maxEpoch, user.epoch);
  }
  nextSessionEpoch = maxEpoch + 1;
}
