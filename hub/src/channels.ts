import {
  dbAddChannelMember,
  dbGetChannel,
  dbListChannelMembers,
  dbListChannels,
  dbRemoveAllMembersOfChannel,
  dbRemoveChannelMember,
  dbRemoveUserFromAllChannels,
} from "./db.js";

// Rebuildable projection of the channel_members table. Writes go through the DB first.
const channelMembers = new Map<string, Set<string>>();

function ensureCachedChannel(channel: string): Set<string> {
  let members = channelMembers.get(channel);
  if (!members) {
    members = new Set();
    channelMembers.set(channel, members);
  }
  return members;
}

export function loadMembershipFromDB(): void {
  channelMembers.clear();
  const channels = new Set<string>();
  for (const channel of dbListChannels()) {
    channels.add(channel.name);
    ensureCachedChannel(channel.name);
  }
  for (const member of dbListChannelMembers()) {
    if (!channels.has(member.channel)) continue;
    ensureCachedChannel(member.channel).add(member.user_name);
  }
}

export function initGeneralChannel(): void {
  loadMembershipFromDB();
}

export function joinChannel(channel: string, userName: string): void {
  const dbChannel = dbGetChannel(channel);
  if (!dbChannel) {
    throw new Error(`Channel "${channel}" does not exist`);
  }
  dbAddChannelMember(channel, userName);
  ensureCachedChannel(channel).add(userName);
}

export function leaveChannel(channel: string, userName: string): void {
  dbRemoveChannelMember(channel, userName);
  const members = channelMembers.get(channel);
  if (members) {
    members.delete(userName);
  }
}

export function removeUserFromAllChannels(userName: string): void {
  dbRemoveUserFromAllChannels(userName);
  for (const members of channelMembers.values()) {
    members.delete(userName);
  }
}

export function getChannelMembers(channel: string): string[] {
  const members = channelMembers.get(channel);
  return members ? Array.from(members) : [];
}

export function getUserChannels(userName: string): string[] {
  const result: string[] = [];
  for (const [channel, members] of channelMembers) {
    if (members.has(userName)) {
      result.push(channel);
    }
  }
  return result;
}

export function isChannelMember(channel: string, userName: string): boolean {
  const members = channelMembers.get(channel);
  return members ? members.has(userName) : false;
}

export function getChannelMemberCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [channel, members] of channelMembers) {
    counts.set(channel, members.size);
  }
  return counts;
}

export function ensureChannelMembership(channel: string): void {
  ensureCachedChannel(channel);
}

export function removeChannel(channel: string): void {
  channelMembers.delete(channel);
  dbRemoveAllMembersOfChannel(channel);
}

export function resetChannelState(): void {
  channelMembers.clear();
}

/**
 * Read-only view of the in-memory membership projection, for invariant checks.
 * The returned map and its sets must not be mutated by callers.
 */
export function getMembershipView(): ReadonlyMap<string, ReadonlySet<string>> {
  return channelMembers;
}
