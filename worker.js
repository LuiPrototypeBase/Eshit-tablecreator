const APP_UA = "AkaishiTableGenerator/1.0 (https://github.com/your-name/akaishi-generator)";
const SEARCH_CACHE_VERSION = "v4";
const SEARCH_TTL_SECONDS = 60 * 60 * 24;
const IMAGE_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "akaishi-worker" });
    }

    if (url.pathname === "/api/debug/auth") {
      return debugAuth(env);
    }

    if (url.pathname === "/api/search" && request.method === "POST") {
      return searchBangumi(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/subject/") && request.method === "GET") {
      return getSubject(url, env, ctx);
    }

    if (url.pathname === "/api/image" && request.method === "GET") {
      return proxyImage(request, ctx);
    }

    return json({ error: "Not found" }, 404);
  }
};

async function searchBangumi(request, env, ctx) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const keyword = String(payload.keyword || "").trim();
  if (!keyword) return json({ error: "Keyword is required" }, 400);
  const type = clampSubjectType(payload.type);
  const includeNsfw = Boolean(payload.nsfw);
  const limit = clampNumber(payload.limit, 20, 1, 50);
  const offset = clampNumber(payload.offset, 0, 0, 1000);

  const cache = caches.default;
  const cacheKey = new Request(`https://akaishi.cache/${SEARCH_CACHE_VERSION}/search/${encodeURIComponent(keyword.toLowerCase())}/${type}/${includeNsfw ? "nsfw" : "sfw"}/${limit}/${offset}`);
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  if (includeNsfw) {
    return searchNsfwSubjects({ keyword, type, limit, offset, env, ctx, cacheKey });
  }

  return searchV0Subjects({ keyword, type, includeNsfw, limit, offset, env, ctx, cacheKey });
}

async function searchV0Subjects({ keyword, type, includeNsfw, limit, offset, env, ctx, cacheKey }) {
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": env.BANGUMI_USER_AGENT || APP_UA
  };
  if (env.BANGUMI_TOKEN) {
    headers.Authorization = `Bearer ${env.BANGUMI_TOKEN}`;
  }

  const upstream = await fetch(`https://api.bgm.tv/v0/search/subjects?limit=${limit}&offset=${offset}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      keyword,
      filter: {
        type: [type],
        nsfw: includeNsfw
      },
      sort: "match"
    })
  });

  const data = await upstream.text();
  const response = withCors(new Response(data, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${SEARCH_TTL_SECONDS}`,
      "X-Search-Source": "v0"
    }
  }));

  if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function searchNsfwSubjects({ keyword, type, limit, offset, env, ctx, cacheKey }) {
  const [v0Result, legacyResult] = await Promise.all([
    fetchV0Payload({ keyword, type, includeNsfw: true, limit, offset, env }),
    fetchLegacyPayload({ keyword, type, limit, offset, env })
  ]);

  const merged = mergeSearchPayloads(v0Result.payload, legacyResult.payload);
  const response = withCors(new Response(JSON.stringify(merged), {
    status: v0Result.ok || legacyResult.ok ? 200 : 502,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${SEARCH_TTL_SECONDS}`,
      "X-Search-Source": "v0+legacy"
    }
  }));

  if (v0Result.ok || legacyResult.ok) ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

async function fetchV0Payload({ keyword, type, includeNsfw, limit, offset, env }) {
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": env.BANGUMI_USER_AGENT || APP_UA
  };
  if (env.BANGUMI_TOKEN) {
    headers.Authorization = `Bearer ${env.BANGUMI_TOKEN}`;
  }

  const upstream = await fetch(`https://api.bgm.tv/v0/search/subjects?limit=${limit}&offset=${offset}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      keyword,
      filter: {
        type: [type],
        nsfw: includeNsfw
      },
      sort: "match"
    })
  });
  const payload = await upstream.json().catch(() => ({ data: [], total: 0, limit, offset }));
  return { ok: upstream.ok, payload };
}

async function searchLegacySubjects({ keyword, type, limit, offset, env, ctx, cacheKey }) {
  const result = await fetchLegacyPayload({ keyword, type, limit, offset, env });
  const response = withCors(new Response(JSON.stringify(result.payload), {
    status: result.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${SEARCH_TTL_SECONDS}`,
      "X-Search-Source": "legacy"
    }
  }));

  if (result.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function fetchLegacyPayload({ keyword, type, limit, offset, env }) {
  const maxResults = Math.min(limit, 25);
  const url = new URL(`https://api.bgm.tv/search/subject/${encodeURIComponent(keyword)}`);
  url.searchParams.set("type", String(type));
  url.searchParams.set("responseGroup", "large");
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("start", String(offset));
  if (env.BANGUMI_TOKEN) {
    url.searchParams.set("access_token", env.BANGUMI_TOKEN);
  }

  const headers = {
    "Accept": "application/json",
    "User-Agent": env.BANGUMI_USER_AGENT || APP_UA
  };
  if (env.BANGUMI_TOKEN) {
    headers.Authorization = `Bearer ${env.BANGUMI_TOKEN}`;
  }

  const upstream = await fetch(url.toString(), { headers });
  const legacy = await upstream.json().catch(() => null);
  const payload = legacy
    ? {
        data: legacy.list || [],
        total: legacy.results || legacy.list?.length || 0,
        limit: maxResults,
        offset
      }
    : { data: [], total: 0, limit: maxResults, offset };

  return { ok: upstream.ok, status: upstream.status, payload };
}

function mergeSearchPayloads(...payloads) {
  const seen = new Set();
  const data = [];
  let total = 0;
  let limit = 20;
  let offset = 0;

  for (const payload of payloads) {
    if (!payload) continue;
    total = Math.max(total, payload.total || payload.results || 0);
    limit = payload.limit || limit;
    offset = payload.offset || offset;
    for (const item of payload.data || payload.list || []) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      data.push(item);
    }
  }

  return {
    data,
    total: Math.max(total, data.length),
    limit,
    offset
  };
}

async function getSubject(url, env, ctx) {
  const id = url.pathname.split("/").pop();
  if (!/^\d+$/.test(id)) return json({ error: "Invalid subject id" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(`https://akaishi.cache/subject/${id}`);
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const headers = {
    "Accept": "application/json",
    "User-Agent": env.BANGUMI_USER_AGENT || APP_UA
  };
  if (env.BANGUMI_TOKEN) {
    headers.Authorization = `Bearer ${env.BANGUMI_TOKEN}`;
  }

  const upstream = await fetch(`https://api.bgm.tv/v0/subjects/${id}`, { headers });
  const data = await upstream.text();
  const response = withCors(new Response(data, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${SEARCH_TTL_SECONDS}`
    }
  }));
  if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function debugAuth(env) {
  const hasToken = Boolean(env.BANGUMI_TOKEN);
  if (!hasToken) {
    return json({ hasToken: false, meOk: false });
  }

  try {
    const response = await fetch("https://api.bgm.tv/v0/me", {
      headers: {
        "Accept": "application/json",
        "User-Agent": env.BANGUMI_USER_AGENT || APP_UA,
        "Authorization": `Bearer ${env.BANGUMI_TOKEN}`
      }
    });
    const data = await response.json().catch(() => ({}));
    return json({
      hasToken: true,
      meOk: response.ok,
      status: response.status,
      username: data.username || data.nickname || null
    });
  } catch (error) {
    return json({
      hasToken: true,
      meOk: false,
      error: String(error)
    }, 502);
  }
}

async function proxyImage(request, ctx) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "";
  if (!target.startsWith("https://") && !target.startsWith("http://")) {
    return json({ error: "Invalid image url" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://akaishi.cache/image/${encodeURIComponent(target)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const upstream = await fetch(target, {
    headers: { "User-Agent": APP_UA }
  });
  if (!upstream.ok) {
    return json({ error: "Image upstream unavailable" }, 502);
  }

  const contentLength = Number(upstream.headers.get("Content-Length") || "0");
  if (contentLength > MAX_IMAGE_BYTES) {
    return json({ error: "Image is too large" }, 413);
  }

  const response = withCors(new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": `public, max-age=${IMAGE_TTL_SECONDS}`
    }
  }));
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(payload, status = 200) {
  return withCors(new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  }));
}

function withCors(response) {
  const result = new Response(response.body, response);
  result.headers.set("Access-Control-Allow-Origin", "*");
  result.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  result.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return result;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function clampSubjectType(value) {
  const type = Number(value);
  return [1, 2, 4, 6].includes(type) ? type : 2;
}
