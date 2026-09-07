/**
 * Types for `tinytar`, the tar implementation PGlite writes its datadir backups with.
 *
 * Hand-written here because the package ships none (it is ES5 CommonJS from 2016). The shape below
 * is what `lib/types.js`'s `posixHeader` reads and writes, narrowed to what a datadir tarball uses:
 * `tar` takes the files it will write, `untar` returns the header fields it parsed with the data.
 *
 * This repo does not use tinytar for its own sake. `dumpDataDir`/`loadDataDir` on a pgrust store
 * have to produce and consume the tarball PGlite's `createTarball`/`loadTar` produce and consume —
 * same entry names, same flavour, same gzip rule — and the only way to be sure of the flavour is to
 * use the same writer. Kept at the version PGlite pins for exactly that reason.
 */
declare module "tinytar" {
  /** One entry, in `posixHeader` terms. Everything but `name`/`data` has a documented default. */
  export interface TarFile {
    /** The entry's path, relative to the tarball's root. 100 characters, ustar's limit. */
    name: string;
    /** Permission bits; masked to `0777` on write, so type bits are dropped either way. */
    mode?: number;
    uid?: number;
    gid?: number;
    /** Written from `data.length` regardless, and absent from an `untar` result. */
    size?: number;
    modifyTime?: Date | number;
    /** {@link REGTYPE} or {@link DIRTYPE}; the other POSIX types are not written here. */
    type?: number;
    linkName?: string;
    owner?: string;
    group?: string;
    majorNumber?: number;
    minorNumber?: number;
    prefix?: string;
    accessTime?: Date | number;
    createTime?: Date | number;
    data: Uint8Array;
  }

  /** What `untar` hands back: the parsed header, `modifyTime` as a `Date`, plus the data. */
  export interface UntarredFile extends Omit<TarFile, "modifyTime" | "accessTime" | "createTime" | "data"> {
    modifyTime: Date | null;
    accessTime: Date | null;
    createTime: Date | null;
    isOldGNUFormat: boolean;
    /**
     * A slice of the caller's buffer, so it is backed by an ordinary `ArrayBuffer`. Absent when the
     * caller passed `extractData: false` — the headers alone, which is how an entry LISTING is read.
     */
    data?: Uint8Array<ArrayBuffer>;
  }

  export interface UntarOptions {
    extractData?: boolean;
    checkHeader?: boolean;
    checkChecksum?: boolean;
    checkFileSize?: boolean;
  }

  /** One freshly allocated buffer, so it is backed by an ordinary `ArrayBuffer`. */
  export function tar(files: readonly TarFile[]): Uint8Array<ArrayBuffer>;
  export function untar(buffer: Uint8Array<ArrayBuffer>, options?: UntarOptions): UntarredFile[];

  /** typeflag values. Regular file. */
  export const REGTYPE: number;
  /** typeflag values. Directory. */
  export const DIRTYPE: number;
}
