const PACKED_PROTECTED_PREFIX_BYTES = 14;
const UINT32_RANGE = 0x100000000;
const randomScratch = new Uint32Array(1);

function randomUint32() {
  crypto.getRandomValues(randomScratch);
  return randomScratch[0] >>> 0;
}

function randomInt(max) {
  if (!(max > 0)) throw new Error("invalid randomInt max");
  const limit = 0x100000000 - (0x100000000 % max);
  let value = randomUint32();
  while (value >= limit) value = randomUint32();
  return value % max;
}

function pickPaddingThreshold(pMin, pMax) {
  let min = Number(pMin || 0);
  let max = Number(pMax || 0);
  if (min < 0) min = 0;
  if (max < min) max = min;
  if (min > 100) min = 100;
  if (max > 100) max = 100;
  const minThreshold = Math.floor((min * UINT32_RANGE) / 100);
  const maxThreshold = Math.floor((max * UINT32_RANGE) / 100);
  if (maxThreshold <= minThreshold) return minThreshold;
  return minThreshold + Math.floor((randomUint32() / UINT32_RANGE) * (maxThreshold - minThreshold));
}

function shouldPad(threshold) {
  if (threshold <= 0) return false;
  if (threshold >= UINT32_RANGE) return true;
  return randomUint32() < threshold;
}

export class PackedDownlinkEncoder {
  constructor(table, pMin = 0, pMax = 0) {
    if (!table?.encodeGroup || !table?.paddingPool?.length) {
      throw new Error("invalid packed downlink table");
    }
    this.table = table;
    this.padMarker = table.padMarker;
    this.padPool = Array.from(table.paddingPool).filter((b) => b !== this.padMarker);
    if (this.padPool.length === 0) this.padPool = [this.padMarker];
    this.paddingThreshold = pickPaddingThreshold(pMin, pMax);
    this.paddingEnabled = this.paddingThreshold > 0;
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  maybeAddPadding(out) {
    if (this.paddingEnabled && shouldPad(this.paddingThreshold)) out.push(this.getPaddingByte());
  }

  appendGroup(out, group) {
    this.maybeAddPadding(out);
    out.push(this.table.encodeGroup(group & 0x3f));
  }

  appendForcedPadding(out) {
    out.push(this.getPaddingByte());
  }

  nextProtectedPrefixGap() {
    return 1 + randomInt(2);
  }

  writeProtectedPrefix(out, bytes) {
    if (bytes.length === 0) return 0;
    const limit = Math.min(bytes.length, PACKED_PROTECTED_PREFIX_BYTES);
    for (let i = 0; i < 1 + randomInt(2); i += 1) this.appendForcedPadding(out);

    let gap = this.nextProtectedPrefixGap();
    let effective = 0;
    for (let i = 0; i < limit; i += 1) {
      this.bitBuf = (this.bitBuf << 8) | bytes[i];
      this.bitCount += 8;
      while (this.bitCount >= 6) {
        this.bitCount -= 6;
        const group = (this.bitBuf >> this.bitCount) & 0x3f;
        if (this.bitCount === 0) {
          this.bitBuf = 0;
        } else {
          this.bitBuf &= (1 << this.bitCount) - 1;
        }
        this.appendGroup(out, group);
      }
      effective += 1;
      if (effective >= gap) {
        this.appendForcedPadding(out);
        effective = 0;
        gap = this.nextProtectedPrefixGap();
      }
    }
    return limit;
  }

  encode(bytes) {
    if (!bytes?.length) return new Uint8Array();
    const out = [];
    let index = this.writeProtectedPrefix(out, bytes);
    const n = bytes.length;

    while (this.bitCount > 0 && index < n) {
      this.maybeAddPadding(out);
      this.bitBuf = (this.bitBuf << 8) | bytes[index];
      index += 1;
      this.bitCount += 8;
      while (this.bitCount >= 6) {
        this.bitCount -= 6;
        const group = (this.bitBuf >> this.bitCount) & 0x3f;
        if (this.bitCount === 0) {
          this.bitBuf = 0;
        } else {
          this.bitBuf &= (1 << this.bitCount) - 1;
        }
        this.appendGroup(out, group);
      }
    }

    while (index + 11 < n) {
      for (let batch = 0; batch < 4; batch += 1) {
        const b1 = bytes[index];
        const b2 = bytes[index + 1];
        const b3 = bytes[index + 2];
        index += 3;
        this.appendGroup(out, (b1 >> 2) & 0x3f);
        this.appendGroup(out, ((b1 & 0x03) << 4) | ((b2 >> 4) & 0x0f));
        this.appendGroup(out, ((b2 & 0x0f) << 2) | ((b3 >> 6) & 0x03));
        this.appendGroup(out, b3 & 0x3f);
      }
    }

    while (index + 2 < n) {
      const b1 = bytes[index];
      const b2 = bytes[index + 1];
      const b3 = bytes[index + 2];
      index += 3;
      this.appendGroup(out, (b1 >> 2) & 0x3f);
      this.appendGroup(out, ((b1 & 0x03) << 4) | ((b2 >> 4) & 0x0f));
      this.appendGroup(out, ((b2 & 0x0f) << 2) | ((b3 >> 6) & 0x03));
      this.appendGroup(out, b3 & 0x3f);
    }

    while (index < n) {
      this.bitBuf = (this.bitBuf << 8) | bytes[index];
      this.bitCount += 8;
      index += 1;
      while (this.bitCount >= 6) {
        this.bitCount -= 6;
        const group = (this.bitBuf >> this.bitCount) & 0x3f;
        if (this.bitCount === 0) {
          this.bitBuf = 0;
        } else {
          this.bitBuf &= (1 << this.bitCount) - 1;
        }
        this.appendGroup(out, group);
      }
    }

    if (this.bitCount > 0) {
      const group = (this.bitBuf << (6 - this.bitCount)) & 0x3f;
      this.bitBuf = 0;
      this.bitCount = 0;
      this.appendGroup(out, group);
      out.push(this.padMarker);
    }

    this.maybeAddPadding(out);
    return Uint8Array.from(out);
  }

  flush() {
    const out = [];
    if (this.bitCount > 0) {
      const group = (this.bitBuf << (6 - this.bitCount)) & 0x3f;
      this.bitBuf = 0;
      this.bitCount = 0;
      out.push(this.table.encodeGroup(group));
      out.push(this.padMarker);
    }
    this.maybeAddPadding(out);
    return Uint8Array.from(out);
  }

  getPaddingByte() {
    return this.padPool[randomInt(this.padPool.length)];
  }
}
