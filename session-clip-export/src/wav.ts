// Minimal 24-bit PCM WAV writer + peak normalization. Dependency-free so the
// whole extension stays a single self-contained bundle.

/** Scale all channels so the loudest sample peaks at `targetDb` dBFS (default -1). */
export function normalize(channels: Float32Array[], targetDb = -1): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i] ?? 0);
      if (a > peak) peak = a;
    }
  }
  if (peak === 0) return 0; // silence: leave untouched
  const gain = Math.pow(10, targetDb / 20) / peak;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      ch[i] = (ch[i] ?? 0) * gain;
    }
  }
  return 20 * Math.log10(gain);
}

/** Interleave float channels and encode as a 24-bit PCM RIFF/WAVE buffer. */
export function encodeWav24(channels: Float32Array[], sampleRate: number): Buffer {
  const numChannels = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 3;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);                    // fmt chunk size
  buf.writeUInt16LE(1, 20);                     // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(24, 34);                    // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  let o = 44;
  const max = 8388607; // 2^23 - 1
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      const s = Math.round(v < 0 ? v * 8388608 : v * max);
      buf.writeUIntLE(s & 0xffffff, o, 3);
      o += 3;
    }
  }
  return buf;
}
