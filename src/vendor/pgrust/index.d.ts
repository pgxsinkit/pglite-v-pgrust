/**
 * The vendored pgrust surface, in one place.
 *
 * Types only — there is no `index.js`. Import **values** from the module that actually defines
 * them (`./wiresession.js`, `./wire.js`, `./pgrust-wasi.js`); this file exists so the whole
 * vendored API can be read, and its types imported, from a single entry point.
 *
 * Two hosts live here, for two builds of the same pgrust commit. The single-session host
 * (`pgrust-wasi.js` + `wiresession.js`) suspends the guest's blocking stdin read with JSPI and is
 * imported statically, so Vite bundles it. The threads host (`threads-host.js` and the four files
 * around it) blocks that read in `Atomics.wait` on a worker instead, needs no JSPI, and is **not**
 * bundled: it builds its workers from URLs it computes at run time, so `bun run sync:pgrust` lays
 * it out under `public/pgrust/host/` and the engine worker loads it from there. Its types are
 * still reached from here, through `typeof import("./threads-host.js")`.
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

export type { SabPipeDescriptor } from "./sab-pipe.js";
export { SabPipe } from "./sab-pipe.js";

export type { ImportDescriptor, ModuleImports, PipeDescriptors } from "./threads-host.js";
export {
  createSharedMemory,
  inspectImports,
  makeWorker,
  newMessageChannel,
  onPortMessage,
  onWorkerError,
  onWorkerMessage,
  PipeRegistry,
  storageWorkerUrl,
  threadWorkerUrl,
} from "./threads-host.js";

export type {
  RepackedBundle,
  RepackedChannel,
  RepackedChannelTransfer,
  RepackedDoorbell,
  RepackedStat,
  RepackedSyncClient,
} from "./broker-fs.js";
export { loadRepackedBundle, repackedBundleUrl } from "./broker-fs.js";
