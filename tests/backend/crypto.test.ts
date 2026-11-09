import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileHeader,
  hashPlain,
  newRecordingKey,
  plainReadStream,
  sealFile,
  sealFrame,
} from "../../src/backend/crypto";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rec-crypto-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readAll(file: string, key: Buffer | null): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of plainReadStream(file, key)) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe("recording encryption", () => {
  it("reads back frames written one at a time", async () => {
    const key = newRecordingKey();
    const file = path.join(dir, "a.cast");
    await fs.writeFile(
      file,
      Buffer.concat([fileHeader(), sealFrame(key, Buffer.from("one "))]),
    );
    await fs.appendFile(file, sealFrame(key, Buffer.from("two")));
    expect(await readAll(file, key)).toBe("one two");
    expect(await hashPlain(file, key)).toBe(
      createHash("sha256").update("one two").digest("hex"),
    );
  });

  it("keeps everything before a cut off last frame", async () => {
    const key = newRecordingKey();
    const file = path.join(dir, "b.cast");
    const tail = sealFrame(key, Buffer.from("lost"));
    await fs.writeFile(
      file,
      Buffer.concat([
        fileHeader(),
        sealFrame(key, Buffer.from("kept")),
        tail.subarray(0, tail.length - 3),
      ]),
    );
    expect(await readAll(file, key)).toBe("kept");
  });

  it("fails with the wrong key", async () => {
    const file = path.join(dir, "c.cast");
    await fs.writeFile(
      file,
      Buffer.concat([
        fileHeader(),
        sealFrame(newRecordingKey(), Buffer.from("x")),
      ]),
    );
    await expect(readAll(file, newRecordingKey())).rejects.toThrow();
  });

  it("seals a finished file in place and hashes the plain bytes", async () => {
    const key = newRecordingKey();
    const file = path.join(dir, "d.guac");
    const body = "4.size,1.0;".repeat(1000);
    await fs.writeFile(file, body);
    const sha = await sealFile(file, key);
    expect(sha).toBe(createHash("sha256").update(body).digest("hex"));
    expect((await fs.readFile(file, "utf8")).includes("size")).toBe(false);
    expect(await readAll(file, key)).toBe(body);
  });

  it("only hashes when there is no key", async () => {
    const file = path.join(dir, "e.guac");
    await fs.writeFile(file, "plain");
    expect(await sealFile(file, null)).toBe(
      createHash("sha256").update("plain").digest("hex"),
    );
    expect(await fs.readFile(file, "utf8")).toBe("plain");
  });
});
