/**
 * Hand-written types for the vendored `wire.js` (pgwire 3.0 frame codec).
 *
 * Ours, not pgrust's: `wire.js` is copied byte-verbatim by `bun run sync:pgrust` and is plain
 * JavaScript, so this declaration file is what makes it type-check under `allowJs: false`. It
 * describes only the surface this repo uses; keep it in step with the vendored source.
 */

/** One backend message as `WireReader` yields it: the type byte and the body after the length. */
export interface WireMessage {
  readonly t: string;
  readonly body: Uint8Array;
}

export interface ParsedColumn {
  readonly name: string;
  readonly typeid: number;
}

/** `R` — Authentication. */
export interface ParsedAuthentication {
  readonly t: "R";
  readonly code: number;
}

/** `S` — ParameterStatus. */
export interface ParsedParameterStatus {
  readonly t: "S";
  readonly name: string;
  readonly value: string;
}

/** `K` — BackendKeyData; the pid and cancel key are deliberately not decoded. */
export interface ParsedBackendKeyData {
  readonly t: "K";
}

/** `Z` — ReadyForQuery; `status` is `I`, `T` or `E`. */
export interface ParsedReadyForQuery {
  readonly t: "Z";
  readonly status: string;
}

/** `T` — RowDescription. */
export interface ParsedRowDescription {
  readonly t: "T";
  readonly columns: readonly ParsedColumn[];
}

/** `D` — DataRow, decoded as text; a SQL NULL is `null`. */
export interface ParsedDataRow {
  readonly t: "D";
  readonly values: readonly (string | null)[];
}

/** `C` — CommandComplete. */
export interface ParsedCommandComplete {
  readonly t: "C";
  readonly tag: string;
}

/** `E` — ErrorResponse and `N` — NoticeResponse share one shape. */
export interface ParsedNoticeOrError {
  readonly t: "E" | "N";
  readonly fields: Readonly<Record<string, string>>;
  readonly severity: string;
  readonly message: string;
}

/** Any message type the parser does not decode; the body is passed through untouched. */
export interface ParsedUnknown {
  readonly t: string;
  readonly raw: Uint8Array;
}

export type ParsedMessage =
  | ParsedAuthentication
  | ParsedParameterStatus
  | ParsedBackendKeyData
  | ParsedReadyForQuery
  | ParsedRowDescription
  | ParsedDataRow
  | ParsedCommandComplete
  | ParsedNoticeOrError
  | ParsedUnknown;

/**
 * Decode one backend message body. Declared as overloads rather than a discriminated union return
 * so that a caller switching on the message type gets the exact shape back: the catch-all arm
 * carries `t: string`, which would otherwise defeat narrowing.
 */
export declare function parseMessage(t: "R", body: Uint8Array): ParsedAuthentication;
export declare function parseMessage(t: "S", body: Uint8Array): ParsedParameterStatus;
export declare function parseMessage(t: "K", body: Uint8Array): ParsedBackendKeyData;
export declare function parseMessage(t: "Z", body: Uint8Array): ParsedReadyForQuery;
export declare function parseMessage(t: "T", body: Uint8Array): ParsedRowDescription;
export declare function parseMessage(t: "D", body: Uint8Array): ParsedDataRow;
export declare function parseMessage(t: "C", body: Uint8Array): ParsedCommandComplete;
export declare function parseMessage(t: "E" | "N", body: Uint8Array): ParsedNoticeOrError;
export declare function parseMessage(t: string, body: Uint8Array): ParsedMessage;

/** The canonical one-line rendering the pgrust wire e2e byte-compares against. */
export declare function canonMessage(t: string, body: Uint8Array): string;

/** Frontend StartupMessage for the given parameters (`user`, `database`, …). */
export declare function encodeStartup(params: Readonly<Record<string, string>>): Uint8Array;

/** Frontend simple-query (`Q`) frame. */
export declare function encodeQuery(sql: string): Uint8Array;

/** The frontend Terminate (`X`) frame. */
export declare const TERMINATE: Uint8Array;

/** Incremental backend-message framer: feed raw stdout bytes, pull complete messages. */
export declare class WireReader {
  /** Bytes buffered but not yet part of a complete message. */
  readonly buffered: number;
  feed(bytes: Uint8Array): void;
  /** The next complete message, or null when more bytes are needed. */
  next(): WireMessage | null;
}
