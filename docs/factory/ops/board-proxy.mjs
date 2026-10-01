#!/usr/bin/env node
// factory board를 tailnet에서 보기 위한 평문 HTTP 프록시.
//
// `factory board`는 루프백(127.0.0.1)에만 묶인다 — gh CLI의 권한으로 프라이빗 저장소를 읽기 때문에 그 경계를 넓히지
// 않는다(ADR-032). 다른 기기에서 보려면 이 프록시를 Tailscale IP에 묶어 띄운다. `tailscale serve --http`는 Host 헤더로
// 라우팅해 IP:port 접근이 404가 나므로(2026-10-01 실측) 쓰지 않는다. SSE(`/api/events`)는 그대로 흘려보낸다.
//
//   node docs/factory/ops/board-proxy.mjs <tailscale-ip> [port] [upstream-port]
//   예: node docs/factory/ops/board-proxy.mjs "$(tailscale ip -4)" 4173
//
// tailnet 밖에서는 닿지 않는다. 그래도 인증은 없다 — 같은 tailnet의 누구나 보드(= 이 기기 gh가 읽는 것)를 본다.
import { createServer, request } from "node:http";

const BIND = process.argv[2];
const PORT = Number(process.argv[3] || 4173);
const UPSTREAM = Number(process.argv[4] || PORT);
if (!BIND || !/^100\.\d+\.\d+\.\d+$/.test(BIND)) {
  console.error("usage: board-proxy.mjs <tailscale-ip (100.x.y.z)> [port=4173] [upstream-port=port]");
  process.exit(2);
}

createServer((req, res) => {
  const up = request(
    { host: "127.0.0.1", port: UPSTREAM, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM}` } },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
  );
  up.on("error", (e) => { res.writeHead(502, { "content-type": "text/plain" }); res.end(`board upstream unavailable: ${e.message}`); });
  req.pipe(up);
}).listen(PORT, BIND, () => console.log(`board proxy http://${BIND}:${PORT} → http://127.0.0.1:${UPSTREAM}`));
