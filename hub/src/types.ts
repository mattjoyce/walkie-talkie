import type { IncomingMessage, ServerResponse } from "node:http";
import type { UserRole } from "@walkie-talkie/contract";

// Wire types live in the shared contract package; re-export the ones hub
// modules consume so existing `./types.js` imports keep resolving.
export type {
  AckRequest,
  ErrorResponse,
  Message,
  MessageImage,
  PollResponse,
  RegisterRequest,
  RegisterResponse,
  SendRequest,
  SendResponse,
  UserRole,
} from "@walkie-talkie/contract";

// Hub-internal shapes (never sent verbatim over the wire).
export interface User {
  name: string;
  token: string;
  role: UserRole;
  registeredAt: number;
  epoch: number;
}

export interface Channel {
  name: string;
  createdBy: string;
  createdAt: number;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  userName?: string,
  sessionEpoch?: number,
) => Promise<void>;
