import { GoMathRand } from "./go-rand.mjs";

const ASCII_TOKEN_ASCII = "ascii";
const ASCII_TOKEN_ENTROPY = "entropy";
const hintPositions = buildHintPositions();
let allGridsCache;
const tableCache = new Map();

function packHintsToKey(a0, a1, a2, a3) {
  if (a0 > a1) [a0, a1] = [a1, a0];
  if (a2 > a3) [a2, a3] = [a3, a2];
  if (a0 > a2) [a0, a2] = [a2, a0];
  if (a1 > a3) [a1, a3] = [a3, a1];
  if (a1 > a2) [a1, a2] = [a2, a1];
  return (((a0 << 24) | (a1 << 16) | (a2 << 8) | a3) >>> 0);
}

function buildHintPositions() {
  const positions = [];
  for (let a = 0; a < 13; a += 1) {
    for (let b = a + 1; b < 14; b += 1) {
      for (let c = b + 1; c < 15; c += 1) {
        for (let d = c + 1; d < 16; d += 1) {
          positions.push(Uint8Array.from([a, b, c, d]));
        }
      }
    }
  }
  return positions;
}

function generateAllGrids() {
  if (allGridsCache) return allGridsCache;
  const grids = [];
  const grid = new Uint8Array(16);
  const rowMasks = new Uint8Array(4);
  const colMasks = new Uint8Array(4);
  const boxMasks = new Uint8Array(4);

  function backtrack(idx) {
    if (idx === 16) {
      grids.push(Uint8Array.from(grid));
      return;
    }
    const row = (idx / 4) | 0;
    const col = idx % 4;
    const box = ((row >> 1) << 1) | (col >> 1);
    const used = rowMasks[row] | colMasks[col] | boxMasks[box];
    for (let num = 1; num <= 4; num += 1) {
      const bit = 1 << num;
      if (used & bit) continue;
      grid[idx] = num;
      rowMasks[row] |= bit;
      colMasks[col] |= bit;
      boxMasks[box] |= bit;
      backtrack(idx + 1);
      rowMasks[row] ^= bit;
      colMasks[col] ^= bit;
      boxMasks[box] ^= bit;
      grid[idx] = 0;
    }
  }

  backtrack(0);
  allGridsCache = grids;
  return grids;
}

function buildHintByteLookup(layout) {
  const lookup = new Uint8Array(256);
  for (let b = 0; b < 256; b += 1) {
    lookup[b] = layout.isHint(b) ? 1 : 0;
  }
  return lookup;
}

function hintKeyForGrid(layout, grid, positions) {
  const p0 = positions[0];
  const p1 = positions[1];
  const p2 = positions[2];
  const p3 = positions[3];
  return packHintsToKey(
    layout.encodeHint(grid[p0] - 1, p0),
    layout.encodeHint(grid[p1] - 1, p1),
    layout.encodeHint(grid[p2] - 1, p2),
    layout.encodeHint(grid[p3] - 1, p3),
  );
}

function buildHintsForGrid(layout, grid, positions) {
  const hints = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const pos = positions[i];
    hints[i] = layout.encodeHint(grid[pos] - 1, pos);
  }
  return hints;
}

function normalizeAsciiModeToken(token) {
  switch (String(token || "").trim().toLowerCase()) {
    case "ascii":
    case "prefer_ascii":
      return ASCII_TOKEN_ASCII;
    case "":
    case "entropy":
    case "prefer_entropy":
      return ASCII_TOKEN_ENTROPY;
    default:
      return null;
  }
}

function singleDirectionPreference(token) {
  return token === ASCII_TOKEN_ASCII ? "prefer_ascii" : "prefer_entropy";
}

function parseAsciiMode(mode) {
  const raw = String(mode || "").trim().toLowerCase();
  if (!raw || raw === "entropy" || raw === "prefer_entropy") {
    return { uplink: ASCII_TOKEN_ENTROPY, downlink: ASCII_TOKEN_ENTROPY };
  }
  if (raw === "ascii" || raw === "prefer_ascii") {
    return { uplink: ASCII_TOKEN_ASCII, downlink: ASCII_TOKEN_ASCII };
  }
  if (!raw.startsWith("up_")) {
    throw new Error(`invalid ascii mode: ${mode}`);
  }
  const parts = raw.slice(3).split("_down_");
  if (parts.length !== 2) throw new Error(`invalid ascii mode: ${mode}`);
  const uplink = normalizeAsciiModeToken(parts[0]);
  const downlink = normalizeAsciiModeToken(parts[1]);
  if (!uplink || !downlink) throw new Error(`invalid ascii mode: ${mode}`);
  return { uplink, downlink };
}

export function normalizeAsciiMode(mode) {
  const parsed = parseAsciiMode(mode);
  if (parsed.uplink === ASCII_TOKEN_ASCII && parsed.downlink === ASCII_TOKEN_ASCII) return "prefer_ascii";
  if (parsed.uplink === ASCII_TOKEN_ENTROPY && parsed.downlink === ASCII_TOKEN_ENTROPY) return "prefer_entropy";
  return `up_${parsed.uplink}_down_${parsed.downlink}`;
}

function customPatternForToken(token, customPattern) {
  return token === ASCII_TOKEN_ENTROPY ? String(customPattern || "").trim() : "";
}

function resolveLayout(mode, customPattern) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "ascii" || normalized === "prefer_ascii") {
    const paddingPool = [];
    for (let i = 0; i < 32; i += 1) paddingPool.push(0x20 + i);
    return {
      name: "ascii",
      padMarker: 0x3f,
      paddingPool: Uint8Array.from(paddingPool),
      isHint(b) {
        return (b & 0x40) === 0x40 || b === 0x0a;
      },
      encodeHint(val, pos) {
        const b = 0x40 | ((val & 0x03) << 4) | (pos & 0x0f);
        return b === 0x7f ? 0x0a : b;
      },
      encodeGroup(group) {
        const b = 0x40 | (group & 0x3f);
        return b === 0x7f ? 0x0a : b;
      },
      decodeGroup(b) {
        if (b === 0x0a) return { group: 0x3f, ok: true };
        if ((b & 0x40) === 0) return { group: 0, ok: false };
        return { group: b & 0x3f, ok: true };
      },
    };
  }

  if (String(customPattern || "").trim()) {
    return buildCustomLayout(customPattern);
  }

  return {
    name: "entropy",
    padMarker: 0x80,
    paddingPool: Uint8Array.from([0x80, 0x10, 0x81, 0x11, 0x82, 0x12, 0x83, 0x13, 0x84, 0x14, 0x85, 0x15, 0x86, 0x16, 0x87, 0x17]),
    isHint(b) {
      return (b & 0x90) === 0;
    },
    encodeHint(val, pos) {
      return ((val & 0x03) << 5) | (pos & 0x0f);
    },
    encodeGroup(group) {
      const v = group & 0x3f;
      return ((v & 0x30) << 1) | (v & 0x0f);
    },
    decodeGroup(b) {
      if ((b & 0x90) !== 0) return { group: 0, ok: false };
      return { group: (((b >> 1) & 0x30) | (b & 0x0f)) & 0x3f, ok: true };
    },
  };
}

function buildCustomLayout(pattern) {
  const cleaned = String(pattern).trim().replaceAll(" ", "").toLowerCase();
  if (cleaned.length !== 8) throw new Error("custom table must have 8 symbols");
  const xBits = [];
  const pBits = [];
  const vBits = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const bit = 7 - i;
    const ch = cleaned[i];
    if (ch === "x") xBits.push(bit);
    else if (ch === "p") pBits.push(bit);
    else if (ch === "v") vBits.push(bit);
    else throw new Error(`invalid custom table char: ${ch}`);
  }
  if (xBits.length !== 2 || pBits.length !== 2 || vBits.length !== 4) {
    throw new Error("custom table must contain exactly 2 x, 2 p, 4 v");
  }
  const xMask = xBits.reduce((acc, bit) => acc | (1 << bit), 0);
  const encodeBits = (val, pos, dropX = -1) => {
    let out = xMask;
    if (dropX >= 0) out &= ~(1 << xBits[dropX]);
    if (val & 0x02) out |= (1 << pBits[0]);
    if (val & 0x01) out |= (1 << pBits[1]);
    for (let i = 0; i < 4; i += 1) {
      if ((pos >> (3 - i)) & 1) out |= (1 << vBits[i]);
    }
    return out;
  };
  const paddingPool = [];
  const seen = new Set();
  for (let drop = 0; drop < xBits.length; drop += 1) {
    for (let val = 0; val < 4; val += 1) {
      for (let pos = 0; pos < 16; pos += 1) {
        const b = encodeBits(val, pos, drop);
        const ones = b.toString(2).replaceAll("0", "").length;
        if (ones >= 5 && !seen.has(b)) {
          seen.add(b);
          paddingPool.push(b);
        }
      }
    }
  }
  paddingPool.sort((a, b) => a - b);
  return {
    name: `custom(${cleaned})`,
    padMarker: paddingPool[0],
    paddingPool: Uint8Array.from(paddingPool),
    isHint(b) {
      return (b & xMask) === xMask;
    },
    encodeHint(val, pos) {
      return encodeBits(val, pos, -1);
    },
    encodeGroup(group) {
      return encodeBits((group >> 4) & 0x03, group & 0x0f, -1);
    },
    decodeGroup(b) {
      if ((b & xMask) !== xMask) return { group: 0, ok: false };
      let val = 0;
      let pos = 0;
      if (b & (1 << pBits[0])) val |= 0x02;
      if (b & (1 << pBits[1])) val |= 0x01;
      for (let i = 0; i < 4; i += 1) {
        if (b & (1 << vBits[i])) pos |= (1 << (3 - i));
      }
      return { group: ((val << 4) | pos) & 0x3f, ok: true };
    },
  };
}

async function sha256Bytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function seedFromKey(key) {
  const digest = await sha256Bytes(new TextEncoder().encode(key));
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(digest[i]);
  return BigInt.asIntN(64, value);
}

async function tableHintFingerprint(key, mode, uplinkPattern, downlinkPattern) {
  const raw = [ "sudoku-table-hint", key, mode, String(uplinkPattern || "").trim().toLowerCase(), String(downlinkPattern || "").trim().toLowerCase() ].join("\x00");
  const digest = await sha256Bytes(new TextEncoder().encode(raw));
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

async function buildSingleDirectionTable(key, mode = "prefer_entropy", customPattern = "") {
  const layout = resolveLayout(mode, customPattern);
  const grids = generateAllGrids();
  const shuffled = grids.slice();
  const rng = new GoMathRand(await seedFromKey(key));
  rng.shuffle(shuffled.length, (i, j) => {
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  });

  const encodeTable = Array.from({ length: 256 }, () => []);
  const encodeHints = new Uint8Array(256 * 4);
  const decodeMap = new Map();
  const hintCounts = new Map();

  for (const positions of hintPositions) {
    hintCounts.clear();
    for (const grid of grids) {
      const key = hintKeyForGrid(layout, grid, positions);
      hintCounts.set(key, (hintCounts.get(key) || 0) + 1);
    }

    for (let byteVal = 0; byteVal < 256; byteVal += 1) {
      const targetGrid = shuffled[byteVal];
      const key = hintKeyForGrid(layout, targetGrid, positions);
      if (hintCounts.get(key) !== 1) continue;
      if (encodeTable[byteVal].length === 0) {
        const hints = buildHintsForGrid(layout, targetGrid, positions);
        encodeTable[byteVal].push(hints);
        encodeHints.set(hints, byteVal * 4);
      }
      decodeMap.set(key, byteVal);
    }
  }

  for (let byteVal = 0; byteVal < 256; byteVal += 1) {
    if (encodeTable[byteVal].length === 0) {
      throw new Error(`empty Sudoku encode table for byte ${byteVal}`);
    }
  }

  return {
    encodeTable,
    encodeHints,
    decodeMap,
    paddingPool: layout.paddingPool,
    padMarker: layout.padMarker,
    isHint: layout.isHint,
    isHintByte: buildHintByteLookup(layout),
    encodeGroup: layout.encodeGroup,
    decodeGroup: layout.decodeGroup,
    isASCII: layout.name === "ascii",
    hint: 0,
    opposite: null,
  };
}

export async function buildSudokuTable(key, mode = "prefer_entropy", customPattern = "") {
  const normalizedMode = normalizeAsciiMode(mode);
  const cacheKey = JSON.stringify([key, normalizedMode, customPattern]);
  if (tableCache.has(cacheKey)) return tableCache.get(cacheKey);

  const promise = (async () => {
    const asciiMode = parseAsciiMode(normalizedMode);
    const uplinkPattern = customPatternForToken(asciiMode.uplink, customPattern);
    const downlinkPattern = customPatternForToken(asciiMode.downlink, customPattern);
    const hint = await tableHintFingerprint(key, normalizedMode, uplinkPattern, downlinkPattern);
    const uplink = await buildSingleDirectionTable(key, singleDirectionPreference(asciiMode.uplink), uplinkPattern);
    uplink.hint = hint;
    if (asciiMode.uplink === asciiMode.downlink) {
      uplink.opposite = uplink;
      return uplink;
    }
    const downlink = await buildSingleDirectionTable(key, singleDirectionPreference(asciiMode.downlink), downlinkPattern);
    downlink.hint = hint;
    uplink.opposite = downlink;
    downlink.opposite = uplink;
    return uplink;
  })();

  tableCache.set(cacheKey, promise);
  return promise;
}

export function oppositeDirection(table) {
  return table?.opposite || table;
}

export function decodeSudokuBytes(table, state, chunk) {
  const out = new Uint8Array((chunk.length >> 2) + 1);
  let outIndex = 0;
  let hintCount = state.hintCount | 0;
  let h0 = state.h0 | 0;
  let h1 = state.h1 | 0;
  let h2 = state.h2 | 0;
  const isHintByte = table.isHintByte;
  const decodeMap = table.decodeMap;
  for (let i = 0, n = chunk.length; i < n; i += 1) {
    const b = chunk[i];
    if (isHintByte ? isHintByte[b] === 0 : !table.isHint(b)) continue;
    if (hintCount === 0) {
      h0 = b;
      hintCount = 1;
      continue;
    }
    if (hintCount === 1) {
      h1 = b;
      hintCount = 2;
      continue;
    }
    if (hintCount === 2) {
      h2 = b;
      hintCount = 3;
      continue;
    }
    if (hintCount === 3) {
      const key = packHintsToKey(h0, h1, h2, b);
      const value = decodeMap.get(key);
      if (value === undefined) {
        throw new Error("INVALID_SUDOKU_MAP_MISS");
      }
      out[outIndex] = value;
      outIndex += 1;
      hintCount = 0;
    }
  }
  state.hintCount = hintCount;
  state.h0 = h0;
  state.h1 = h1;
  state.h2 = h2;
  return outIndex === out.length ? out : out.subarray(0, outIndex);
}

export function encodeSudokuBytes(table, bytes) {
  const out = new Uint8Array(bytes.length * 4);
  let offset = 0;
  const encodeHints = table.encodeHints;
  if (encodeHints) {
    for (let i = 0, n = bytes.length; i < n; i += 1) {
      const hintOffset = bytes[i] << 2;
      out[offset] = encodeHints[hintOffset];
      out[offset + 1] = encodeHints[hintOffset + 1];
      out[offset + 2] = encodeHints[hintOffset + 2];
      out[offset + 3] = encodeHints[hintOffset + 3];
      offset += 4;
    }
    return out;
  }
  for (let i = 0, n = bytes.length; i < n; i += 1) {
    const hints = table.encodeTable[bytes[i]][0];
    out[offset] = hints[0];
    out[offset + 1] = hints[1];
    out[offset + 2] = hints[2];
    out[offset + 3] = hints[3];
    offset += 4;
  }
  return out;
}

export function newSudokuDecodeState() {
  return { hintCount: 0, h0: 0, h1: 0, h2: 0 };
}
