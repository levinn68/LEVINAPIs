// api/proxy.js (CommonJS - aman di Vercel)
const OWNER = "@levin68";
const THANKS = "Terima kasih sudah menggunakan LEVINAPIs.";

const ZEN_BASE = process.env.ZEN_BASE || "https://api.zenitsu.web.id";
const ALT_BASE = process.env.ALT_BASE || ""; // optional (isi kalau mau fallback/ganti provider tertentu)

const BLOCK_ENDPOINTS = ["xnxx", "seegore"];
const BLOCK_SUBSTRINGS = ["@krsna_081"];
const DROP_KEYS = new Set(["author", "attribution", "timestamp"]);

/**
 * RULES:
 * - Kalau ALT_BASE kosong, "alt" otomatis diskip.
 * - Kamu bisa ganti route tertentu ke provider lain tanpa nambah function.
 */
const ROUTE_RULES = [
  // Contoh override (aktifin kalau ALT_BASE udah kamu set di Vercel):
  // { match: /^\/api\/download\/capcut$/i, upstreams: ["alt", "zen"] },
  // { match: /^\/api\/download\/ytdl$/i, upstreams: ["zen", "alt"] }
];

// Default order kalau endpoint gak kena rule
const DEFAULT_UPSTREAMS = ["zen"]; // bisa jadi ["zen","alt"] kalau mau fallback global

const PROVIDERS = {
  zen: { base: ZEN_BASE, mapPath: (p) => p },
  alt: { base: ALT_BASE, mapPath: (p) => p } // kalau provider lain beda path, ubah di sini
};

function hasBlockedSubstring(s) {
  if (typeof s !== "string") return false;
  const low = s.toLowerCase();
  return BLOCK_SUBSTRINGS.some((b) => low.includes(String(b).toLowerCase()));
}

function sanitizeDeep(value) {
  if (typeof value === "string") {
    if (hasBlockedSubstring(value)) return undefined;
    return value;
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const v = sanitizeDeep(item);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      if (hasBlockedSubstring(k)) continue;

      const sv = sanitizeDeep(v);
      if (sv === undefined) continue;

      out[k] = sv;
    }
    return out;
  }

  return undefined;
}

function pickMainData(payload) {
  if (payload && typeof payload === "object") {
    if (payload.results !== undefined) return payload.results;
    if (payload.data !== undefined) return payload.data;
    if (payload.result !== undefined) return payload.result;
  }
  return payload;
}

function normalizePath(rawPath) {
  let p = String(rawPath || "").trim();
  if (!p.startsWith("/")) p = "/" + p;

  // optional support kalau ada yg kirim /apis/... ke backend
  if (p.startsWith("/apis/")) p = "/api/" + p.slice("/apis/".length);

  // ensure /api/...
  if (!p.startsWith("/api/")) p = "/api" + p;

  // cleanup double slashes
  return p.replace(/\/{2,}/g, "/");
}

function chooseUpstreams(remotePath) {
  for (const rule of ROUTE_RULES) {
    if (rule.match.test(remotePath)) {
      return rule.upstreams.filter((k) => PROVIDERS[k] && PROVIDERS[k].base);
    }
  }
  return DEFAULT_UPSTREAMS.filter((k) => PROVIDERS[k] && PROVIDERS[k].base);
}

async function fetchUpstream(providerKey, remotePath, queryObj) {
  const provider = PROVIDERS[providerKey];
  const mappedPath = provider.mapPath(remotePath);

  const u = new URL(provider.base + mappedPath);

  // forward query params
  for (const [k, v] of Object.entries(queryObj)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      u.searchParams.set(k, String(val));
    }
  }

  // fix ytdl: duplikat url -> query/q (buat upstream yg butuh)
  if (mappedPath.toLowerCase().startsWith("/api/download/ytdl")) {
    const urlParam = u.searchParams.get("url");
    if (urlParam) {
      if (!u.searchParams.get("query")) u.searchParams.set("query", urlParam);
      if (!u.searchParams.get("q")) u.searchParams.set("q", urlParam);
    }
  }

  const t0 = Date.now();
  const r = await fetch(u.toString(), {
    method: "GET",
    headers: { accept: "application/json,text/plain,*/*" }
  });
  const ms = Date.now() - t0;

  const ct = r.headers.get("content-type") || "";
  let payload;
  if (ct.includes("application/json")) {
    try {
      payload = await r.json();
    } catch {
      payload = { raw: await r.text() };
    }
  } else {
    payload = { raw: await r.text() };
  }

  return { r, payload, latency_ms: ms };
}

module.exports = async (req, res) => {
  try {
    const { path, ...rest } = req.query || {};
    if (!path) {
      return res.status(400).json({
        code: 400,
        success: false,
        status: "error",
        owner: OWNER,
        message: THANKS,
        error: 'Missing "path". Example: /api/download/tiktok?url=...'
      });
    }

    const rawPath = Array.isArray(path) ? path[0] : path;
    const remotePath = normalizePath(rawPath);

    // block endpoint tertentu
    const low = remotePath.toLowerCase();
    if (BLOCK_ENDPOINTS.some((x) => low.includes(x))) {
      return res.status(403).json({
        code: 403,
        success: false,
        status: "error",
        owner: OWNER,
        message: THANKS,
        endpoint: remotePath,
        error: "Endpoint diblokir."
      });
    }

    const upstreams = chooseUpstreams(remotePath);

    let lastError = null;
    for (const key of upstreams) {
      try {
        const { r, payload, latency_ms } = await fetchUpstream(key, remotePath, rest);

        const cleaned = sanitizeDeep(payload);
        const mainData = sanitizeDeep(pickMainData(cleaned));

        const bodyStatus =
          cleaned && typeof cleaned === "object" && typeof cleaned.statusCode === "number"
            ? cleaned.statusCode
            : r.status;

        const ok = r.ok && bodyStatus >= 200 && bodyStatus < 300;

        if (!ok) {
          const errMsg =
            (cleaned && typeof cleaned === "object" && (cleaned.error || cleaned.message)) ||
            "Request failed";
          lastError = { code: bodyStatus || 500, provider: key, error: String(errMsg) };
          continue;
        }

        return res.status(200).json({
          code: 200,
          success: true,
          status: "success",
          owner: OWNER,
          message: THANKS,
          provider: key,
          endpoint: remotePath,
          latency_ms,
          data: mainData ?? {}
        });
      } catch (e) {
        lastError = { code: 500, provider: key, error: String(e?.message || e) };
        continue;
      }
    }

    return res.status(lastError?.code || 500).json({
      code: lastError?.code || 500,
      success: false,
      status: "error",
      owner: OWNER,
      message: THANKS,
      endpoint: remotePath,
      provider: lastError?.provider || null,
      error: lastError?.error || "Upstream failed"
    });
  } catch (e) {
    return res.status(500).json({
      code: 500,
      success: false,
      status: "error",
      owner: OWNER,
      message: THANKS,
      error: String(e?.message || e)
    });
  }
};
