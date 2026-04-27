import { buildKIPMessage, encodeAddress, joinHostPort, splitHostPort } from "./sudoku-protocol.mjs";
import { normalizeAsciiMode } from "./sudoku-table.mjs";

export function normalizePathRoot(value) {
  const raw = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error("SUDOKU_HTTP_MASK_PATH_ROOT must be [A-Za-z0-9_-]");
  }
  return `/${raw}`;
}

export function deriveRandomPathRoot(seed) {
  const input = new TextEncoder().encode(String(seed || "sudoku-path-root"));
  let hash = 0x811c9dc5;
  for (const byte of input) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let state = hash || 0x9e3779b9;
  const nextUint32 = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const length = 6 + (nextUint32() % 5);
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += alphabet[nextUint32() % alphabet.length];
  }
  return output;
}

export function resolvePathRoot(pathRoot, seed) {
  const normalized = normalizePathRoot(pathRoot);
  if (normalized) return normalized;
  return normalizePathRoot(deriveRandomPathRoot(seed));
}

export function buildWSPath(pathRoot) {
  return pathRoot ? `${pathRoot}/ws` : "/ws";
}

export function buildClientConfig(options) {
  const serverAddress = options.serverAddress ? normalizeServerAddress(options.serverAddress, 443) : joinHostPort(options.publicHost, 443);
  const asciiMode = normalizeAsciiMode(options.ascii || "prefer_entropy");
  const aead = String(options.aead || "none").trim() || "none";
  const pureDownlink = options.enablePureDownlink === true;
  const multiplex = normalizeMultiplexMode(options.httpMaskMultiplex || "off");
  const pathRoot = resolvePathRoot(options.pathRoot, options.pathRootSeed || options.key || options.publicHost);
  const tlsEnabled = options.httpMaskTLS !== false;
  return {
    mode: "client",
    transport: "tcp",
    local_port: Number.parseInt(String(options.localPort || 10233), 10),
    server_address: serverAddress,
    key: String(options.key || "").trim(),
    aead,
    ascii: asciiMode,
    padding_min: 0,
    padding_max: 0,
    enable_pure_downlink: pureDownlink,
    httpmask: {
      disable: false,
      mode: "ws",
      tls: tlsEnabled,
      host: String(options.httpMaskHost || "").trim(),
      path_root: pathRoot,
      multiplex,
    },
    rule_urls: ["global"],
  };
}

export function buildShortLinkFromClientConfig(config) {
  const { host, port } = splitHostPort(config.server_address);
  const payload = {
    h: host,
    p: port,
    k: config.key,
    a: encodeAscii(config.ascii),
    e: config.aead,
    m: config.local_port,
    ht: config.httpmask?.tls !== false,
    hm: "ws",
    x: config.enable_pure_downlink === false,
  };
  if (config.httpmask?.host) payload.hh = config.httpmask.host;
  if (config.httpmask?.path_root) payload.hy = config.httpmask.path_root;
  if (config.httpmask?.multiplex && config.httpmask.multiplex !== "off") payload.hx = config.httpmask.multiplex;
  return `sudoku://${toBase64Url(JSON.stringify(payload))}`;
}

export function buildClashNode(config, nodeName = "sudoku-cf-worker-pure") {
  const { host, port } = splitHostPort(config.server_address);
  const lines = [
    "# sudoku",
    `- name: ${nodeName}`,
    "  type: sudoku",
    `  server: "${host}"`,
    `  port: ${port}`,
    `  key: "${config.key}"`,
    `  aead-method: ${config.aead}`,
    "  padding-min: 0",
    "  padding-max: 0",
    `  table-type: ${encodeAscii(config.ascii)}`,
    "  http-mask: true",
    "  http-mask-mode: ws",
    `  http-mask-tls: ${config.httpmask?.tls !== false}`,
    `  http-mask-multiplex: "${normalizeMultiplexMode(config.httpmask?.multiplex || "off")}"`,
    `  enable-pure-downlink: ${config.enable_pure_downlink !== false}`,
  ];
  if (config.httpmask?.host) lines.push(`  http-mask-host: "${config.httpmask.host}"`);
  if (config.httpmask?.path_root) lines.push(`  http-mask-path-root: "${config.httpmask.path_root}"`);
  return `${lines.join("\n")}\n`;
}

export function buildOpenTcpMessage(targetAddress) {
  return buildKIPMessage(0x10, encodeAddress(targetAddress));
}

function toBase64Url(input) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf8").toString("base64url");
  }
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAscii(mode) {
  const normalized = normalizeAsciiMode(mode || "prefer_entropy");
  switch (normalized) {
    case "prefer_ascii":
      return "ascii";
    case "prefer_entropy":
      return "entropy";
    default:
      return normalized;
  }
}

function normalizeServerAddress(value, defaultPort = 443) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("empty serverAddress");
  try {
    const { host, port } = splitHostPort(raw);
    return joinHostPort(host, port);
  } catch {
    return joinHostPort(raw, defaultPort);
  }
}

function normalizeMultiplexMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "off") return "off";
  if (raw === "auto" || raw === "on") return raw;
  throw new Error(`invalid httpmask multiplex mode: ${value}`);
}
