# Sudoku Pure Cloudflare Worker 部署

纯 Cloudflare Worker 的 Sudoku 服务端实现。

- `httpmask.mode = ws`
- `tls = true`
- `aead = none`
- 官方 Go 客户端 `ws` early-handshake（`ed` / `X-Sudoku-Early`）
- 默认 `enable_pure_downlink = false` 的 packed downlink
- 显式开启 `enable_pure_downlink = true`
- `OpenTCP`
- `StartMux` / HTTPMask session mux
- `ascii` 对称模式和方向模式：`prefer_entropy`、`prefer_ascii`、`up_*_down_*`
- 导出时动态优选 IP：支持手动列表、远程列表 URL、可选 KV 管理
- 可选 KV 持久化优选池，并提供 API 管理入口



## 目录说明

- `cf-worker/wrangler.toml`
- `cf-worker/src/go-rand.mjs`
- `cf-worker/src/sudoku-table.mjs`
- `cf-worker/src/sudoku-packed.mjs`
- `cf-worker/src/sudoku-protocol.mjs`
- `cf-worker/src/sudoku-config.mjs`
- `cf-worker/src/index.mjs`
- `cf-worker/tools/build-shortlink.mjs`
- `cf-worker/tools/build-one-line-worker.mjs`
- `cf-worker/dashboard/sudoku-worker.one.js`

## 部署步骤

1. 把当前仓库推到你自己的 GitHub 仓库。
2. 在 Cloudflare 控制台进入 `Workers 和 Pages`。
3. 选择 `导入存储库`。
4. 选择这个仓库。
5. 构建根目录选 `cf-worker`。
6. 兼容性日期设为 `2026-01-20`。
7. 部署。

## 无 GitHub 的一行 JS 部署

如果你没有 GitHub，可以直接用 Cloudflare Dashboard 里的 Hello World Worker：

1. 进入 `Workers 和 Pages`。
2. 点 `Create`，创建一个 Hello World Worker。
3. 把编辑器里的默认代码全部删掉。
4. 打开仓库里的 `cf-worker/dashboard/sudoku-worker.one.js`，复制整行内容粘进去。
5. 在 Worker 的 `Settings -> Variables` 里按下面的环境变量表配置。
6. 保存并部署。

如果后续你改了 `cf-worker/src` 下的源码，可以重新生成一行版：

```bash
node cf-worker/tools/build-one-line-worker.mjs
```

## 必填环境变量

| 变量名 | 示例 | 说明 |
| --- | --- | --- |
| `SUDOKU_KEY` | `my-shared-key` | 共享 key |

## 推荐环境变量

| 变量名 | 示例 | 说明 |
| --- | --- | --- |
| `SUDOKU_MANAGE_TOKEN` | `my-secret` | 管理页路径令牌 |
| `SUDOKU_PUBLIC_HOST` | `sudoku.example.com` | 对外给客户端展示的域名 |
| `SUDOKU_HTTP_MASK_PATH_ROOT` | `/aabbcc` | 可选固定 WS 路径前缀；未设置时会按 `SUDOKU_KEY` 稳定派生随机 `6-10` 位小写字母并以 `/` 开头导出 |
| `SUDOKU_PREFERRED_IP_URL` | `https://example.com/cf-ips.txt` | 可选，远程优选 IP 列表；每次打开管理页或 `/shortlink` `/client.json` 时都会重新拉取 |
| `SUDOKU_PREFERRED_IP_STRATEGY` | `best` | `best / first / rotate / random`，默认 `best`；优先按 `score`，其次按更低延迟、更高速度 |
| `SUDOKU_PREFERRED_IP_CACHE_MS` | `60000` | 远程优选列表缓存毫秒数，默认 60 秒 |
| `SUDOKU_PREFERRED_IP_KV_KEY` | `sudoku:preferred_ips` | 可选，KV 中保存优选池的 key |
| `SUDOKU_ENABLE_BUILTIN_PREFERRED` | `true` | 默认开启内置优选；未显式配置优选源时，会自动抓取可直接使用的 Cloudflare 优选 IP 列表，失败时回退到你的域名 |
| `SUDOKU_ENABLE_PREFERRED_PROBE` | `true` | 导出短链接前主动探测候选入口，按延迟、P95、失败次数和估算吞吐综合选择最优 |
| `SUDOKU_PREFERRED_PROBE_ROUNDS` | `2` | 每个候选的探测轮数，范围 `1-5` |
| `SUDOKU_PREFERRED_PROBE_TIMEOUT_MS` | `1800` | 单次探测超时，范围 `300-8000` 毫秒 |
| `SUDOKU_PREFERRED_PROBE_MAX` | `16` | 每次最多探测静态排序靠前的候选数 |
| `SUDOKU_PREFERRED_PROBE_CONCURRENCY` | `6` | 探测并发数 |
| `SUDOKU_PREFERRED_PROBE_CACHE_MS` | `300000` | 探测结果缓存毫秒数，避免每次打开短链都重新测速 |
| `SUDOKU_CLIENT_PORT` | `10233` | 导出的客户端本地 mixed 端口 |
| `SUDOKU_HTTP_MASK_HOST` | `cdn.example.com` | 可选，覆盖客户端 Host/SNI |
| `SUDOKU_NODE_NAME` | `sudoku-cf-worker-pure` | Clash 节点名 |
| `SUDOKU_AEAD` | `none` | 默认 `none` |
| `SUDOKU_ASCII` | `prefer_entropy` | 也支持 `prefer_ascii`、`up_ascii_down_entropy`、`up_entropy_down_ascii` |
| `SUDOKU_CUSTOM_TABLE` | `xpxvvpvv` | 可选，自定义表 |
| `SUDOKU_ENABLE_PURE_DOWNLINK` | `false` | 默认 packed downlink；设为 `true` 时导出 pure downlink 客户端配置 |
| `SUDOKU_HTTP_MASK_MULTIPLEX` | `off` | 默认关闭 mux；也支持 `off / auto / on` |



## 部署后路径

假设：

- 域名是 `sudoku.example.com`
- `SUDOKU_MANAGE_TOKEN=my-secret`
- 未显式设置 `SUDOKU_HTTP_MASK_PATH_ROOT`，按 key 稳定派生出一个随机段，例如 `/aabbcc`

则：

- WS 入口：`wss://sudoku.example.com/aabbcc/ws`
- 管理页：`https://sudoku.example.com/my-secret`
- 短链接：`https://sudoku.example.com/my-secret/shortlink`
- 客户端 JSON：`https://sudoku.example.com/my-secret/client.json`
- Clash 配置：`https://sudoku.example.com/my-secret/clash.yaml`

如果同时设置了：

- `SUDOKU_PREFERRED_IP_URL=https://example.com/cf-ips.txt`

而远程列表第一条是：

- `198.41.192.27:443#HKG`

则网页导出的节点会变成：

- `server_address = 198.41.192.27:443`
- `httpmask.host = sudoku.example.com`
- `tls = true`

也就是说，客户端实际连优选 IP，但 `Host/SNI` 仍然走你的域名。

如果你没有设置 `SUDOKU_PREFERRED_IPS`、`SUDOKU_PREFERRED_IP_URL`，也没有通过 KV API 写入优选池，Worker 会默认抓取一组可直接使用的 Cloudflare 优选 IP 并导出；抓取失败时才回退到你的 `SUDOKU_PUBLIC_HOST`。如果你不想用这个默认行为，可以把 `SUDOKU_ENABLE_BUILTIN_PREFERRED=false`。


## 本地生成短链接

纯 downlink：

```bash
node cf-worker/tools/build-shortlink.mjs \
  --host sudoku.example.com \
  --preferred-address 198.41.192.27:443 \
  --key 'my-shared-key' \
  --aead none \
  --packed-downlink false \
  --node-name sudoku-cf-worker-pure
```

packed downlink + mux：

```bash
node cf-worker/tools/build-shortlink.mjs \
  --host sudoku.example.com \
  --preferred-address 198.41.192.27:443 \
  --key 'my-shared-key' \
  --aead none \
  --packed-downlink true \
  --mux on \
  --node-name sudoku-cf-worker-packed
```

自动优选并输出短链接：

```bash
node cf-worker/tools/build-shortlink.mjs \
  --host sudoku.example.com \
  --key 'my-shared-key' \
  --preferred-auto true \
  --aead none \
  --packed-downlink true
```
