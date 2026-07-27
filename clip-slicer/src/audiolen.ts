// Audio-file inspection without full decoding: duration from the container
// header, and trailing-silence detection by scanning PCM from the end.
// Supports WAV (RIFF) and AIFF/AIFC; returns null for other formats.

import * as fs from "node:fs/promises";

import decodeAudio from "audio-decode";

interface PcmInfo {
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
  float: boolean;
  littleEndian: boolean;
  dataOffset: number; // absolute file offset of the first PCM byte
  dataBytes: number;
}

/**
 * Position (seconds from file start) of the end of the last audio louder than
 * `thresholdDb` (sample-peak). Scans backwards in 1 s windows, then refines to
 * 100 ms. Returns null when the format is unsupported, 0 when the whole file
 * is below the threshold.
 */
export async function lastNonSilentSeconds(
  filePath: string,
  thresholdDb = -48,
): Promise<number | null> {
  const threshold = Math.pow(10, thresholdDb / 20);
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(1 << 20);
    const { size } = await fh.stat();
    await fh.read(head, 0, head.length, 0);
    const info = wavPcmInfo(head, size) ?? aiffPcmInfo(head);
    if (info === null) {
      // Compressed / unrecognized container: decode fully (strip-silence style).
      return lastNonSilentByDecode(filePath, threshold);
    }

    const frameBytes = info.channels * info.bytesPerSample;
    const totalFrames = Math.floor(info.dataBytes / frameBytes);
    const winFrames = info.sampleRate; // 1 s coarse windows

    for (let end = totalFrames; end > 0; end -= winFrames) {
      const start = Math.max(0, end - winFrames);
      const buf = Buffer.alloc((end - start) * frameBytes);
      await fh.read(buf, 0, buf.length, info.dataOffset + start * frameBytes);
      const hit = lastLoudFrame(buf, info, threshold);
      if (hit >= 0) {
        // Refine within this window to 100 ms.
        const fine = Math.ceil(info.sampleRate / 10);
        const hitEnd = Math.ceil((hit + 1) / fine) * fine;
        return (start + Math.min(hitEnd, end - start)) / info.sampleRate;
      }
    }
    return 0;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/** Full-decode fallback (any format Live plays), scanning channel data backwards. */
async function lastNonSilentByDecode(filePath: string, threshold: number): Promise<number | null> {
  try {
    const decoded = await decodeAudio(await fs.readFile(filePath));
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, c) => decoded.getChannelData(c),
    );
    const frames = decoded.length;
    for (let f = frames - 1; f >= 0; f--) {
      for (const ch of channels) {
        if (Math.abs(ch[f] ?? 0) > threshold) {
          const fine = Math.ceil(decoded.sampleRate / 10); // 100 ms granularity
          return Math.min(frames, Math.ceil((f + 1) / fine) * fine) / decoded.sampleRate;
        }
      }
    }
    return 0;
  } catch {
    return null;
  }
}

/** Index of the last frame in `buf` whose peak exceeds `threshold`, or -1. */
function lastLoudFrame(buf: Buffer, info: PcmInfo, threshold: number): number {
  const frameBytes = info.channels * info.bytesPerSample;
  const frames = Math.floor(buf.length / frameBytes);
  for (let f = frames - 1; f >= 0; f--) {
    for (let c = 0; c < info.channels; c++) {
      const o = f * frameBytes + c * info.bytesPerSample;
      if (Math.abs(readSample(buf, o, info)) > threshold) return f;
    }
  }
  return -1;
}

function readSample(buf: Buffer, o: number, info: PcmInfo): number {
  const { bytesPerSample: n, float, littleEndian: le } = info;
  if (float) {
    return n === 4 ? (le ? buf.readFloatLE(o) : buf.readFloatBE(o))
                   : (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  }
  if (n === 2) return (le ? buf.readInt16LE(o) : buf.readInt16BE(o)) / 32768;
  if (n === 3) {
    const v = le ? buf.readIntLE(o, 3) : buf.readIntBE(o, 3);
    return v / 8388608;
  }
  if (n === 4) return (le ? buf.readInt32LE(o) : buf.readInt32BE(o)) / 2147483648;
  if (n === 1) return (buf[o]! - 128) / 128; // 8-bit WAV is unsigned
  return 0;
}

function wavPcmInfo(buf: Buffer, fileSize: number): PcmInfo | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let info: Partial<PcmInfo> = { littleEndian: true };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") {
      const fmt = buf.readUInt16LE(o + 8);
      info.channels = buf.readUInt16LE(o + 10);
      info.sampleRate = buf.readUInt32LE(o + 12);
      const bits = buf.readUInt16LE(o + 22);
      info.bytesPerSample = Math.ceil(bits / 8);
      info.float = fmt === 3;
      if (fmt !== 1 && fmt !== 3 && fmt !== 0xfffe) return null; // compressed
    } else if (id === "data") {
      info.dataOffset = o + 8;
      info.dataBytes = size === 0 || size === 0xffffffff ? fileSize - (o + 8) : size;
      break;
    }
    o += 8 + size + (size % 2);
  }
  return info.sampleRate && info.channels && info.bytesPerSample && info.dataBytes
    ? (info as PcmInfo)
    : null;
}

function aiffPcmInfo(buf: Buffer): PcmInfo | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "FORM") return null;
  const form = buf.toString("ascii", 8, 12);
  if (form !== "AIFF" && form !== "AIFC") return null;
  let info: Partial<PcmInfo> = { littleEndian: false, float: false };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32BE(o + 4);
    if (id === "COMM") {
      info.channels = buf.readUInt16BE(o + 8);
      const bits = buf.readUInt16BE(o + 14);
      info.bytesPerSample = Math.ceil(bits / 8);
      info.sampleRate = readExtended80(buf, o + 16);
      if (form === "AIFC" && o + 30 <= buf.length) {
        const comp = buf.toString("ascii", o + 26, o + 30);
        if (comp === "sowt") info.littleEndian = true;
        else if (comp !== "NONE") return null; // compressed AIFC
      }
    } else if (id === "SSND") {
      const offset = buf.readUInt32BE(o + 8);
      info.dataOffset = o + 16 + offset;
      info.dataBytes = size - 8 - offset;
      break;
    }
    o += 8 + size + (size % 2);
  }
  return info.sampleRate && info.channels && info.bytesPerSample && info.dataBytes
    ? (info as PcmInfo)
    : null;
}

export async function audioFileDurationSeconds(filePath: string): Promise<number | null> {
  let buf: Buffer;
  try {
    // Headers live in the first chunk list; 1 MB is far more than enough.
    const fh = await fs.open(filePath, "r");
    try {
      const { size } = await fh.stat();
      buf = Buffer.alloc(Math.min(size, 1 << 20));
      await fh.read(buf, 0, buf.length, 0);
      const riff = parseWav(buf, size);
      if (riff !== null) return riff;
      return parseAiff(buf);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function parseWav(buf: Buffer, fileSize: number): number | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let byteRate = 0;
  let dataSize = 0;
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") {
      byteRate = buf.readUInt32LE(o + 16); // avg bytes/sec
    } else if (id === "data") {
      // A streaming writer may leave size 0/0xffffffff; fall back to file size.
      dataSize = size === 0 || size === 0xffffffff ? fileSize - (o + 8) : size;
      break; // data is usually last; fmt precedes it per spec
    }
    o += 8 + size + (size % 2);
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
}

function parseAiff(buf: Buffer): number | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "FORM") return null;
  const form = buf.toString("ascii", 8, 12);
  if (form !== "AIFF" && form !== "AIFC") return null;
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32BE(o + 4);
    if (id === "COMM" && o + 8 + 18 <= buf.length) {
      const frames = buf.readUInt32BE(o + 10);
      const rate = readExtended80(buf, o + 16);
      return rate > 0 ? frames / rate : null;
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

// 80-bit IEEE 754 extended float (AIFF sample rate field).
function readExtended80(buf: Buffer, o: number): number {
  const sign = buf[o]! & 0x80 ? -1 : 1;
  const exponent = ((buf[o]! & 0x7f) << 8) | buf[o + 1]!;
  const hi = buf.readUInt32BE(o + 2);
  const lo = buf.readUInt32BE(o + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}
