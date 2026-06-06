import { randomUUID } from "node:crypto";
import { getUserRole, getUsersByRole, isUserRegistered } from "./auth.js";
import { getChannelMembers, isChannelMember } from "./channels.js";
import {
  dbAckDeliveries,
  dbDeleteDeliveriesForRecipient,
  dbEnqueueDelivery,
  dbListDeliveries,
  dbSaveMessage,
} from "./db.js";
import { deliverMessage } from "./polling.js";
import type { Message, MessageImage } from "./types.js";

const DELIVERY_BATCH_LIMIT = 100;

export function ensureQueue(name: string): void {
  void name;
}

export function removeQueue(name: string): void {
  dbDeleteDeliveriesForRecipient(name);
}

export function drainQueue(name: string): Message[] {
  const deliveries = dbListDeliveries(name, DELIVERY_BATCH_LIMIT);
  const messages = deliveries.map((delivery) => parseDelivery(delivery.id, delivery.message_json));
  ackDeliveries(
    name,
    messages.map((message) => message.deliveryId).filter((id): id is string => Boolean(id)),
  );
  return messages;
}

export function peekQueue(name: string): Message[] {
  return dbListDeliveries(name, DELIVERY_BATCH_LIMIT).map((delivery) =>
    parseDelivery(delivery.id, delivery.message_json),
  );
}

export function ackDeliveries(name: string, deliveryIds: string[]): void {
  dbAckDeliveries(name, deliveryIds);
}

function parseDelivery(deliveryId: string, messageJson: string): Message {
  return {
    ...(JSON.parse(messageJson) as Message),
    deliveryId,
  };
}

export function routeMessage(
  from: string,
  to: string,
  content: string,
  channel = "#all",
  image?: MessageImage,
): Message {
  const members = getChannelMembers(channel);

  if (to === "@all") {
    if (!isUserRegistered(from)) {
      throw new Error(`User "${from}" is not connected`);
    }

    if (!isChannelMember(channel, from)) {
      throw new Error(`User "${from}" is not a member of ${channel}`);
    }

    const message: Message = {
      id: randomUUID(),
      from,
      to: "@all",
      content,
      channel,
      timestamp: Date.now(),
      image,
    };

    dbSaveMessage(message);

    const senderRole = getUserRole(from);

    // Deliver to all channel members except sender.
    // When a bridge sends @all, skip other bridges to avoid relay loops.
    for (const user of members) {
      if (user === from) continue;
      if (senderRole === "bridge" && getUserRole(user) === "bridge") continue;
      enqueueAndDeliver(user, message);
    }
    return message;
  }

  const targetName = to.startsWith("@") ? to.slice(1) : to;

  if (!isUserRegistered(targetName)) {
    throw new Error(`User "${targetName}" is not connected`);
  }

  if (!isChannelMember(channel, targetName)) {
    throw new Error(`User "${targetName}" is not a member of ${channel}`);
  }

  const message: Message = {
    id: randomUUID(),
    from,
    to: targetName,
    content,
    channel,
    timestamp: Date.now(),
    image,
  };

  dbSaveMessage(message);

  // Deliver to all channel members except sender
  for (const user of members) {
    if (user !== from) {
      enqueueAndDeliver(user, message);
    }
  }
  return message;
}

export function enqueueAndDeliver(targetName: string, message: Message): void {
  ensureQueue(targetName);
  dbEnqueueDelivery(randomUUID(), targetName, message);
  deliverMessage(targetName);
}

export function notifyBridges(content: string): void {
  const bridges = getUsersByRole("bridge");
  const message: Message = {
    id: randomUUID(),
    from: "system",
    to: "@bridges",
    content,
    channel: "#all",
    timestamp: Date.now(),
  };
  for (const bridge of bridges) {
    enqueueAndDeliver(bridge, message);
  }
}
