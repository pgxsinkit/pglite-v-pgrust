/**
 * The vendored pgrust surface, in one place.
 *
 * Types only — there is no `index.js`. Import **values** from the module that actually defines
 * them (`./wiresession.js`, `./wire.js`, `./pgrust-wasi.js`); this file exists so the whole
 * vendored API can be read, and its types imported, from a single entry point.
 *
 * The `.js` files beside it are copied byte-verbatim from a pgrust checkout by
 * `bun run sync:pgrust` (provenance in `SOURCE.md`, commit in `VERSION`) and are the one sanctioned
 * exception to this repo's no-plain-JavaScript rule. The `.d.ts` files are hand-written here.
 */

export type {
  ParsedAuthentication,
  ParsedBackendKeyData,
  ParsedColumn,
  ParsedCommandComplete,
  ParsedDataRow,
  ParsedMessage,
  ParsedNoticeOrError,
  ParsedParameterStatus,
  ParsedReadyForQuery,
  ParsedRowDescription,
  ParsedUnknown,
  WireMessage,
} from "./wire.js";
export { canonMessage, encodeQuery, encodeStartup, parseMessage, TERMINATE, WireReader } from "./wire.js";

export type { VfsManifest, VfsManifestFile } from "./pgrust-wasi.js";
export { GuestExit, Vfs } from "./pgrust-wasi.js";

export type { WireSessionOptions, WireStartOptions } from "./wiresession.js";
export { defaultWireArgv, jspiSupported, WireSession, WireSessionDead } from "./wiresession.js";
