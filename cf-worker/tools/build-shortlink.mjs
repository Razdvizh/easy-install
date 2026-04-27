import { readFileSync } from "node:fs";

import {
  buildClientConfig,
  buildClashNode,
  buildShortLinkFromClientConfig,
} from "../src/sudoku-config.mjs";
import {
  filterPreferredEntries,
  loadPreferredIpPool,
  normalizePreferredIpStrategy,
  pickPreferredEntryWithProbe,
} from "../src/preferred-ip.mjs";

function usage() {
  console.error(`Usage:
  node cf-worker/tools/build-shortlink.mjs --host worker.example.com --key <key> [options]

Options:
  --local-port <port>         Client local port, default 10233
  --path-root <segment>       Optional fixed HTTP mask path root; export uses /<segment>, omitted => derive a stable random segment from key
  --preferred-address <addr>  Optional preferred ingress IP/domain:port for exported node, while keeping --host as Host/SNI
  --preferred-auto <bool>     Auto-pick a preferred ingress before output, default false unless a preferred source is set
  --preferred-ips <text>      Inline IP/domain/CIDR list; supports whitespace, comma, semicolon and #labels
  --preferred-file <path>     Read preferred IP/domain/CIDR list from a local file
  --preferred-url <url>       Fetch a preferred IP/domain list before ranking
  --preferred-region <tag>    Optional region text filter, e.g. HK / JP / SG / US
  --preferred-strategy <mode> best / first / rotate / random, default best
  --enable-built-in-preferred <bool>
                             Include built-in and public Cloudflare candidates, default true when auto-picking
  --preferred-probe <bool>    Probe candidates before choosing best, default true
  --probe-rounds <n>          Probe rounds per candidate, default 2
  --probe-timeout-ms <ms>     Probe timeout, default 1800
  --probe-max <n>             Max ranked candidates to probe, default 16
  --probe-concurrency <n>     Probe concurrency, default 6
  --probe-cache-ms <ms>       Cache probe results inside this process, default 0
  --preferred-ip-only <bool>  Disable domain candidates when true, default false
  --preferred-domain-only <bool>
                             Disable literal IP candidates when true, default false
  --host-header <host>        Optional HTTP Host/SNI override
  --aead <name>               AEAD, default none
  --ascii <mode>              prefer_entropy / prefer_ascii / up_*_down_*, default prefer_entropy
  --packed-downlink <bool>    true enables packed downlink, default true
  --mux <mode>                off / auto / on, default off
  --node-name <name>          Clash node name, default sudoku-cf-worker
`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) usage();
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage();
    result[key.slice(2)] = value;
    i += 1;
  }
  return result;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  usage();
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const next = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, next));
}

function hasPreferredSource(args) {
  return Boolean(args["preferred-ips"] || args["preferred-file"] || args["preferred-url"]);
}

async function resolvePreferredAddress(args) {
  if (args["preferred-address"]) {
    return { address: args["preferred-address"], selected: null, count: 0, source: "explicit", error: "" };
  }

  const autoPreferred = parseBoolean(args["preferred-auto"], hasPreferredSource(args));
  if (!autoPreferred) {
    return { address: "", selected: null, count: 0, source: "", error: "" };
  }

  const inlineParts = [];
  if (args["preferred-ips"]) inlineParts.push(args["preferred-ips"]);
  if (args["preferred-file"]) inlineParts.push(readFileSync(args["preferred-file"], "utf8"));
  const pool = await loadPreferredIpPool({
    inlineList: inlineParts.join("\n"),
    sourceUrl: args["preferred-url"] || "",
    defaultPort: 443,
    cacheTtlMs: parseInteger(args["preferred-cache-ms"], 0, 0, 24 * 60 * 60 * 1000),
    enableBuiltIn: parseBoolean(args["enable-built-in-preferred"], true),
  });
  const eligible = filterPreferredEntries(pool.entries, {
    enableIPs: !parseBoolean(args["preferred-domain-only"], false),
    enableDomains: !parseBoolean(args["preferred-ip-only"], false),
    region: args["preferred-region"] || "",
  });
  const selected = await pickPreferredEntryWithProbe(
    eligible,
    normalizePreferredIpStrategy(args["preferred-strategy"] || "best"),
    `${args.host}|${args.key}`,
    {
      enabled: parseBoolean(args["preferred-probe"], true),
      rounds: parseInteger(args["probe-rounds"], 2, 1, 5),
      timeoutMs: parseInteger(args["probe-timeout-ms"], 1800, 300, 8000),
      maxCandidates: parseInteger(args["probe-max"], 16, 1, 64),
      concurrency: parseInteger(args["probe-concurrency"], 6, 1, 16),
      cacheTtlMs: parseInteger(args["probe-cache-ms"], 0, 0, 3600000),
    },
  );

  return {
    address: selected?.address || "",
    selected,
    count: eligible.length,
    source: pool.preferredSource,
    error: pool.preferredError,
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.host || !args.key) {
  usage();
}

const preferred = await resolvePreferredAddress(args);
const config = buildClientConfig({
  publicHost: args.host,
  serverAddress: preferred.address,
  key: args.key,
  localPort: args["local-port"] || "10233",
  pathRoot: args["path-root"] || "",
  httpMaskHost: args["host-header"] || (preferred.address ? args.host : ""),
  aead: args.aead || "none",
  ascii: args.ascii || "prefer_entropy",
  enablePureDownlink: !parseBoolean(args["packed-downlink"], true),
  httpMaskMultiplex: args.mux || "off",
});

const shortLink = buildShortLinkFromClientConfig(config);
const clash = buildClashNode(config, args["node-name"] || "sudoku-cf-worker-pure");

if (preferred.address) {
  const meta = preferred.selected?.probe
    ? `selected ${preferred.address} score=${preferred.selected.score} avg=${preferred.selected.probe.latencyMs ?? "-"}ms p95=${preferred.selected.probe.p95LatencyMs}ms mbps=${preferred.selected.probe.downloadMbps}`
    : `selected ${preferred.address}`;
  process.stderr.write(`[preferred] ${meta}; candidates=${preferred.count}${preferred.source ? ` source=${preferred.source}` : ""}\n`);
} else if (preferred.error) {
  process.stderr.write(`[preferred] no usable preferred ingress, fallback to host: ${preferred.error}\n`);
}

process.stdout.write(`${shortLink}\n\n`);
process.stdout.write(`${JSON.stringify(config, null, 2)}\n\n`);
process.stdout.write(clash);
