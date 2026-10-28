// Minimal PCM decoder for WAV (RIFF) and AIFF/AIFC files — needed because
// Live's renderPreFxAudio outputs AIFF (despite the docs), and the
// `audio-decode` package has no AIFF decoder. Returns null for formats it
// doesn't understand (caller falls back to audio-decode).

interface Decoded {
  channels: Float32Array[];
  sampleRate: number;
}

export function decodePcm(buf: Buffer): Decoded | null {
  return decodeWav(buf) ?? decodeAiff(buf);
}

interface PcmLayout {
  sampleRate: number;
  numChannels: number;
  bytesPerSample: number;
  float: boolean;
  littleEndian: boolean;
  dataOffset: number;
  dataBytes: number;
}

function readFrames(buf: Buffer, l: PcmLayout): Decoded {
  const frameBytes = l.numChannels * l.bytesPerSample;
  const frames = Math.floor(Math.min(l.dataBytes, buf.length - l.dataOffset) / frameBytes);
  const channels = Array.from({ length: l.numChannels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const base = l.dataOffset + f * frameBytes;
    for (let c = 0; c < l.numChannels; c++) {
      channels[c]![f] = readSample(buf, base + c * l.bytesPerSample, l);
    }
  }
  return { channels, sampleRate: l.sampleRate };
}

function readSample(buf: Buffer, o: number, l: PcmLayout): number {
  const { bytesPerSample: n, float, littleEndian: le } = l;
  if (float) {
    return n === 8 ? (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o))
                   : (le ? buf.readFloatLE(o) : buf.readFloatBE(o));
  }
  if (n === 2) return (le ? buf.readInt16LE(o) : buf.readInt16BE(o)) / 32768;
  if (n === 3) return (le ? buf.readIntLE(o, 3) : buf.readIntBE(o, 3)) / 8388608;
  if (n === 4) return (le ? buf.readInt32LE(o) : buf.readInt32BE(o)) / 2147483648;
  if (n === 1) return (buf[o]! - 128) / 128; // 8-bit WAV is unsigned
  return 0;
}

function decodeWav(buf: Buffer): Decoded | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  const l: Partial<PcmLayout> = { littleEndian: true };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") {
      const fmt = buf.readUInt16LE(o + 8);
      l.numChannels = buf.readUInt16LE(o + 10);
      l.sampleRate = buf.readUInt32LE(o + 12);
      const bits = buf.readUInt16LE(o + 22);
      l.bytesPerSample = Math.ceil(bits / 8);
      l.float = fmt === 3;
      if (fmt !== 1 && fmt !== 3 && fmt !== 0xfffe) return null; // compressed
    } else if (id === "data") {
      l.dataOffset = o + 8;
      l.dataBytes = size === 0 || size === 0xffffffff ? buf.length - (o + 8) : size;
      break;
    }
    o += 8 + size + (size % 2);
  }
  return l.sampleRate && l.numChannels && l.bytesPerSample && l.dataBytes
    ? readFrames(buf, l as PcmLayout)
    : null;
}

function decodeAiff(buf: Buffer): Decoded | null {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "FORM") return null;
  const form = buf.toString("ascii", 8, 12);
  if (form !== "AIFF" && form !== "AIFC") return null;
  const l: Partial<PcmLayout> = { littleEndian: false, float: false };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32BE(o + 4);
    if (id === "COMM") {
      l.numChannels = buf.readUInt16BE(o + 8);
      const bits = buf.readUInt16BE(o + 14);
      l.bytesPerSample = Math.ceil(bits / 8);
      l.sampleRate = readExtended80(buf, o + 16);
      if (form === "AIFC" && o + 30 <= buf.length) {
        const comp = buf.toString("ascii", o + 26, o + 30);
        if (comp === "sowt") l.littleEndian = true;
        else if (comp === "fl32" || comp === "FL32") l.float = true;
        else if (comp === "fl64") { l.float = true; l.bytesPerSample = 8; }
        else if (comp !== "NONE") return null; // compressed AIFC
      }
    } else if (id === "SSND") {
      const offset = buf.readUInt32BE(o + 8);
      l.dataOffset = o + 16 + offset;
      l.dataBytes = size - 8 - offset;
      break;
    }
    o += 8 + size + (size % 2);
  }
  return l.sampleRate && l.numChannels && l.bytesPerSample && l.dataBytes
    ? readFrames(buf, l as PcmLayout)
    : null;
}

// 80-bit IEEE 754 extended float (AIFF sample-rate field).
function readExtended80(buf: Buffer, o: number): number {
  const sign = buf[o]! & 0x80 ? -1 : 1;
  const exponent = ((buf[o]! & 0x7f) << 8) | buf[o + 1]!;
  const hi = buf.readUInt32BE(o + 2);
  const lo = buf.readUInt32BE(o + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}
