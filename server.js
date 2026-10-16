// BTC2B converter app server. No dependencies. Serves the page and a cached price endpoint.
// Binance is called lazily: a request that arrives when the cached rate is older than 60 s
// triggers one new call, concurrent requests share it.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || "60", 10) * 1000;
const RETRY_AFTER_FAIL_MS = 10000;
const SYMBOLS = encodeURIComponent('["BTCEUR","BTCUSDT"]');
const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

const page = fs.readFileSync(path.join(__dirname, "index.html"));

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
};

let cache = null;          // { eur, usd, fetchedAt, source }
let inflight = null;
let lastFailAt = 0;

async function fetchFrom(host) {
  const res = await fetch(`${host}/api/v3/ticker/price?symbols=${SYMBOLS}`, {
    signal: AbortSignal.timeout(4000),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${host} HTTP ${res.status}`);
  const rows = await res.json();
  const m = {};
  for (const r of rows) m[r.symbol] = parseFloat(r.price);
  if (!(m.BTCEUR > 0) || !(m.BTCUSDT > 0)) throw new Error(`${host} missing pair`);
  return { eur: m.BTCEUR, usd: m.BTCUSDT, fetchedAt: Date.now(), source: new URL(host).hostname };
}

async function refresh() {
  let lastErr;
  for (const host of HOSTS) {
    try {
      cache = await fetchFrom(host);
      lastFailAt = 0;
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  lastFailAt = Date.now();
  throw lastErr;
}

async function getRates() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return { ...cache, stale: false };

  // During an outage, retry at most every 10 s instead of on every request.
  if (lastFailAt && now - lastFailAt < RETRY_AFTER_FAIL_MS) {
    if (cache) return { ...cache, stale: true };
    throw new Error("upstream unavailable");
  }

  if (!inflight) inflight = refresh().finally(() => { inflight = null; });
  try {
    await inflight;
    return { ...cache, stale: false };
  } catch (e) {
    if (cache) return { ...cache, stale: true };
    throw e;
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { Allow: "GET, HEAD" }, "");
    }

    if (url.pathname === "/healthz") {
      return send(res, 200, { "Content-Type": "text/plain" }, "ok\n");
    }

    if (url.pathname === "/api/price") {
      try {
        const r = await getRates();
        return send(
          res,
          200,
          { "Content-Type": "application/json", "Cache-Control": "no-store" },
          JSON.stringify({
            eur: r.eur,
            usd: r.usd,
            time: new Date(r.fetchedAt).toISOString(),
            stale: r.stale,
            source: r.source,
          })
        );
      } catch (e) {
        return send(res, 503, { "Content-Type": "application/json", "Cache-Control": "no-store" }, JSON.stringify({ error: "rates unavailable" }));
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return send(res, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }, req.method === "HEAD" ? "" : page);
    }

    return send(res, 404, { "Content-Type": "text/plain" }, "Not found\n");
  })
  .listen(PORT, "0.0.0.0", () => console.log(`btc2b-converter listening on :${PORT}`));
