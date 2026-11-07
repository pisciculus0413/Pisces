import * as fs from "node:fs/promises";

async function write(path: string, bytes: Uint8Array, flag: "w" | "a"): Promise<void> {
  const file = await sessionStoreIo.open(path, flag);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
      if (bytesWritten === 0) throw new Error("File write made no progress");
      offset += bytesWritten;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

export const sessionStoreIo = {
  open: fs.open,
  mkdir: fs.mkdir,
  lstat: fs.lstat,
  readdir: fs.readdir,
  readFile: fs.readFile,
  rename: fs.rename,
  truncate: fs.truncate,
  rm: fs.rm,
  unlink: fs.unlink,
  writeSynced: (path: string, bytes: Uint8Array) => write(path, bytes, "w"),
  appendSynced: (path: string, bytes: Uint8Array) => write(path, bytes, "a"),
  async syncDirectory(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
    try {
      const directory = await sessionStoreIo.open(path, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform === "win32" && ["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(code ?? ""))
        return;
      throw error;
    }
  },
};
