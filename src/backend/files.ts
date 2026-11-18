import fs from "node:fs/promises";
import path from "node:path";

function isInside(file: string, dir: string): boolean {
  return path.resolve(file).startsWith(`${path.resolve(dir)}${path.sep}`);
}

/**
 * Moves a finished recording someone else wrote (guacd's, in remote
 * desktop's recordings folder) under this plugin's data folder, which is the
 * only place playback and retention read from. Returns where it ended up;
 * a file that is not there is left alone.
 */
export async function adoptRecordingFile(
  source: string,
  dataDir: string,
): Promise<string> {
  if (isInside(source, dataDir)) return source;
  const target = path.join(
    dataDir,
    "session_recordings",
    path.basename(path.dirname(source)),
    path.basename(source),
  );
  try {
    await fs.access(source);
  } catch {
    return source;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
  return target;
}

function safeName(name: string, fallback: string): string {
  return name && name !== "." && name !== ".." ? name : fallback;
}

/**
 * Copies a finished recording another plugin wrote into this plugin's data
 * folder through the caller's reader, for when this plugin can't open the
 * caller's files. Never overwrites a file already there.
 */
export async function copyRecordingFrom(
  read: (offset: number) => Promise<Uint8Array | null>,
  source: string,
  dataDir: string,
): Promise<string> {
  const target = path.join(
    dataDir,
    "session_recordings",
    safeName(path.basename(path.dirname(source)), "remote"),
    safeName(path.basename(source), `recording-${Date.now()}`),
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  const file = await fs.open(target, "wx");
  try {
    let offset = 0;
    for (;;) {
      const chunk = await read(offset);
      if (!chunk || chunk.byteLength === 0) break;
      await file.write(chunk);
      offset += chunk.byteLength;
    }
  } catch (error) {
    await file.close();
    await fs.unlink(target).catch(() => {});
    throw error;
  }
  await file.close();
  return target;
}
