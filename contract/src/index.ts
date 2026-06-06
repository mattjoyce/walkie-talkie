// @walkie-talkie/contract
//
// The single source of truth for everything that crosses a process boundary:
// the wire types the hub exchanges with its clients, the control-message
// sentinels embedded in message `content`, and the coordinated timeouts whose
// relative ordering is load-bearing. The hub, mcp-server, and slack-bot all
// import from here, so a field, sentinel, or constant change becomes a compile
// error in every consumer instead of a silent cross-boundary drift.

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type UserRole = "agent" | "bridge";

export interface MessageImage {
  data: string; // base64 (no data-URI prefix)
  mimeType: string; // e.g. "image/png"
}

export interface Message {
  id: string;
  deliveryId?: string;
  from: string;
  to: string;
  content: string;
  channel: string;
  timestamp: number;
  image?: MessageImage;
}

export interface RegisterRequest {
  name: string;
  oldToken?: string;
  role?: UserRole;
}

export interface RegisterResponse {
  token: string;
  name: string;
}

export interface SendRequest {
  to: string;
  content: string;
  channel?: string;
  image?: MessageImage;
}

export interface SendResponse {
  id: string;
  to: string;
}

export interface PollResponse {
  messages: Message[];
}

export interface AckRequest {
  deliveryIds: string[];
}

export interface HubUser {
  name: string;
  online: boolean;
  role: UserRole;
}

export interface UsersResponse {
  users: HubUser[];
}

export interface ChannelSummary {
  name: string;
  memberCount: number;
  createdBy: string;
}

export interface AgentConfigDTO {
  id: string;
  name: string;
  workDir: string;
  command: string;
  autoStart: boolean;
  envVars: Record<string, string>;
  createdAt: number;
  online: boolean;
}

export interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// Error taxonomy
//
// Every failure that crosses the hub boundary is a `HubError` with a
// discriminated `code` callers branch on, a human `message`, and a `retryable`
// flag. The wire body (`HubErrorBody`) additionally carries the legacy `error`
// field so existing consumers (slack-bot, dashboard) keep working. The hub
// throws/sends these; the mcp-server client reconstructs them so the tool layer
// can switch on `code` instead of string-matching message text.
// ---------------------------------------------------------------------------

export type HubErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_REGISTERED"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "RECIPIENT_NOT_FOUND"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "METHOD_NOT_ALLOWED"
  | "HUB_UNREACHABLE"
  | "INTERNAL";

/** The typed fields of an error response body. */
export interface HubErrorBody {
  code: HubErrorCode;
  message: string;
  retryable: boolean;
}

/** Only these codes represent transient conditions worth retrying. */
const RETRYABLE_CODES: ReadonlySet<HubErrorCode> = new Set<HubErrorCode>(["HUB_UNREACHABLE", "INTERNAL"]);

/** True when a code represents a transient failure a caller may retry. */
export function isRetryable(code: HubErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

const CODE_BY_STATUS: Readonly<Record<number, HubErrorCode>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  500: "INTERNAL",
  503: "HUB_UNREACHABLE",
};

/** Map an HTTP status to its default error code (INTERNAL if unknown). */
export function codeForStatus(status: number): HubErrorCode {
  return CODE_BY_STATUS[status] ?? "INTERNAL";
}

const STATUS_BY_CODE: Readonly<Record<HubErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  NOT_REGISTERED: 401,
  FORBIDDEN: 403,
  RECIPIENT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
  HUB_UNREACHABLE: 503,
};

/** Map an error code to the HTTP status the hub uses for it. */
export function statusForCode(code: HubErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** A typed error crossing the hub boundary. */
export class HubError extends Error {
  readonly code: HubErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: HubErrorCode, message: string, status?: number) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.status = status ?? statusForCode(code);
    this.retryable = isRetryable(code);
  }

  /** The typed wire fields for this error. */
  toBody(): HubErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }

  /** Reconstruct a HubError from a wire body and the response status. */
  static fromBody(body: HubErrorBody, status: number): HubError {
    return new HubError(body.code, body.message, status);
  }
}

/** True when `value` is one of the known `HubErrorCode`s. */
export function isHubErrorCode(value: unknown): value is HubErrorCode {
  return typeof value === "string" && value in STATUS_BY_CODE;
}

/** True when `data` carries the typed error fields `{code, message, retryable}`. */
export function isHubErrorBody(data: unknown): data is HubErrorBody {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Partial<HubErrorBody>;
  return (
    isHubErrorCode(candidate.code) && typeof candidate.message === "string" && typeof candidate.retryable === "boolean"
  );
}

export type HubEvent =
  | {
      type: "message";
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: MessageImage;
    }
  | { type: "join"; name: string; timestamp: number }
  | { type: "leave"; name: string; timestamp: number }
  | { type: "channel_create"; name: string; timestamp: number }
  | { type: "channel_join"; channel: string; userName: string; timestamp: number }
  | { type: "channel_leave"; channel: string; userName: string; timestamp: number }
  | { type: "channel_delete"; name: string; timestamp: number }
  | { type: "status"; name: string; online: boolean; timestamp: number }
  | { type: "typing"; name: string; channel: string; timestamp: number }
  | { type: "read_update"; userName: string; channel: string; timestamp: number }
  | { type: "agent_config_create"; id: string; name: string; timestamp: number }
  | { type: "agent_config_update"; id: string; name: string; timestamp: number }
  | { type: "agent_config_delete"; id: string; timestamp: number };

// ---------------------------------------------------------------------------
// Control-message sentinels
//
// Some messages carry control signals in their `content` rather than the
// message envelope. Each prefix below is the literal text producers prepend and
// consumers strip; `TYPING` is an exact-match marker. Use the helpers so the
// prefix lives in exactly one place.
// ---------------------------------------------------------------------------

export const RADIO_KILLED_PREFIX = "RADIO_KILLED: ";
export const CONNECTED_USERS_PREFIX = "CONNECTED_USERS: ";
export const USER_JOINED_PREFIX = "USER_JOINED: ";
export const USER_LEFT_PREFIX = "USER_LEFT: ";

/** Exact `content` value a client sends to broadcast a typing indicator. */
export const TYPING_SIGNAL = "TYPING";

/** Build a control message from a prefix and its payload. */
export function formatControl(prefix: string, payload: string): string {
  return `${prefix}${payload}`;
}

/** True when `content` is a control message of the given prefix. */
export function isControl(content: string, prefix: string): boolean {
  return content.startsWith(prefix);
}

/** Strip the prefix off a control message to recover its payload. */
export function stripControl(content: string, prefix: string): string {
  return content.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// Coordinated timeouts
//
// These values are coupled across processes; their *ordering* is the invariant,
// so the margins are derived here rather than re-typed per module:
//   POLL_CLIENT_TIMEOUT_MS  >  POLL_HOLD_MS      (the hub, not the client, ends the long-poll)
//   REGISTER_GRACE_RETRY_MS >  STALE_GRACE_MS    (a re-registering bridge waits out the grace window)
// The shell client (plugin/bin/radio-wait.sh) cannot import this module; it
// mirrors POLL_CLIENT_TIMEOUT_MS in seconds and references this file.
// ---------------------------------------------------------------------------

/** How long the hub holds a long-poll open before returning empty. */
export const POLL_HOLD_MS = 3_600_000; // 1 hour

/** Slack added so a client waits past the hub hold instead of timing out first. */
export const POLL_CLIENT_MARGIN_MS = 60_000;

/** Client-side poll timeout. Must exceed POLL_HOLD_MS. */
export const POLL_CLIENT_TIMEOUT_MS = POLL_HOLD_MS + POLL_CLIENT_MARGIN_MS;

/** Grace before the hub auto-unregisters a disconnected user. */
export const STALE_GRACE_MS = 30_000;

/** Slack added so a re-registering bridge waits out the grace window. */
export const REGISTER_GRACE_MARGIN_MS = 5_000;

/** How long a bridge waits before retrying a 409 (already-registered) register. */
export const REGISTER_GRACE_RETRY_MS = STALE_GRACE_MS + REGISTER_GRACE_MARGIN_MS;
