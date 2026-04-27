import { joinHostPort, splitHostPort } from "./sudoku-protocol.mjs";

const remoteCache = new Map();
const DEFAULT_WETEST_SOURCES = [
  "https://www.wetest.vip/page/cloudflare/address_v4.html",
  "https://www.wetest.vip/page/cloudflare/address_v6.html",
];
export const DEFAULT_REMOTE_TEXT_SOURCES = [
  "https://raw.githubusercontent.com/XIU2/CloudflareSpeedTest/master/ip.txt",
  "https://raw.githubusercontent.com/gslege/CloudflareIP/main/All.txt",
  "https://raw.githubusercontent.com/gslege/CloudflareIP/main/Domain.txt",
  "https://raw.githubusercontent.com/xinyitang3/rules/main/ip.txt",
];
const BUILT_IN_CANDIDATE_HOSTS = [
  "47.97.96.18",
  "1.0.0.1", "1.1.1.1", "104.16.0.1", "104.16.1.1", "104.16.2.1", "104.16.3.1", "104.17.0.1", "104.17.1.1", "104.17.2.1", "104.17.3.1",
  "104.18.0.1", "104.18.1.1", "104.18.2.1", "104.18.3.1", "104.19.0.1", "104.19.1.1", "104.19.2.1", "104.19.3.1", "104.20.0.1", "104.20.1.1",
  "104.20.2.1", "104.20.3.1", "104.21.0.1", "104.21.1.1", "104.21.2.1", "104.21.3.1", "104.22.0.1", "104.22.1.1", "104.22.2.1", "104.22.3.1",
  "104.24.0.1", "104.24.1.1", "104.24.2.1", "104.24.3.1", "104.25.0.1", "104.25.1.1", "104.25.2.1", "104.25.3.1", "104.26.0.1", "104.26.1.1",
  "104.27.0.1", "104.28.0.1", "104.29.0.1", "104.30.0.1", "104.31.0.1", "162.158.0.1", "162.158.1.1", "162.158.2.1", "162.158.3.1", "162.159.0.1",
  "162.159.1.1", "162.159.2.1", "162.159.3.1", "162.159.36.1", "162.159.46.1", "162.159.128.1", "162.159.129.1", "162.159.130.1", "162.159.131.1", "162.159.192.1",
  "162.159.193.1", "162.159.194.1", "162.159.195.1", "172.64.0.1", "172.64.1.1", "172.64.2.1", "172.64.3.1", "172.65.0.1", "172.65.1.1", "172.65.2.1",
  "172.65.3.1", "172.66.0.1", "172.66.1.1", "172.66.2.1", "172.66.3.1", "172.67.0.1", "172.67.1.1", "172.67.2.1", "172.67.3.1", "188.114.96.1",
  "188.114.97.1", "188.114.98.1", "188.114.99.1", "188.114.100.1", "188.114.101.1", "188.114.102.1", "188.114.103.1",
  "cdnjs.cloudflare.com", "pages.cloudflare.com", "workers.cloudflare.com", "developers.cloudflare.com", "radar.cloudflare.com",
];
const EXCLUDED_CF_PREFIXES = ["198.41.", "141.101.", "190.93.", "197.234."];
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/;

function uniqByAddress(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (!entry?.address || seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push(entry);
  }
  return out;
}

function parseMaybeNumber(value) {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function isIpv4(value) {
  const raw = String(value || "").trim();
  return IPV4_RE.test(raw) && raw.split(".").every((part) => {
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function isDomain(value) {
  return DOMAIN_RE.test(String(value || "").trim());
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function expandCidrSamples(cidr) {
  const [ip, prefixRaw] = String(cidr || "").split("/");
  const prefix = Number(prefixRaw);
  if (!isIpv4(ip) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return [];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const base = ipv4ToInt(ip) & mask;
  const size = 2 ** (32 - prefix);
  const offsets = size <= 8 ? [...Array(size).keys()] : [1, Math.floor(size * 0.2), Math.floor(size * 0.5), Math.floor(size * 0.8)];
  return [...new Set(offsets.map((offset) => intToIpv4((base + offset) >>> 0)).filter(isIpv4))];
}

function isExcludedCfPrefix(ip) {
  return EXCLUDED_CF_PREFIXES.some((prefix) => ip.startsWith(prefix));
}

function cleanLooseCandidateToken(token) {
  let raw = String(token || "").trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return "";
  raw = raw.replace(/^https?:\/\//i, "");
  raw = raw.split("?")[0].trim();
  raw = raw.split("|")[0].trim();
  raw = raw.split("#")[0].trim();
  if (CIDR_RE.test(raw)) return raw;
  raw = raw.split("/")[0].trim();
  const hostPort = raw.match(/^([^:[\]]+):(\d+)$/);
  if (hostPort) raw = hostPort[1].trim();
  return raw;
}

function isLooseCandidateLike(value) {
  const token = cleanLooseCandidateToken(value);
  return Boolean(token && (CIDR_RE.test(token) || isIpv4(token) || isDomain(token)));
}

function normalizeAddress(value, defaultPort = 443) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const { host, port } = splitHostPort(raw);
    return joinHostPort(host, port);
  } catch {
    if (raw.includes(":") && !raw.startsWith("[") && raw.includes("::")) {
      return joinHostPort(raw, defaultPort);
    }
    return joinHostPort(raw, defaultPort);
  }
}

function normalizeLooseCandidateEntry(value, defaultPort = 443, sourceIndex = 0) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const labelIndex = raw.indexOf("#");
  const label = labelIndex >= 0 ? raw.slice(labelIndex + 1).trim() : "";
  const token = cleanLooseCandidateToken(raw);
  if (!token) return [];
  if (CIDR_RE.test(token)) {
    return expandCidrSamples(token)
      .filter((ip) => !isExcludedCfPrefix(ip))
      .map((ip, index) => ({
        address: normalizeAddress(ip, defaultPort),
        name: label || token,
        latencyMs: null,
        downloadMbps: null,
        score: null,
        sourceIndex: sourceIndex + index / 1000,
      }));
  }
  if (isIpv4(token)) {
    if (isExcludedCfPrefix(token)) return [];
    return [{
      address: normalizeAddress(token, defaultPort),
      name: label,
      latencyMs: null,
      downloadMbps: null,
      score: null,
      sourceIndex,
    }];
  }
  if (isDomain(token)) {
    return [{
      address: normalizeAddress(token.toLowerCase(), defaultPort),
      name: label,
      latencyMs: null,
      downloadMbps: null,
      score: null,
      sourceIndex,
    }];
  }
  return [];
}

function splitLoosePreferredTokens(input) {
  const lines = String(input || "").split(/\r?\n/);
  const tokens = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    for (const segmentRaw of trimmed.split(/[;,]+/)) {
      const segment = segmentRaw.trim();
      if (!segment) continue;
      if (segment.includes("#")) {
        tokens.push(segment);
        continue;
      }
      for (const token of segment.split(/\s+/)) {
        if (token) tokens.push(token);
      }
    }
  }
  return tokens;
}

function normalizeEntry(value, defaultPort = 443) {
  if (!value) return null;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
    const hashIndex = raw.indexOf("#");
    const addressPart = hashIndex >= 0 ? raw.slice(0, hashIndex).trim() : raw;
    const namePart = hashIndex >= 0 ? raw.slice(hashIndex + 1).trim() : "";
    const address = normalizeAddress(addressPart, defaultPort);
    if (!address) return null;
    return { address, name: namePart || "", latencyMs: null, downloadMbps: null, score: null, sourceIndex: 0 };
  }

  if (typeof value === "object") {
    const address = normalizeAddress(
      value.address || value.addr || value.endpoint || (value.ip || value.host ? joinHostPort(value.ip || value.host, Number.parseInt(String(value.port || defaultPort), 10) || defaultPort) : ""),
      defaultPort,
    );
    if (!address) return null;
    const name = String(value.name || value.label || value.remark || value.title || "").trim();
    return {
      address,
      name,
      latencyMs: parseMaybeNumber(value.latency ?? value.delay ?? value.ping ?? value.latency_ms),
      downloadMbps: parseMaybeNumber(value.download ?? value.speed ?? value.download_mbps ?? value.bandwidth),
      score: parseMaybeNumber(value.score ?? value.rank_score),
      sourceIndex: Number.isInteger(value.sourceIndex) ? value.sourceIndex : 0,
    };
  }

  return null;
}

function parseCsvEntries(input, defaultPort = 443) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !lines[0].includes(",")) return [];

  const headers = lines[0].split(",").map((header) => header.trim().toLowerCase());
  const idx = (names) => names.map((name) => headers.indexOf(name)).find((value) => value >= 0) ?? -1;
  const ipIdx = idx(["ip", "address", "host"]);
  const portIdx = idx(["port"]);
  const latencyIdx = idx(["latency", "delay", "ping", "latency_ms"]);
  const speedIdx = idx(["download", "downloadmbps", "download_mbps", "speed", "bandwidth"]);
  const regionIdx = idx(["region", "colo", "datacenter", "loc", "city", "label", "name"]);
  const scoreIdx = idx(["score", "rank", "rank_score"]);
  if (ipIdx < 0) return [];

  const entries = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",").map((col) => col.trim());
    const host = cols[ipIdx];
    const port = portIdx >= 0 ? cols[portIdx] : "";
    const address = normalizeAddress(port ? joinHostPort(host, Number.parseInt(port, 10) || defaultPort) : host, defaultPort);
    if (!address) continue;
    entries.push({
      address,
      name: regionIdx >= 0 ? cols[regionIdx] || "" : "",
      latencyMs: latencyIdx >= 0 ? parseMaybeNumber(cols[latencyIdx]) : null,
      downloadMbps: speedIdx >= 0 ? parseMaybeNumber(cols[speedIdx]) : null,
      score: scoreIdx >= 0 ? parseMaybeNumber(cols[scoreIdx]) : null,
      sourceIndex: i - 1,
    });
  }
  return uniqByAddress(entries);
}

function parseJsonEntries(input, defaultPort = 443) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) {
    return uniqByAddress(parsed.map((item) => normalizeEntry(item, defaultPort)).filter(Boolean));
  }

  if (parsed && typeof parsed === "object") {
    for (const key of ["addresses", "ips", "data", "result", "list", "items"]) {
      if (Array.isArray(parsed[key])) {
        return uniqByAddress(parsed[key].map((item) => normalizeEntry(item, defaultPort)).filter(Boolean));
      }
    }
    const single = normalizeEntry(parsed, defaultPort);
    return single ? [single] : [];
  }

  return [];
}

function stripHtmlTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
}

function parseWetestHtml(input, defaultPort = 443) {
  const html = String(input || "");
  if (!html.includes('data-label="优选地址"')) return [];

  const results = [];
  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  const cellRegex = /<td[^>]*data-label="线路名称"[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*data-label="优选地址"[^>]*>([\d.:a-fA-F]+)<\/td>[\s\S]*?<td[^>]*data-label="数据中心"[^>]*>([\s\S]*?)<\/td>/i;

  let row;
  while ((row = rowRegex.exec(html)) !== null) {
    const match = row[0].match(cellRegex);
    if (!match) continue;
    const lineName = stripHtmlTags(match[1]);
    const host = stripHtmlTags(match[2]);
    const colo = stripHtmlTags(match[3]);
    const address = normalizeAddress(host, defaultPort);
    if (!address) continue;
    const name = [lineName, colo].filter(Boolean).join(" | ");
    results.push({
      address,
      name,
      latencyMs: null,
      downloadMbps: null,
      score: null,
      sourceIndex: results.length,
    });
  }

  return uniqByAddress(results);
}

export function parsePreferredIpList(input, defaultPort = 443) {
  const raw = String(input || "").trim();
  if (!raw) return [];
  if (raw.includes('data-label="优选地址"')) {
    const parsed = parseWetestHtml(raw, defaultPort);
    if (parsed.length > 0) return parsed;
  }
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = parseJsonEntries(raw, defaultPort);
    if (parsed.length > 0) return parsed;
  }
  if (raw.includes(",") && raw.includes("\n")) {
    const csvEntries = parseCsvEntries(raw, defaultPort);
    if (csvEntries.length > 0) return csvEntries;
  }
  const entries = splitLoosePreferredTokens(raw)
    .flatMap((part, index) => {
      const loose = normalizeLooseCandidateEntry(part, defaultPort, index);
      if (loose.length > 0 || isLooseCandidateLike(part)) return loose;
      const entry = normalizeEntry(part, defaultPort);
      if (entry) entry.sourceIndex = index;
      return entry ? [entry] : [];
    });
  return uniqByAddress(entries);
}

export const CFNEW_DEFAULT_PREFERRED_ENTRIES = BUILT_IN_CANDIDATE_HOSTS.flatMap((host, index) =>
  normalizeLooseCandidateEntry(host, 443, index),
);

async function fetchTextWithTimeout(source, timeoutMs, accept = "text/plain,text/html;q=0.9,*/*;q=0.8") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetch(source, {
      headers: { accept },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadBuiltInTextPreferredEntries(defaultPort, cacheTtlMs) {
  const cacheKey = "__builtin_text_sources__";
  const now = Date.now();
  const cached = remoteCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.entries;
  }

  const settled = await Promise.allSettled(
    DEFAULT_REMOTE_TEXT_SOURCES.map((source) =>
      fetchTextWithTimeout(source, 5000).then((text) => parsePreferredIpList(text, defaultPort)),
    ),
  );

  const entries = uniqByAddress(
    settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  ).map((entry, index) => ({ ...entry, sourceIndex: index + CFNEW_DEFAULT_PREFERRED_ENTRIES.length }));

  remoteCache.set(cacheKey, { entries, expiresAt: now + Math.max(cacheTtlMs, 0) });
  return entries;
}

async function loadBuiltInPreferredEntries(defaultPort, cacheTtlMs) {
  const cacheKey = "__builtin_wetest__";
  const now = Date.now();
  const cached = remoteCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.entries;
  }

  const settled = await Promise.allSettled(
    DEFAULT_WETEST_SOURCES.map((source) =>
      fetchTextWithTimeout(source, 5000, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        .then((text) => parseWetestHtml(text, defaultPort)),
    ),
  );

  const entries = uniqByAddress(
    settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  ).map((entry, index) => ({ ...entry, sourceIndex: index }));

  remoteCache.set(cacheKey, { entries, expiresAt: now + Math.max(cacheTtlMs, 0) });
  return entries;
}

export function isLiteralIpHost(host) {
  const raw = String(host || "").trim();
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(raw) || raw.includes(":");
}

export function classifyPreferredEntry(entry) {
  const { host } = splitHostPort(entry.address);
  return isLiteralIpHost(host) ? "ip" : "domain";
}

export function filterPreferredEntries(entries, { enableIPs = true, enableDomains = true, region = "" } = {}) {
  const regionNeedle = String(region || "").trim().toUpperCase();
  return entries.filter((entry) => {
    const kind = classifyPreferredEntry(entry);
    if (kind === "ip" && !enableIPs) return false;
    if (kind === "domain" && !enableDomains) return false;
    if (!regionNeedle) return true;
    const haystack = `${entry.name || ""} ${entry.address}`.toUpperCase();
    return haystack.includes(regionNeedle);
  });
}

async function loadFromRemoteUrl(source, defaultPort, cacheTtlMs) {
  const now = Date.now();
  const cached = remoteCache.get(source);
  if (cached && cached.expiresAt > now) {
    return cached;
  }
  const response = await fetch(source, {
    headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout?.(5000),
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  const remoteEntries = parsePreferredIpList(text, defaultPort);
  const result = { entries: remoteEntries, text };
  remoteCache.set(source, { ...result, expiresAt: now + Math.max(cacheTtlMs, 0) });
  return result;
}

export async function loadPreferredIpPool({ inlineList = "", sourceUrl = "", defaultPort = 443, cacheTtlMs = 0, kv = null, kvKey = "", defaultEntries = [], enableBuiltIn = false }) {
  const inlineEntries = parsePreferredIpList(inlineList, defaultPort);
  let builtInEntries = Array.isArray(defaultEntries) ? defaultEntries : [];
  let kvEntries = [];
  const kvStorageKey = String(kvKey || "").trim();
  if (kv && kvStorageKey) {
    try {
      kvEntries = parsePreferredIpList((await kv.get(kvStorageKey, "text")) || "", defaultPort);
    } catch {}
  }
  const source = String(sourceUrl || "").trim();
  if (!source && enableBuiltIn && kvEntries.length === 0 && inlineEntries.length === 0 && builtInEntries.length === 0) {
    try {
      const [textEntries, wetestEntries] = await Promise.all([
        loadBuiltInTextPreferredEntries(defaultPort, cacheTtlMs).catch(() => []),
        loadBuiltInPreferredEntries(defaultPort, cacheTtlMs).catch(() => []),
      ]);
      builtInEntries = uniqByAddress([...CFNEW_DEFAULT_PREFERRED_ENTRIES, ...textEntries, ...wetestEntries]);
    } catch {}
  }
  if (!source) {
    return {
      entries: uniqByAddress([...kvEntries, ...inlineEntries, ...builtInEntries]),
      preferredSource: kvEntries.length > 0 ? "kv" : inlineEntries.length > 0 ? "inline" : builtInEntries.length > 0 ? "builtin" : "",
      preferredError: "",
    };
  }

  try {
    const { entries: remoteEntries } = await loadFromRemoteUrl(source, defaultPort, cacheTtlMs);
    return {
      entries: uniqByAddress([...remoteEntries, ...kvEntries, ...inlineEntries, ...builtInEntries]),
      preferredSource: remoteEntries.length > 0 ? source : kvEntries.length > 0 ? "kv" : inlineEntries.length > 0 ? "inline" : "",
      preferredError: remoteEntries.length > 0 || kvEntries.length > 0 || inlineEntries.length > 0 || builtInEntries.length > 0 ? "" : "preferred IP source returned no usable entries",
    };
  } catch (error) {
    return {
      entries: uniqByAddress([...kvEntries, ...inlineEntries, ...builtInEntries]),
      preferredSource: kvEntries.length > 0 ? "kv" : inlineEntries.length > 0 ? "inline" : builtInEntries.length > 0 ? "builtin" : "",
      preferredError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function normalizePreferredIpStrategy(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "best") return "best";
  if (raw === "first" || raw === "rotate" || raw === "random") return raw;
  throw new Error(`invalid preferred IP strategy: ${value}`);
}

export function comparePreferredEntries(a, b) {
  const aScore = a.score;
  const bScore = b.score;
  if (aScore !== null && bScore !== null && aScore !== bScore) return bScore - aScore;

  const aLatency = a.latencyMs;
  const bLatency = b.latencyMs;
  if (aLatency !== null && bLatency !== null && aLatency !== bLatency) return aLatency - bLatency;

  const aSpeed = a.downloadMbps;
  const bSpeed = b.downloadMbps;
  if (aSpeed !== null && bSpeed !== null && aSpeed !== bSpeed) return bSpeed - aSpeed;

  return (a.sourceIndex || 0) - (b.sourceIndex || 0);
}

function hostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function preferredProbeUrl(entry) {
  const { host, port } = splitHostPort(entry.address);
  if (isLiteralIpHost(host)) {
    const probePort = port === 443 ? 80 : port;
    return `http://${hostForUrl(host)}${probePort === 80 ? "" : `:${probePort}`}/cdn-cgi/trace`;
  }
  return `https://${hostForUrl(host)}${port === 443 ? "" : `:${port}`}/cdn-cgi/trace`;
}

async function timedFetchProbe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(300, timeoutMs));
  const start = performance.now();
  try {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}__sudoku_probe=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const reader = response.body?.getReader();
    let sizeBytes = 0;
    if (reader) {
      while (sizeBytes < 64 * 1024) {
        const { value, done } = await reader.read();
        if (done) break;
        sizeBytes += value?.length || 0;
      }
      try {
        await reader.cancel();
      } catch {}
    }
    const ms = performance.now() - start;
    return {
      ok: response.status > 0 && response.status < 530,
      httpCode: response.status,
      ms,
      sizeBytes,
      mbps: sizeBytes > 0 && ms > 0 ? (sizeBytes * 8) / ms / 1000 : Math.max(0, 40 - ms / 20),
    };
  } catch (error) {
    return { ok: false, httpCode: 0, ms: performance.now() - start, sizeBytes: 0, mbps: 0, error: error?.name || "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

export function scoreProbeResult(result) {
  if (!result || result.failures >= result.rounds || !Number.isFinite(result.avgLatencyMs)) return 0;
  const latency = Math.max(1, result.avgLatencyMs || 9999);
  const p95 = Math.max(latency, result.p95LatencyMs || latency);
  const mbps = Math.max(0, result.downloadMbps || 0);
  const reliability = Math.max(0, 1 - (result.failures || 0) * 0.25);
  const latencyScore = 160000 / latency;
  const stabilityScore = 50000 / p95;
  const speedScore = mbps * 40;
  return Math.round((latencyScore + stabilityScore + speedScore) * reliability);
}

export async function probePreferredEntry(entry, { rounds = 2, timeoutMs = 1800 } = {}) {
  const samples = [];
  let failures = 0;
  let bestMbps = 0;
  let lastHttpCode = 0;
  const url = preferredProbeUrl(entry);
  for (let i = 0; i < Math.max(1, rounds); i += 1) {
    const result = await timedFetchProbe(url, timeoutMs);
    lastHttpCode = result.httpCode || lastHttpCode;
    if (result.ok) {
      samples.push(result.ms);
      bestMbps = Math.max(bestMbps, result.mbps || 0);
    } else {
      failures += 1;
    }
  }
  samples.sort((a, b) => a - b);
  const avg = samples.length ? samples.reduce((sum, item) => sum + item, 0) / samples.length : Infinity;
  const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] : Infinity;
  const metrics = {
    latencyMs: Number.isFinite(avg) ? Math.round(avg) : null,
    avgLatencyMs: Number.isFinite(avg) ? Math.round(avg) : Infinity,
    p95LatencyMs: Number.isFinite(p95) ? Math.round(p95) : Infinity,
    downloadMbps: Number(bestMbps.toFixed(2)),
    failures,
    rounds: Math.max(1, rounds),
    httpCode: lastHttpCode,
    probeUrl: url,
  };
  const score = scoreProbeResult(metrics);
  return {
    ...entry,
    latencyMs: metrics.latencyMs,
    downloadMbps: metrics.downloadMbps,
    score,
    probe: metrics,
  };
}

async function probePreferredEntryCached(entry, options = {}) {
  const cacheTtlMs = Math.max(0, Number.parseInt(String(options.cacheTtlMs ?? 0), 10) || 0);
  if (cacheTtlMs <= 0) return probePreferredEntry(entry, options);

  const rounds = Math.max(1, Number.parseInt(String(options.rounds ?? 2), 10) || 2);
  const timeoutMs = Math.max(300, Number.parseInt(String(options.timeoutMs ?? 1800), 10) || 1800);
  const cacheKey = `__probe__|${entry.address}|${rounds}|${timeoutMs}`;
  const now = Date.now();
  const cached = remoteCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.promise || cached.entry;
  }

  const promise = probePreferredEntry(entry, { ...options, rounds, timeoutMs });
  remoteCache.set(cacheKey, { promise, expiresAt: now + cacheTtlMs });
  try {
    const probed = await promise;
    remoteCache.set(cacheKey, { entry: probed, expiresAt: Date.now() + cacheTtlMs });
    return probed;
  } catch (error) {
    remoteCache.delete(cacheKey);
    throw error;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function pickPreferredEntryWithProbe(entries, strategy = "best", seed = "", probeOptions = {}) {
  if (!entries?.length) return null;
  if (strategy !== "best" || probeOptions.enabled === false) {
    return pickPreferredEntry(entries, strategy, seed);
  }
  const maxCandidates = Math.max(1, Number.parseInt(String(probeOptions.maxCandidates ?? 16), 10) || 16);
  const candidates = [...entries].sort(comparePreferredEntries).slice(0, maxCandidates);
  const probed = await mapWithConcurrency(candidates, Number.parseInt(String(probeOptions.concurrency ?? 6), 10) || 6, (entry) =>
    probePreferredEntryCached(entry, probeOptions).catch(() => ({ ...entry, score: 0, probe: { failures: probeOptions.rounds || 2 } })),
  );
  const usable = probed.filter((entry) => entry.score > 0);
  if (usable.length === 0) return pickPreferredEntry(entries, strategy, seed);
  return usable.sort(comparePreferredEntries)[0];
}

export function pickPreferredEntry(entries, strategy = "best", seed = "") {
  if (!entries?.length) return null;
  if (strategy === "best") {
    const sorted = [...entries].sort(comparePreferredEntries);
    return sorted[0];
  }
  if (strategy === "first") return entries[0];
  if (strategy === "random") return entries[Math.floor(Math.random() * entries.length)];

  let hash = 0x811c9dc5;
  const input = new TextEncoder().encode(`${seed}|${Math.floor(Date.now() / 60000)}`);
  for (const byte of input) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return entries[hash % entries.length];
}
