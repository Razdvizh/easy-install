const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const hmacKeyCache = new WeakMap();

export class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.head = 0;
    this.headOffset = 0;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  compact() {
    if (this.head > 32 && this.head * 2 > this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
  }

  peek(size) {
    if (this.length < size) return null;
    if (size === 0) return new Uint8Array();
    const first = this.chunks[this.head];
    const firstAvailable = first ? first.length - this.headOffset : 0;
    if (firstAvailable >= size) {
      return first.subarray(this.headOffset, this.headOffset + size);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (let i = this.head; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i];
      const start = i === this.head ? this.headOffset : 0;
      const take = Math.min(chunk.length - start, size - offset);
      if (take <= 0) continue;
      out.set(chunk.subarray(start, start + take), offset);
      offset += take;
      if (offset === size) break;
    }
    return out;
  }

  read(size) {
    if (this.length < size) return null;
    if (size === 0) return new Uint8Array();
    const first = this.chunks[this.head];
    const firstAvailable = first ? first.length - this.headOffset : 0;
    const out = firstAvailable >= size
      ? first.subarray(this.headOffset, this.headOffset + size)
      : this.peek(size);
    let remaining = size;
    this.length -= size;
    while (remaining > 0) {
      const chunk = this.chunks[this.head];
      const available = chunk.length - this.headOffset;
      if (available <= remaining) {
        remaining -= available;
        this.head += 1;
        this.headOffset = 0;
      } else {
        this.headOffset += remaining;
        remaining = 0;
      }
    }
    if (this.length === 0) {
      this.chunks = [];
      this.head = 0;
      this.headOffset = 0;
    } else {
      this.compact();
    }
    return out;
  }

  readAll() {
    if (this.length === 0) return new Uint8Array();
    const size = this.length;
    if (this.head === this.chunks.length - 1) {
      const chunk = this.chunks[this.head].subarray(this.headOffset);
      this.chunks = [];
      this.length = 0;
      this.head = 0;
      this.headOffset = 0;
      return chunk;
    }
    const out = this.peek(size) || new Uint8Array();
    this.chunks = [];
    this.length = 0;
    this.head = 0;
    this.headOffset = 0;
    return out;
  }
}

export function splitHostPort(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("empty host:port");
  if (raw.startsWith("[")) {
    const match = raw.match(/^\[([^\]]+)\]:(\d+)$/);
    if (!match) throw new Error(`invalid address: ${value}`);
    return { host: match[1], port: Number.parseInt(match[2], 10) };
  }
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) throw new Error(`invalid address: ${value}`);
  const host = raw.slice(0, idx);
  const port = Number.parseInt(raw.slice(idx + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port in address: ${value}`);
  }
  return { host, port };
}

export function joinHostPort(host, port) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function buildKIPMessage(type, payload = new Uint8Array()) {
  if (payload.length > 64 * 1024) throw new Error("kip payload too large");
  const out = new Uint8Array(6 + payload.length);
  out.set([0x6b, 0x69, 0x70, type, (payload.length >> 8) & 0xff, payload.length & 0xff], 0);
  out.set(payload, 6);
  return out;
}

export function tryReadKIPMessage(queue) {
  if (queue.length < 6) return null;
  const header = queue.peek(6);
  if (header[0] !== 0x6b || header[1] !== 0x69 || header[2] !== 0x70) {
    throw new Error("bad kip magic");
  }
  const length = (header[4] << 8) | header[5];
  if (queue.length < 6 + length) return null;
  queue.read(6);
  return { type: header[3], payload: queue.read(length) || new Uint8Array() };
}

export function decodeClientHello(payload) {
  if (payload.length < 68) throw new Error("client hello too short");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const timestamp = Number(view.getBigUint64(0));
  const out = {
    timestamp,
    userHash: payload.slice(8, 16),
    nonce: payload.slice(16, 32),
    clientPub: payload.slice(32, 64),
    features: view.getUint32(64),
  };
  if (payload.length >= 72) {
    out.tableHint = view.getUint32(68);
    out.hasTableHint = true;
  } else {
    out.tableHint = 0;
    out.hasTableHint = false;
  }
  return out;
}

export function encodeServerHello(nonce, serverPub, selectedFeatures) {
  const out = new Uint8Array(52);
  out.set(nonce, 0);
  out.set(serverPub, 16);
  new DataView(out.buffer).setUint32(48, selectedFeatures);
  return out;
}

export function encodeBase64Url(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset];
    const b = offset + 1 < bytes.length ? bytes[offset + 1] : 0;
    const c = offset + 2 < bytes.length ? bytes[offset + 2] : 0;
    const word = (a << 16) | (b << 8) | c;
    out += base64Alphabet[(word >> 18) & 0x3f];
    out += base64Alphabet[(word >> 12) & 0x3f];
    out += offset + 1 < bytes.length ? base64Alphabet[(word >> 6) & 0x3f] : "=";
    out += offset + 2 < bytes.length ? base64Alphabet[word & 0x3f] : "=";
  }
  return out.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Uint8Array();
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(raw, "base64url"));
  }
  const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const decoded = atob(padded);
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) out[i] = decoded.charCodeAt(i);
  return out;
}

export function encodeAddress(addr) {
  const { host, port } = splitHostPort(addr);
  const portBytes = new Uint8Array([(port >> 8) & 0xff, port & 0xff]);
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    return Uint8Array.from([0x01, ...ipv4.slice(1).map(Number), ...portBytes]);
  }
  if (host.includes(":")) {
    const full = expandIPv6(host);
    return Uint8Array.from([0x04, ...full, ...portBytes]);
  }
  const hostBytes = encoder.encode(host);
  if (hostBytes.length > 255) throw new Error("domain too long");
  return Uint8Array.from([0x03, hostBytes.length, ...hostBytes, ...portBytes]);
}

export function decodeAddress(payload) {
  const atyp = payload[0];
  if (atyp === 0x01 && payload.length >= 7) {
    const host = `${payload[1]}.${payload[2]}.${payload[3]}.${payload[4]}`;
    return joinHostPort(host, (payload[5] << 8) | payload[6]);
  }
  if (atyp === 0x03 && payload.length >= 4) {
    const len = payload[1];
    const host = decoder.decode(payload.slice(2, 2 + len));
    const base = 2 + len;
    return joinHostPort(host, (payload[base] << 8) | payload[base + 1]);
  }
  if (atyp === 0x04 && payload.length >= 19) {
    const parts = [];
    for (let i = 1; i < 17; i += 2) {
      parts.push(((payload[i] << 8) | payload[i + 1]).toString(16));
    }
    const host = parts.join(":");
    return joinHostPort(host, (payload[17] << 8) | payload[18]);
  }
  throw new Error("invalid address payload");
}

export function buildMuxFrame(frameType, streamId, payload = new Uint8Array()) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (data.length > 256 * 1024) throw new Error(`mux payload too large: ${data.length}`);
  const out = new Uint8Array(9 + data.length);
  out[0] = frameType;
  new DataView(out.buffer).setUint32(1, streamId);
  new DataView(out.buffer).setUint32(5, data.length);
  out.set(data, 9);
  return out;
}

export function tryReadMuxFrame(queue) {
  if (queue.length < 9) return null;
  const header = queue.peek(9);
  const payloadLength = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(5);
  if (payloadLength > 256 * 1024) throw new Error(`invalid mux frame length: ${payloadLength}`);
  if (queue.length < 9 + payloadLength) return null;
  queue.read(9);
  return {
    frameType: header[0],
    streamId: new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1),
    payload: queue.read(payloadLength) || new Uint8Array(),
  };
}

export function buildUoTDatagram(address, payload = new Uint8Array()) {
  const addr = encodeAddress(address);
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (addr.length > 0xffff) throw new Error(`address too long: ${addr.length}`);
  if (body.length > 0xffff) throw new Error(`payload too large: ${body.length}`);
  const out = new Uint8Array(4 + addr.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, addr.length);
  view.setUint16(2, body.length);
  out.set(addr, 4);
  out.set(body, 4 + addr.length);
  return out;
}

export function tryReadUoTDatagram(queue) {
  if (queue.length < 4) return null;
  const header = queue.peek(4);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const addrLength = view.getUint16(0);
  const payloadLength = view.getUint16(2);
  if (addrLength <= 0 || addrLength > 64 * 1024) throw new Error(`invalid address length: ${addrLength}`);
  if (payloadLength > 64 * 1024) throw new Error(`invalid payload length: ${payloadLength}`);
  if (queue.length < 4 + addrLength + payloadLength) return null;
  queue.read(4);
  const addr = queue.read(addrLength) || new Uint8Array();
  const payload = queue.read(payloadLength) || new Uint8Array();
  return { address: decodeAddress(addr), payload };
}

function expandIPv6(host) {
  const [left, right = ""] = host.split("::");
  const leftParts = left ? left.split(":").filter(Boolean) : [];
  const rightParts = right ? right.split(":").filter(Boolean) : [];
  const fill = new Array(8 - leftParts.length - rightParts.length).fill("0");
  const parts = [...leftParts, ...fill, ...rightParts];
  const out = [];
  for (const part of parts) {
    const value = Number.parseInt(part || "0", 16);
    out.push((value >> 8) & 0xff, value & 0xff);
  }
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function importHmacKey(key) {
  const cached = hmacKeyCache.get(key);
  if (cached) return cached;
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  hmacKeyCache.set(key, imported);
  return imported;
}

async function hmacSha256(key, data) {
  const cryptoKey = await importHmacKey(key);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

async function hkdfExpand(prk, info, length = 32) {
  const infoBytes = typeof info === "string" ? encoder.encode(info) : info;
  const data = new Uint8Array(infoBytes.length + 1);
  data.set(infoBytes, 0);
  data[infoBytes.length] = 0x01;
  const t1 = await hmacSha256(prk, data);
  return t1.slice(0, length);
}

export async function derivePSKDirectionalBases(psk) {
  const sum = await sha256(encoder.encode(psk));
  return {
    c2s: await hkdfExpand(sum, "sudoku-psk-c2s"),
    s2c: await hkdfExpand(sum, "sudoku-psk-s2c"),
  };
}

export async function deriveSessionDirectionalBases(psk, shared, nonce) {
  const sum = await sha256(encoder.encode(psk));
  const ikm = new Uint8Array(shared.length + nonce.length);
  ikm.set(shared, 0);
  ikm.set(nonce, shared.length);
  const prk = await hmacSha256(sum, ikm);
  return {
    c2s: await hkdfExpand(prk, "sudoku-session-c2s"),
    s2c: await hkdfExpand(prk, "sudoku-session-s2c"),
  };
}

export async function processEarlyClientPayload({ sharedKey, aead, payload, expectedTableHint = null }) {
  if (!payload || payload.length === 0) throw new Error("empty early payload");
  const psk = await derivePSKDirectionalBases(sharedKey);
  const record = new RecordLayer(aead, psk.s2c, psk.c2s);
  const plains = await record.pushCipherBytes(payload);
  const plain = concatChunks(plains);
  const queue = new ByteQueue();
  queue.push(plain);
  const msg = tryReadKIPMessage(queue);
  if (!msg) throw new Error("incomplete early payload");
  if (msg.type !== 0x01) throw new Error(`unexpected early message: ${msg.type}`);
  const hello = decodeClientHello(msg.payload);
  if (Math.abs(Math.floor(Date.now() / 1000) - hello.timestamp) > 60) {
    throw new Error("time skew/replay");
  }
  if (expectedTableHint !== null && hello.hasTableHint && hello.tableHint !== (expectedTableHint >>> 0)) {
    throw new Error(`unknown table hint: ${hello.tableHint}`);
  }
  const ephemeral = await generateX25519KeyPair();
  const shared = await deriveX25519SharedSecret(ephemeral.privateKey, hello.clientPub);
  const session = await deriveSessionDirectionalBases(sharedKey, shared, hello.nonce);
  const response = await record.encode(buildKIPMessage(0x02, encodeServerHello(hello.nonce, ephemeral.publicKey, hello.features)));
  return {
    responsePayload: response,
    sessionSendBase: session.s2c,
    sessionRecvBase: session.c2s,
  };
}

async function deriveEpochKey(base, epoch, method) {
  const info = encoder.encode(`sudoku-record:${method}`);
  const data = new Uint8Array(info.length + 4);
  data.set(info, 0);
  new DataView(data.buffer).setUint32(info.length, epoch);
  return hmacSha256(base, data);
}

async function importAesKey(raw) {
  return crypto.subtle.importKey("raw", raw.slice(0, 16), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function randomNonZeroUint32() {
  const arr = crypto.getRandomValues(new Uint32Array(1));
  let v = arr[0] >>> 0;
  while (v === 0 || v === 0xffffffff) v = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  return v;
}

function randomNonZeroUint64() {
  let hi = randomNonZeroUint32();
  let lo = randomNonZeroUint32();
  let v = (BigInt(hi) << 32n) | BigInt(lo);
  while (v === 0n || v === 0xffffffffffffffffn) {
    hi = randomNonZeroUint32();
    lo = randomNonZeroUint32();
    v = (BigInt(hi) << 32n) | BigInt(lo);
  }
  return v;
}

function makeHeader(epoch, seq) {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(0, epoch);
  view.setBigUint64(4, seq);
  return out;
}

export class RecordLayer {
  constructor(aeadMethod, sendBase, recvBase) {
    this.method = aeadMethod;
    this.sendBase = sendBase;
    this.recvBase = recvBase;
    this.sendEpoch = randomNonZeroUint32();
    this.sendSeq = randomNonZeroUint64();
    this.recvEpoch = 0;
    this.recvSeq = 0n;
    this.recvInitialized = false;
    this.recvBuffer = new ByteQueue();
    this.sendKeys = new Map();
    this.recvKeys = new Map();
  }

  async rekey(sendBase, recvBase) {
    this.sendBase = sendBase;
    this.recvBase = recvBase;
    this.sendEpoch = randomNonZeroUint32();
    this.sendSeq = randomNonZeroUint64();
    this.recvEpoch = 0;
    this.recvSeq = 0n;
    this.recvInitialized = false;
    this.sendKeys.clear();
    this.recvKeys.clear();
  }

  async getKey(cache, base, epoch) {
    const keyId = `${this.method}:${epoch}`;
    if (cache.has(keyId)) return cache.get(keyId);
    if (this.method === "none") {
      cache.set(keyId, null);
      return null;
    }
    if (this.method !== "aes-128-gcm") {
      throw new Error(`unsupported AEAD in pure worker mode: ${this.method}`);
    }
    const epochKey = await deriveEpochKey(base, epoch, this.method);
    const key = await importAesKey(epochKey);
    cache.set(keyId, key);
    return key;
  }

  async encode(plain) {
    if (this.method === "none") return plain;
    const out = [];
    let offset = 0;
    while (offset < plain.length) {
      const chunk = plain.slice(offset, offset + 65535 - 12 - 16);
      offset += chunk.length;
      const header = makeHeader(this.sendEpoch, this.sendSeq);
      this.sendSeq += 1n;
      const key = await this.getKey(this.sendKeys, this.sendBase, this.sendEpoch);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: header, additionalData: header, tagLength: 128 }, key, chunk));
      const bodyLen = 12 + encrypted.length;
      const frame = new Uint8Array(2 + bodyLen);
      frame[0] = (bodyLen >> 8) & 0xff;
      frame[1] = bodyLen & 0xff;
      frame.set(header, 2);
      frame.set(encrypted, 14);
      out.push(frame);
    }
    return concatChunks(out);
  }

  async pushCipherBytes(chunk) {
    if (this.method === "none") return [chunk];
    this.recvBuffer.push(chunk);
    const messages = [];
    while (this.recvBuffer.length >= 2) {
      const lenBuf = this.recvBuffer.peek(2);
      const bodyLen = (lenBuf[0] << 8) | lenBuf[1];
      if (this.recvBuffer.length < 2 + bodyLen) break;
      this.recvBuffer.read(2);
      const body = this.recvBuffer.read(bodyLen);
      const header = body.slice(0, 12);
      const ciphertext = body.slice(12);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const epoch = view.getUint32(0);
      const seq = view.getBigUint64(4);
      if (this.recvInitialized) {
        if (epoch < this.recvEpoch) throw new Error("replayed epoch");
        if (epoch === this.recvEpoch && seq !== this.recvSeq) throw new Error("out of order frame");
        if (epoch > this.recvEpoch && epoch - this.recvEpoch > 8) throw new Error("epoch jump too large");
      }
      const key = await this.getKey(this.recvKeys, this.recvBase, epoch);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: header, additionalData: header, tagLength: 128 }, key, ciphertext));
      this.recvEpoch = epoch;
      this.recvSeq = seq + 1n;
      this.recvInitialized = true;
      messages.push(plain);
    }
    return messages;
  }
}

export async function generateX25519KeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

export async function deriveX25519SharedSecret(privateKey, peerPublicRaw) {
  const peer = await crypto.subtle.importKey("raw", peerPublicRaw, { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256));
}

export function concatChunks(chunks) {
  if (!chunks.length) return new Uint8Array();
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (let i = 0; i < chunks.length; i += 1) total += chunks[i].length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
