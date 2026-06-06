// Runtime invariant checks for the hub's coupled in-memory state.
//
// The hub keeps several in-memory structures that must agree with each other
// and with the DB: the user↔token bijection (auth), the offline set (polling),
// and the channel-membership projection (channels). Nothing enforced these
// agreements, so a violation surfaced far away as a cryptic error. This module
// checks them: in development a violation throws loudly; in production it is
// logged and counted. The finders are pure functions of injected state so each
// invariant's violation path is unit-testable without corrupting real modules.

import { getTokenIndexForInvariant, getUsersForInvariant, isUserRegistered } from "./auth.js";
import { getMembershipView } from "./channels.js";
import { dbListChannelMembers, dbListChannels } from "./db.js";
import { getOfflineUsers } from "./polling.js";

const GENERAL_CHANNEL = "#all";

let violationCount = 0;

/** Total invariant violations observed in the production (non-throwing) path. */
export function getInvariantViolationCount(): number {
  return violationCount;
}

// Hard-fail (throw) is OPT-IN, never the default. NODE_ENV is not reliably set
// in this project's deployment (the systemd unit sets no NODE_ENV), so keying
// "throw" off `NODE_ENV !== "production"` would make production throw on every
// violation and crash-loop. Instead we throw only when development is explicitly
// signalled; production and unconfigured environments take the safe log+count
// path.
function isStrictMode(): boolean {
  return process.env.NODE_ENV === "development" || process.env.WALKIE_TALKIE_STRICT_INVARIANTS === "1";
}

// --- Pure finders -----------------------------------------------------------

/**
 * I1 — user↔token bijection: the `users` map and the `tokenToName` index must
 * be the same size and round-trip in both directions.
 */
export function findAuthViolations(
  users: ReadonlyMap<string, { token: string }>,
  tokenToName: ReadonlyMap<string, string>,
): string[] {
  const violations: string[] = [];
  if (users.size !== tokenToName.size) {
    violations.push(`auth: users.size (${users.size}) != tokenToName.size (${tokenToName.size})`);
  }
  for (const [name, user] of users) {
    if (tokenToName.get(user.token) !== name) {
      violations.push(`auth: user "${name}" token does not index back to it`);
    }
  }
  for (const [token, name] of tokenToName) {
    if (users.get(name)?.token !== token) {
      violations.push(`auth: token indexed to "${name}" is not that user's token`);
    }
  }
  return violations;
}

/** I2 — every user marked offline must still be registered. */
export function findOfflineSubsetViolations(
  offlineUsers: Iterable<string>,
  isRegistered: (name: string) => boolean,
): string[] {
  const violations: string[] = [];
  for (const name of offlineUsers) {
    if (!isRegistered(name)) {
      violations.push(`presence: offline user "${name}" is not registered`);
    }
  }
  return violations;
}

/**
 * I3/I6/I7 — the in-memory channel-membership projection must agree with the DB:
 *   I6: the `#all` channel is always present in memory.
 *   I7: every in-memory channel exists in the DB (no ghost channels).
 *   I3: every in-memory member of a channel is also a member in the DB.
 */
export function findMembershipViolations(
  memory: ReadonlyMap<string, ReadonlySet<string>>,
  dbMembers: ReadonlyMap<string, ReadonlySet<string>>,
  dbChannels: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  if (!memory.has(GENERAL_CHANNEL)) {
    violations.push(`membership: "${GENERAL_CHANNEL}" channel missing from in-memory projection`);
  }
  for (const [channel, members] of memory) {
    if (!dbChannels.has(channel)) {
      violations.push(`membership: in-memory channel "${channel}" is absent from the DB`);
      continue;
    }
    const dbSet = dbMembers.get(channel);
    for (const member of members) {
      if (!dbSet?.has(member)) {
        violations.push(`membership: member "${member}" in memory channel "${channel}" is absent from the DB`);
      }
    }
  }
  return violations;
}

// --- Orchestration ----------------------------------------------------------

/** Run every invariant finder over the hub's current live state. */
export function checkInvariants(): string[] {
  const violations: string[] = [];
  violations.push(...findAuthViolations(getUsersForInvariant(), getTokenIndexForInvariant()));
  violations.push(...findOfflineSubsetViolations(getOfflineUsers(), isUserRegistered));

  const dbChannels = new Set(dbListChannels().map((channel) => channel.name));
  const dbMembers = new Map<string, Set<string>>();
  for (const row of dbListChannelMembers()) {
    let set = dbMembers.get(row.channel);
    if (!set) {
      set = new Set();
      dbMembers.set(row.channel, set);
    }
    set.add(row.user_name);
  }
  violations.push(...findMembershipViolations(getMembershipView(), dbMembers, dbChannels));
  return violations;
}

/** Human-readable summary of a set of violations, tagged with where they occurred. */
export function formatInvariantError(context: string, violations: string[]): string {
  return `[invariant] ${violations.length} violation(s) after ${context}:\n  - ${violations.join("\n  - ")}`;
}

/**
 * Apply the assertion policy to a set of violations:
 *   - always log them via console.error and add them to the violation count;
 *   - in strict mode (explicit dev opt-in), additionally throw so the bug
 *     cannot be ignored.
 * Default (non-strict) never throws — safe for production and unconfigured envs.
 */
export function applyAssertionPolicy(violations: string[], context: string, options: { strict: boolean }): void {
  if (violations.length === 0) return;
  const message = formatInvariantError(context, violations);
  console.error(message);
  violationCount += violations.length;
  if (options.strict) {
    throw new Error(message);
  }
}

/**
 * Check all invariants and apply the policy: in strict mode (explicit dev
 * opt-in) throw loudly, otherwise log + count. Safe to call between mutations
 * (the hub mutates state synchronously, so a check never observes a half-applied
 * change), but never from inside a synchronous mutation block.
 *
 * Note: the membership check reads `dbListChannels`/`dbListChannelMembers`,
 * which are bounded list queries — adequate for the hub's expected scale; a
 * deployment with thousands of channels would want unbounded reads here.
 */
export function assertInvariants(context: string): void {
  applyAssertionPolicy(checkInvariants(), context, { strict: isStrictMode() });
}
