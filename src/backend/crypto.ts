import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Encrypted recordings are a run of frames, one per write:
 * 4 byte big endian length, then a 12 byte IV, a 16 byte GCM tag and the
 * ciphertext. Each frame is sealed on its own, so a live session appends one
 * frame per flush without reading the file back, and a cut off last frame
 * only loses that frame.
 */
const MAGIC = Buffer.from("TMXREC1\n");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FRAME = 64 * 1024 * 1024;
const FILE_CHUNK = 1024 * 1024;

export function newRecordingKey(): Buffer {
  return crypto.randomBytes(32);
}

export function fileHeader(): Buffer {
  return Buffer.from(MAGIC);
}

export function sealFrame(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(IV_BYTES + TAG_BYTES + body.length);
  return Buffer.concat([length, iv, cipher.getAuthTag(), body]);
}

function openFrame(key: Buffer, frame: Buffer): Buffer {
  const iv = frame.subarray(0, IV_BYTES);
  const tag = frame.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(frame.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
}

/** Turns an encrypted recording stream back into the plain bytes. */
export function decryptStream(key: Buffer): Transform {
  let pending = Buffer.alloc(0);
  let headerChecked = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = Buffer.concat([pending, chunk]);
      try {
        if (!headerChecked) {
          if (pending.length < MAGIC.length) return done();
          if (!pending.subarray(0, MAGIC.length).equals(MAGIC)) {
            throw new Error("Not an encrypted recording");
          }
          pending = pending.subarray(MAGIC.length);
          headerChecked = true;
        }
        while (pending.length >= 4) {
          const size = pending.readUInt32BE(0);
          if (size < IV_BYTES + TAG_BYTES || size > MAX_FRAME) {
            throw new Error("Recording frame is damaged");
          }
          if (pending.length < 4 + size) break;
          this.push(openFrame(key, pending.subarray(4, 4 + size)));
          pending = pending.subarray(4 + size);
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done) {
      // A cut off last frame is what a crash mid write leaves; keep the rest.
      done();
    },
  });
}

/** The plain bytes of a recording file, decrypting when it has a key. */
export function plainReadStream(file: string, key: Buffer | null): Readable {
  const raw = fs.createReadStream(file);
  if (!key) return raw;
  const out = decryptStream(key);
  raw.on("error", (error) => out.destroy(error));
  return raw.pipe(out);
}

/** SHA-256 of a recording's plain bytes. */
export async function hashPlain(
  file: string,
  key: Buffer | null,
): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(plainReadStream(file, key), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
  });
  return hash.digest("hex");
}

/**
 * Encrypts a finished file in place (written next to it, then renamed) and
 * hashes its plain bytes on the way. With no key it only hashes.
 */
export async function sealFile(
  file: string,
  key: Buffer | null,
): Promise<string> {
  const hash = crypto.createHash("sha256");
  if (!key) {
    await pipeline(
      fs.createReadStream(file, { highWaterMark: FILE_CHUNK }),
      async function* (source) {
        for await (const chunk of source) hash.update(chunk as Buffer);
      },
    );
    return hash.digest("hex");
  }
  const target = `${file}.sealing`;
  try {
    await pipeline(
      fs.createReadStream(file, { highWaterMark: FILE_CHUNK }),
      async function* (source) {
        yield fileHeader();
        for await (const chunk of source) {
          hash.update(chunk as Buffer);
          yield sealFrame(key, chunk as Buffer);
        }
      },
      fs.createWriteStream(target, { mode: 0o600 }),
    );
    await fsp.rename(target, file);
  } catch (error) {
    await fsp.unlink(target).catch(() => {});
    throw error;
  }
  return hash.digest("hex");
}
