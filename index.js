const os = require("os");
const fs = require("fs");
const path = require("path");
const { addonBuilder } = require("stremio-addon-sdk");

const DEBUG = !!process.env.DEBUG;
const SHOW_NOT_WEB_READY = true;
const MIN_MINUTES = 60;
const MIN_EPISODE_MINUTES = 8;
const MAX_RESULTS = Infinity;
const MIN_PERCENT = 50;
const MOVIE_CANDIDATES = 15;
const SERIES_CANDIDATES = 30;
const CONCURRENCY = 6;
const RUNTIME_LOW = 0.85;
const RUNTIME_HIGH = 1.15;
const EP_LOW = 0.6;
const EP_HIGH = 1.7;
const CACHE_MS = 6 * 60 * 60 * 1000;
const CINEMETA = "https://v3-cinemeta.strem.io";
const PORT = process.env.PORT || 7000;
const TIMEOUT_MS = 12000;
const ARCHIVE_API = (process.env.ARCHIVE_API || "https://archive.org").replace(/\/+$/, "");
const ARCHIVE_KEY = process.env.ARCHIVE_KEY || "";

// ---------- Result cache ----------
const DB_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const CACHE_DIR = process.env.CACHE_DIR || "";
const DB_ON = !!(DB_URL && DB_TOKEN) || !!CACHE_DIR;
const cacheFile = (id) => path.join(CACHE_DIR, String(id).replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");
const KEEP_DAYS = Number(process.env.KEEP_DAYS) || 0;
const DB_TTL_SECONDS = KEEP_DAYS ? Math.round(KEEP_DAYS * 24 * 60 * 60) : 0;
const DB_REUSE_MS = KEEP_DAYS ? DB_TTL_SECONDS * 1000 : Infinity;
const REFRESH_AFTER_MS = (Number(process.env.REFRESH_AFTER_HOURS) || 6) * 60 * 60 * 1000;

async function dbPipeline(cmds) {
  if (!DB_ON) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(DB_URL + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + DB_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(cmds),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    const c = e.cause && (e.cause.code || e.cause.message);
    console.log("  database error: " + e.message + (c ? " (" + c + ")" : ""));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function dbGet(id) {
  if (CACHE_DIR) {
    try { return JSON.parse(fs.readFileSync(cacheFile(id), "utf8")); } catch (e) { return null; }
  }
  const out = await dbPipeline([["GET", "ia:search:" + id]]);
  const raw = out && out[0] && out[0].result;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function dbSave(rec) {
  if (CACHE_DIR) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile(rec.id), JSON.stringify(rec, null, 2));
    } catch (e) { console.log("  cache file error: " + e.message); }
    return Promise.resolve();
  }
  const cmd = ["SET", "ia:search:" + rec.id, JSON.stringify(rec)];
  if (DB_TTL_SECONDS) cmd.push("EX", DB_TTL_SECONDS);
  return dbPipeline([cmd]);
}
function fmtAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function markCached(streams, at, refreshing) {
  const line = `⚡  Cached · ${fmtAgo(Date.now() - at)}${refreshing ? " · refreshing" : ""}`;
  return streams.map((x) => ({ ...x, title: `${x.title}\n${line}` }));
}
function dbDelete(id) {
  if (CACHE_DIR) {
    try { fs.unlinkSync(cacheFile(id)); } catch (e) {}
    return Promise.resolve();
  }
  return dbPipeline([["DEL", "ia:search:" + id]]);
}
// ---------- end cache ----------

const BAD_WORDS = /\b(trailers?|teasers?|clips?|scenes?|behind the scenes|making of|interviews?|podcast|commentary|review|reviews|reaction|soundtrack|score|gameplay|compilation|promo|tv spot)\b/i;

const EXT_RANK = { mp4: 0, m4v: 1, webm: 2, mov: 3, mkv: 4, avi: 5, wmv: 6, ogv: 7 };
const NOT_WEB_READY = new Set(["mkv", "avi", "ogv", "wmv", "flv", "mpg", "mpeg", "mov"]);

// Les 4 types de HDR gérés individuellement
const HDR_TYPES = ["HDR10", "HDR10+", "DV", "10bit"];

const manifest = {
  id: "org.example.archivemoviesearch",
  version: "1.7.9",
  name: "Archive-DZ",
  description: "🎬 Films et séries en streaming depuis Internet Archive — Public domain & contenus libres, avec tri par langue, qualité et taille.",
  logo: "https://i.pinimg.com/1200x/fb/0d/cc/fb0dccec209770b71f8570c3bb8a38b7.jpg",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

// "&" counts as "and"
const norm = (s) =>
  String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const normTitle = (s) => norm(s).replace(/^the /, "");
const squash = (s) => normTitle(s).replace(/ /g, "");

const STOP = new Set(["the", "and", "of", "an", "to", "in", "is", "it", "for", "on", "with", "at", "by", "from"]);

const nameWords = (name) => [...new Set(normTitle(name).split(" ").filter((w) => w.length >= 2 && !STOP.has(w)))];
const needWords = (n) => (n < 3 ? n : Math.ceil(n * 0.66));

function titleIn(text, name, loose) {
  const want = normTitle(name);
  if (!want) return false;
  const hay = ` ${normTitle(text)} `;
  if (hay.includes(` ${want} `)) return true;
  const sq = want.replace(/ /g, "");
  if (sq.length >= 7 && hay.replace(/ /g, "").includes(sq)) return true;
  if (!loose) return false;
  const toks = nameWords(name);
  if (toks.length < 3) return false;
  const words = new Set(hay.trim().split(" "));
  return toks.filter((w) => words.has(w)).length >= needWords(toks.length);
}

function stripName(title, name) {
  let s = normTitle(title);
  const want = normTitle(name);
  if (want) s = s.replace(want, " ");
  const sq = squash(name);
  if (sq) s = s.replace(sq, " ");
  return s;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const pad2 = (n) => String(n).padStart(2, "0");
const asText = (v) => (Array.isArray(v) ? v.join(" ") : String(v || ""));

function parseRuntime(r) {
  if (!r) return null;
  const s = String(r).toLowerCase();
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (h || m) return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  const n = s.match(/\d+/);
  return n ? +n[0] : null;
}

function parseLengthMins(len) {
  if (!len) return null;
  const s = String(len);
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    if (p.some(isNaN)) return null;
    return p.reduce((acc, x) => acc * 60 + x, 0) / 60;
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n / 60;
}

function fmtMins(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? `${h}h ${pad2(m)}m` : `${m}m`;
}

function fmtSize(bytes) {
  const n = Number(bytes);
  if (!n) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  return Math.round(n / 1e6) + " MB";
}

function fmtCount(n) {
  if (!n) return "";
  return new Intl.NumberFormat("en", { notation: "compact" }).format(n);
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = ARCHIVE_KEY && ARCHIVE_API !== "https://archive.org" && url.startsWith(ARCHIVE_API) ? { "x-relay-key": ARCHIVE_KEY } : {};
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    const c = e.cause && (e.cause.code || e.cause.message);
    if (c) e.message += ` (${c})`;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getMeta(type, imdbId) {
  const { meta } = await fetchJson(`${CINEMETA}/meta/${type}/${imdbId}.json`);
  return meta || null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Internet Archive search ----------
const phrase = (s) => String(s || "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();

async function archiveQuery(q, rows) {
  const params = new URLSearchParams();
  params.set("q", q);
  for (const f of ["identifier", "title", "year", "downloads", "language", "subject", "description"]) {
    params.append("fl[]", f);
  }
  params.append("sort[]", "downloads desc");
  params.set("rows", String(rows));
  params.set("output", "json");
  const data = await fetchJson(`${ARCHIVE_API}/advancedsearch.php?${params}`);
  return data?.response?.docs || [];
}

async function searchArchive(name, series, imdbId) {
  const n = phrase(name);
  const jobs = [];

  const variants = [
    n,
    n.replace(/&/g, "and").replace(/\s+/g, " ").trim(),
    n.replace(/^the\s+/i, ""),
    n.replace(/\s*(&|\band\b)\s*/gi, " ").replace(/\s+/g, " ").trim(),
  ].filter((v, i, a) => v.length >= 3 && a.indexOf(v) === i);
  for (const v of variants) jobs.push({ q: `title:"${v}" AND mediatype:movies`, imdb: false });

  const sq = squash(name);
  if (sq.length >= 7) jobs.push({ q: `title:${sq}* AND mediatype:movies`, imdb: false });

  const words = nameWords(name);
  if (words.length >= 3) {
    const top = [...words].sort((a, b) => b.length - a.length).slice(0, needWords(words.length));
    jobs.push({ q: `title:(${top.join(" AND ")}) AND mediatype:movies`, imdb: false });
  }

  jobs.push({ q: `"${n}" AND mediatype:movies`, imdb: false });

  if (series && phrase(series.epTitle).length >= 4) {
    jobs.push({ q: `title:"${phrase(series.epTitle)}" AND "${n}" AND mediatype:movies`, imdb: false });
  }
  if (/^tt\d+$/.test(imdbId || "")) {
    jobs.push({ q: `"${imdbId}" AND mediatype:movies`, imdb: true });
    jobs.push({ q: `external-identifier:"urn:imdb:${imdbId}" AND mediatype:movies`, imdb: true });
  }
  let failed = 0;
  const lists = await Promise.all(
    jobs.map((j) =>
      archiveQuery(j.q, series ? 50 : 40)
        .catch((e) => {
          failed++;
          console.log(`  search failed (${j.q}): ${e.message}`);
          return [];
        })
        .then((list) => list.map((d) => ({ ...d, imdb: j.imdb })))
    )
  );
  const seen = new Map();
  for (const list of lists) {
    for (const d of list) {
      const prev = seen.get(d.identifier);
      if (!prev) seen.set(d.identifier, d);
      else if (d.imdb) prev.imdb = true;
    }
  }
  const out = [...seen.values()];
  out.failed = failed;
  return out;
}

function videoFiles(files) {
  return files
    .map((f) => {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      return { f, ext, mins: parseLengthMins(f.length) };
    })
    .filter(
      ({ f, ext }) =>
        ext in EXT_RANK &&
        f.source !== "metadata" &&
        !/_thumb|sample|trailer/i.test(f.name.split("/").pop()) &&
        !BAD_WORDS.test(norm(f.name.split("/").pop()))
    );
}

const byQuality = (a, b) =>
  (a.mins === null) - (b.mins === null) ||
  EXT_RANK[a.ext] - EXT_RANK[b.ext] ||
  (Number(b.f.size) || 0) - (Number(a.f.size) || 0);

// ----- movies -----
const MAX_PER_ITEM = 25;

const imdbTag = (fileName) => {
  const m = String(fileName).match(/(?<![a-z0-9])tt\d{7,9}(?!\d)/i);
  return m ? m[0].toLowerCase() : "";
};

function pickMovieFile(files, runtime, verify, name, imdbId, trusted) {
  if (verify && !runtime) return [];
  const lo = runtime ? runtime * RUNTIME_LOW : MIN_MINUTES;
  const hi = runtime ? runtime * RUNTIME_HIGH : Infinity;
  let inRange = videoFiles(files).filter(({ mins }) => (mins === null ? !runtime : mins >= lo && mins <= hi));

  const want = String(imdbId || "").toLowerCase();
  if (want) {
    const tag = ({ f }) => imdbTag(f.name.split("/").pop());
    inRange = inRange.filter((v) => !tag(v) || tag(v) === want);
    const exact = inRange.filter((v) => tag(v) === want);
    if (exact.length > MAX_PER_ITEM) return [];
    if (exact.length) inRange = exact;
  }
  inRange.sort(byQuality);
  if (name && inRange.length > 3) {
    const named = inRange.filter(({ f }) => titleIn(f.name, name, false));
    inRange = named.length || !(trusted && inRange.length <= 8) ? named : inRange;
  }
  return inRange.slice(0, MAX_PER_ITEM);
}

// ----- episodes -----
function epTitleMatches(text, epTitle) {
  const full = norm(epTitle);
  const toks = full.split(" ").filter((w) => w.length >= 2 && !STOP.has(w));
  if (!toks.length || full.length < 4) return false;
  const hay = ` ${norm(text)} `;
  if (hay.includes(` ${full} `)) return true;
  const hit = toks.filter((w) => hay.includes(` ${w} `)).length;
  if (toks.length === 1) return toks[0].length >= 6 && hit === 1;
  return hit >= 2 && hit / toks.length >= 0.8;
}

function seasonOf(str) {
  const m = String(str || "").replace(/[._]+/g, " ").match(/(?<![a-z])(?:season|series|s)\s*(\d{1,2})(?![a-z0-9])/i);
  return m ? +m[1] : null;
}

function parseRefs(path) {
  const parts = String(path || "").split("/");
  const base = parts.pop().replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[._]+/g, " ");
  const dirSeason = seasonOf(parts.join(" "));
  const cands = [];

  const re1 = /(?<![a-z])s(\d{1,2})\s*-?\s*e(?:p)?\s*(\d{1,3})(?:(?:\s*&\s*e?|-e?|–e?|e)(\d{1,3}))?(?!\d)/gi;
  for (const m of base.matchAll(re1)) cands.push({ s: +m[1], e: +m[2], e2: m[3] ? +m[3] : null, explicit: true });

  const re2 = /(?<![a-z0-9])(\d{1,2})x(\d{1,3})(?![a-z0-9])/gi;
  for (const m of base.matchAll(re2)) cands.push({ s: +m[1], e: +m[2], e2: null, explicit: true });

  const re3 = /(?<![a-z])(?:season|series)\s*(\d{1,2}).{0,40}?(?<![a-z])(?:episode|ep)\s*(\d{1,3})(?!\d)/i;
  const m3 = base.match(re3);
  if (m3) cands.push({ s: +m3[1], e: +m3[2], e2: null, explicit: true });

  if (!cands.length) {
    const m4 = base.match(/(?<![a-z0-9])e(?:p|pisode)?\s*(\d{1,3})(?![a-z0-9])/i);
    if (m4) cands.push({ s: null, e: +m4[1], e2: null, explicit: false });

    const m5 = base.match(/^\s*(\d{1,3})(?=\s|-)/);
    if (m5) cands.push({ s: null, e: +m5[1], e2: null, explicit: false });

    const m6 = base.match(/(?<![a-z0-9])([1-9])(\d{2})(?![a-z0-9])/);
    if (m6) cands.push({ s: +m6[1], e: +m6[2], e2: null, explicit: false });
  }
  return { cands, dirSeason };
}

function episodeMatch(itemTitle, path, season, ep, epTitle) {
  let { cands, dirSeason } = parseRefs(path);
  if (!cands.length) cands = parseRefs(itemTitle).cands;
  const ctxSeason = dirSeason ?? seasonOf(itemTitle);

  let best = { tier: 0, span: 1 };
  for (const c of cands) {
    const hi = c.e2 && c.e2 >= c.e && c.e2 - c.e <= 4 ? c.e2 : c.e;
    if (ep < c.e || ep > hi) continue;
    const s = c.s ?? ctxSeason;
    let tier = 0;
    if (s === season) tier = c.explicit ? 2 : 1;
    else if (s == null && season === 1) tier = 1;
    if (tier > best.tier) best = { tier, span: hi - c.e + 1 };
  }
  if (best.tier) return best;

  const hasExplicit = cands.some((c) => c.explicit);
  if (!hasExplicit && epTitleMatches(`${itemTitle} ${path}`, epTitle) && (ctxSeason == null || ctxSeason === season)) {
    return { tier: 1, span: 1 };
  }
  return best;
}

function pickEpisodeFile(files, doc, season, ep, epTitle, runtime) {
  const lo = runtime ? runtime * EP_LOW : MIN_EPISODE_MINUTES;
  const itemTitle = doc.title || "";
  const hits = videoFiles(files)
    .map((v) => {
      const m = episodeMatch(itemTitle, v.f.name, season, ep, epTitle);
      return { ...v, match: m.tier, span: m.span };
    })
    .filter((v) => v.match > 0)
    .filter(({ mins, span }) => {
      if (mins === null) return true;
      const hi = runtime ? runtime * EP_HIGH * span : Infinity;
      return mins >= lo && mins <= hi;
    });
  hits.sort((a, b) => b.match - a.match || byQuality(a, b));
  return hits;
}

// ----- scoring -----
function moviePercent(item, picked, name, year, runtime) {
  let pts = 30;
  const t = item.title || "";
  const nameToks = new Set(normTitle(name).split(" "));
  const nsq = squash(name);
  const leftover = normTitle(t.replace(/[\(\[].*?[\)\]]/g, " "))
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .split(/\s+/)
    .filter((w) => w && !nameToks.has(w) && w !== nsq).length;
  pts += leftover <= 2 ? 20 : leftover <= 4 ? 10 : 0;
  const itemYear = String(item.year || "");
  const titleYears = t.match(/\b(19|20)\d{2}\b/g) || [];
  if (year && (itemYear === year || titleYears.includes(year))) pts += 20;
  else if (!itemYear && !titleYears.length) pts += 5;
  if (runtime && picked.mins) {
    const d = Math.abs(picked.mins - runtime) / runtime;
    pts += d <= 0.03 ? 30 : d <= 0.06 ? 24 : d <= 0.1 ? 16 : d <= 0.15 ? 8 : 0;
  } else pts += 12;
  if (item.imdb) pts += 30;
  return Math.min(100, Math.round(pts));
}

function episodePercent(picked, runtime, titleHit) {
  let pts = 30;
  pts += picked.match === 2 ? 40 : 25;
  if (runtime && picked.mins) {
    const d = Math.abs(picked.mins / picked.span - runtime) / runtime;
    pts += d <= 0.15 ? 25 : d <= 0.3 ? 15 : d <= 0.5 ? 8 : 0;
  } else pts += 8;
  if (titleHit) pts += 5;
  return Math.min(100, Math.round(pts));
}

async function lookupItem(doc, picker, series, stats) {
  try {
    const md = await fetchJson(`${ARCHIVE_API}/metadata/${encodeURIComponent(doc.identifier)}`);
    if (!md || !md.files || md.is_dark) return null;
    const picked = picker(md.files, doc);
    if (!picked || !picked.length) {
      if (series) {
        const vids = videoFiles(md.files);
        console.log(`  no match in ${doc.identifier} (${vids.length} video files)`);
        if (DEBUG) vids.slice(0, 15).forEach((v) => console.log(`     - ${v.f.name}`));
      }
      return null;
    }
    return picked.map((p) => ({ doc, picked: p }));
  } catch (e) {
    if (stats) stats.failed++;
    console.log(`  metadata failed for ${doc.identifier}: ${e.message}`);
    return null;
  }
}

// ----- display helpers -----
const LANG_NAMES = {
  eng: "English", en: "English",
  jpn: "Japanese", ja: "Japanese", jp: "Japanese",
  fre: "French", fra: "French", fr: "French",
  ger: "German", deu: "German", de: "German",
  spa: "Spanish", es: "Spanish",
  ita: "Italian", it: "Italian",
  rus: "Russian", ru: "Russian",
  por: "Portuguese", pt: "Portuguese",
  chi: "Chinese", zho: "Chinese", zh: "Chinese",
  hin: "Hindi", hi: "Hindi",
  tam: "Tamil", tel: "Telugu", ben: "Bengali", urd: "Urdu",
  kor: "Korean", ko: "Korean",
  ara: "Arabic", ar: "Arabic",
  dut: "Dutch", nld: "Dutch", nl: "Dutch",
  swe: "Swedish", sv: "Swedish",
  nor: "Norwegian", dan: "Danish", fin: "Finnish",
  pol: "Polish", pl: "Polish",
  tur: "Turkish", tr: "Turkish",
  gre: "Greek", ell: "Greek", heb: "Hebrew",
  tha: "Thai", vie: "Vietnamese", ind: "Indonesian",
  cze: "Czech", ces: "Czech", hun: "Hungarian", rum: "Romanian", ron: "Romanian",
};

// language codes -> flag emoji
const LANG_FLAGS = {
  English: "🇬🇧", Japanese: "🇯🇵", French: "🇫🇷", German: "🇩🇪", Spanish: "🇪🇸",
  Italian: "🇮🇹", Russian: "🇷🇺", Portuguese: "🇵🇹", Chinese: "🇨🇳", Hindi: "🇮🇳",
  Tamil: "🇮🇳", Telugu: "🇮🇳", Bengali: "🇧🇩", Urdu: "🇵🇰", Korean: "🇰🇷",
  Arabic: "🇸🇦", Dutch: "🇳🇱", Swedish: "🇸🇪", Norwegian: "🇳🇴", Danish: "🇩🇰",
  Finnish: "🇫🇮", Polish: "🇵🇱", Turkish: "🇹🇷", Greek: "🇬🇷", Hebrew: "🇮🇱",
  Thai: "🇹🇭", Vietnamese: "🇻🇳", Indonesian: "🇮🇩", Czech: "🇨🇿", Hungarian: "🇭🇺",
  Romanian: "🇷🇴", Ukrainian: "🇺🇦",
};

function languageLabel(doc, f) {
  const raw = [].concat(doc.language || []).flatMap((x) => String(x).split(/[,;/|]+/));
  const names = [];
  for (const r of raw) {
    const k = r.trim().toLowerCase();
    if (!k || /^(und|unknown|undetermined|none|n\/a|zxx|mul)$/.test(k)) continue;
    const name = LANG_NAMES[k] || (k.length > 3 ? k.charAt(0).toUpperCase() + k.slice(1) : "");
    if (name && !names.includes(name)) names.push(name);
  }
  const text = norm(`${f.name.split("/").pop()} ${doc.title || ""}`);
  const tags = [];
  if (/\b(dual audio|multi audio)\b/.test(text)) tags.push("Dual audio");
  if (/\b(dubbed|dub)\b/.test(text)) tags.push("Dubbed");
  if (/\b(subbed|subtitled|eng subs?|english subs?|hardsubs?|hard subs?)\b/.test(text)) tags.push("Subbed");
  const all = [...names.slice(0, 3), ...tags];
  return all.length ? all.join(" · ") : "Language not listed";
}

// extract resolution + source + codec + HDR + audio info, structured
function qualityInfo(f, doc) {
  const text = norm(`${f.name.split("/").pop()} ${doc.title || ""}`);
  const w = Number(f.width);
  const h = Number(f.height);

  // resolution
  let res = "";
  let rank = 0;
  if (w || h) {
    const wide = w || (h * 16) / 9;
    if (wide >= 3000) { res = "4K"; rank = 5; }
    else if (wide >= 1800) { res = "1080p"; rank = 4; }
    else if (wide >= 1200) { res = "720p"; rank = 3; }
    else if (wide >= 700) { res = "480p"; rank = 2; }
    else { res = `${h || Math.round((w * 9) / 16)}p`; rank = h >= 460 ? 2 : 1; }
  } else if (/\b(2160p|4k|uhd)\b/.test(text)) { res = "4K"; rank = 5; }
  else if (/\b(1080p|1080i|full hd|fhd)\b/.test(text)) { res = "1080p"; rank = 4; }
  else if (/\b720p\b/.test(text)) { res = "720p"; rank = 3; }
  else if (/\b(480p|576p)\b/.test(text)) { res = "480p"; rank = 2; }
  else if (/\b(360p|240p)\b/.test(text)) { res = "360p"; rank = 1; }

  // source
  let source = "";
  if (/\b(blu ray|bluray|bdrip|bd rip|brrip|br rip|bdremux|remux)\b/.test(text)) source = "BluRay";
  else if (/\b(web dl|webdl|webrip|web rip)\b/.test(text)) source = "WEB-DL";
  else if (/\b(hdtv|pdtv|tvrip|tv rip)\b/.test(text)) source = "HDTV";
  else if (/\b(dvdrip|dvd rip|dvdscr|dvd)\b/.test(text)) source = "DVD";
  else if (/\b(vhsrip|vhs)\b/.test(text)) source = "VHS";
  else if (/\b(camrip|hdcam|telesync|telecine|hdts)\b/.test(text)) source = "CAM";

  // codec
  let codec = "";
  if (/\b(x265|h 265|hevc)\b/.test(text)) codec = "HEVC";
  else if (/\b(x264|h 264|avc)\b/.test(text)) codec = "H.264";
  else if (/\bav1\b/.test(text)) codec = "AV1";
  else if (/\bxvid\b/.test(text)) codec = "XviD";

  // HDR / bit depth — 4 types détectés séparément
  const hdr = [];
  if (/\bdolby vision\b|\b(?:dovi|dv)\b/.test(text)) hdr.push("DV");
  if (/\bhdr10\+\b/.test(text)) hdr.push("HDR10+");
  else if (/\bhdr10\b/.test(text)) hdr.push("HDR10");
  else if (/\bhdr\b/.test(text)) hdr.push("HDR10");
  if (/\b(10 ?bit|hi ?10p?)\b/.test(text)) hdr.push("10bit");

  // audio
  const audio = [];
  if (/\batmos\b/.test(text)) audio.push("Atmos");
  if (/\btruehd\b/.test(text)) audio.push("TrueHD");
  if (/\b(ddp?\+?|eac3|dd\+|dolby digital)\b/.test(text)) audio.push("DD+");
  else if (/\b(dts(-hd|-x)?)\b/.test(text)) audio.push("DTS");
  if (/\b5 1\b|\b5\.1\b/.test(text)) audio.push("5.1");
  else if (/\b7 1\b|\b7\.1\b/.test(text)) audio.push("7.1");
  else if (/\b2 0\b|\b2\.0\b/.test(text)) audio.push("2.0");

  return { res, rank, source, codec, hdr, audio, label: [res, source, codec].filter(Boolean).join(" · ") };
}
// ----- end display helpers -----

function cleanTitle(t, movieName) {
  let s = String(t || "").replace(/[_]+/g, " ");
  s = s.replace(/^\s*(watch|download|stream)\s+/i, "");
  s = s.replace(/\s*[\(\[]\s*(full\s*movie|hd|4k|1080p|720p|480p|free|online|dvdrip|brrip|bluray|webrip|\d{4})\s*[\)\]]\s*/gi, " ");
  s = s.replace(/(?:\s*[-–|:]?\s*\b(?:full\s*movie|free|online|watch|hd|4k|1080p|720p|480p)\b)+\s*$/i, "");
  s = s.replace(/\s+/g, " ").trim();
  if (movieName && norm(s) === norm(movieName)) s = movieName;
  return truncate(s || String(t || ""), 50);
}

// Build the multi-line stream title (WITHOUT duplicating the header line).
function buildStreamTitle({ doc, picked, ctx, pct }) {
  const { f, mins } = picked;
  const { series } = ctx;
  const q = qualityInfo(f, doc);

  // Line 1 : raw filename
  const fileName = f.name.split("/").pop();

  // Line 2 : source + codec
  const qParts = [];
  if (q.source) qParts.push(q.source);
  if (q.codec) qParts.push("🎞️ " + q.codec);
  else if (q.source) qParts.push("🎞️ —");
  const qLine = qParts.join(" ");

  // Line 3 : languages
  const langText = languageLabel(doc, f);
  const langParts = langText.split(" · ").map((l) => LANG_FLAGS[l] || l);
  const langLine = `🗣️ ${langParts.join(" / ") || "Language not listed"}`;

  // Line 4 : size
  const sizeLine = f.size ? `📦 ${fmtSize(f.size)}` : "";

  // Line 5 : duration + %
  const durLine = mins ? `⏱️ ${fmtMins(mins)}${pct ? ` · ${pct}% match` : ""}` : "";

  const lines = [];
  if (series) {
    const label = `📺 S${pad2(series.season)}E${pad2(series.ep)}${series.epTitle ? " · " + truncate(series.epTitle, 40) : ""}`;
    lines.push(label);
  }
  lines.push(fileName);
  if (qLine) lines.push(qLine);
  lines.push(langLine);
  if (sizeLine) lines.push(sizeLine);
  if (durLine) lines.push(durLine);

  return lines.join("\n");
}

function formatStream({ doc, picked }, ctx) {
  const { f, ext, mins } = picked;
  const { year, runtime, name, series } = ctx;
  const titleHit = series && (doc.imdb || titleIn(doc.title, name, false));
  const pct = series ? episodePercent(picked, runtime, titleHit) : moviePercent(doc, picked, name, year, runtime);

  const path = f.name.split("/").map(encodeURIComponent).join("/");
  const url = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${path}`;
  const fileName = f.name.split("/").pop();
  const q = qualityInfo(f, doc);

  const title = buildStreamTitle({ doc, picked, ctx, pct });

  // internal metadata (non-Stremio) for user config filtering/sorting
  const qualKey =
    q.res === "4K" ? "4k" :
    q.res === "1080p" ? "1080" :
    q.res === "720p" ? "720" :
    (q.res === "480p" || q.res === "576p") ? "480" :
    q.rank === 1 ? "low" : "unk";

  const resTag = q.res ? (q.res === "4K" ? "4K UHD" : q.res) : "Unknown";

  return {
    pct,
    rank: q.rank,
    stream: {
      url,
      name: `🏛 Archive-DZ | 🔥 ${resTag}`,
      title,
      behaviorHints: {
        notWebReady: SHOW_NOT_WEB_READY ? false : NOT_WEB_READY.has(ext),
        filename: fileName,
      },
      _qual: qualKey,
      _size: Number(f.size) || 0,
      _hdr: q.hdr || [],
      _langs: [].concat(doc.language || []),
      _pct: pct,
    },
  };
}

async function findStreams(meta, series, imdbId) {
  const name = meta.name;
  const year = String(meta.year || meta.releaseInfo || "").slice(0, 4);
  const runtime = parseRuntime(meta.runtime);
  console.log(
    `${name} (${year})${series ? ` S${pad2(series.season)}E${pad2(series.ep)} "${series.epTitle}"` : ""}` +
      ` expected runtime: ${runtime || "unknown"}m`
  );

  const docs = await searchArchive(name, series, imdbId);

  const titled = (d) => titleIn(d.title, name, false);
  const looseTitled = (d) => titleIn(d.title, name, true);
  const mentions = (d) => titleIn(`${asText(d.subject)} ${asText(d.description)}`, name, false);

  const needsCheck = (d) => !series && !d.imdb && !titled(d);
  const yearOk = (d) => {
    if (!year) return true;
    const ys = [d.year, ...(String(d.title || "").match(/\b(?:19|20)\d{2}\b/g) || [])].map(Number).filter(Boolean);
    return !ys.length || ys.some((y) => Math.abs(y - Number(year)) <= 1);
  };

  let candidates = docs
    .filter((d) => d.imdb || looseTitled(d) || mentions(d))
    .filter((d) => !BAD_WORDS.test(stripName(d.title, name)))
    .filter((d) => {
      if (d.imdb || series || !year) return true;
      if (needsCheck(d)) return yearOk(d);
      return !d.year || Math.abs(Number(d.year) - Number(year)) <= 1;
    })
    .map((d) => (needsCheck(d) ? { ...d, verify: true } : d));
  candidates = [
    ...candidates.filter((d) => d.imdb),
    ...candidates.filter((d) => !d.imdb && titled(d)),
    ...candidates.filter((d) => !d.imdb && !titled(d)),
  ].slice(0, series ? SERIES_CANDIDATES : MOVIE_CANDIDATES);

  console.log(
    `  ${docs.length} hits, ${candidates.length} candidates, ${candidates.filter((d) => d.imdb).length} IMDb-confirmed, ` +
      `${candidates.filter((d) => d.verify).length} runtime-checked`
  );

  const picker = series
    ? (files, doc) => {
      const ok = doc.imdb || titled(doc) ? files : files.filter((f) => titleIn(f.name, name, false));
      return pickEpisodeFile(ok, doc, series.season, series.ep, series.epTitle, runtime);
    }
    : (files, doc) => pickMovieFile(files, runtime, doc.verify, name, imdbId, doc.imdb || titled(doc));

  const stats = { failed: 0 };
  const looked = (await pool(candidates, CONCURRENCY, (d) => lookupItem(d, picker, series, stats))).flat().filter(Boolean);
  const ctx = { year, runtime, name, series };

  const out = looked
    .map((x) => formatStream(x, ctx))
    .filter((x) => x.pct >= MIN_PERCENT)
    .sort((a, b) => b.pct - a.pct || b.rank - a.rank)
    .slice(0, MAX_RESULTS)
    .map((x) => x.stream);
  out.complete = docs.failed === 0 && stats.failed === 0;
  return out;
}

// ---------- user config (qualités / langues / HDR / taille / min%) ----------
function applyUserCfg(streams, cfg) {
  if (!cfg) return streams;

  // 1) QUALITÉS : ne garder que celles cochées
  if (Array.isArray(cfg.quals)) {
    if (!cfg.quals.length) {
      streams = [];
    } else {
      const active = new Set(cfg.quals);
      streams = streams.filter((s) => active.has(s._qual));
    }
  }

  // 2) langues masquées
  const allowed = new Set((cfg.langs || []).map((l) => String(l).toLowerCase().slice(0, 2)));
  if (allowed.size) {
    streams = streams.filter((s) => {
      const langs = (s._langs || []).map((l) => String(l).toLowerCase().slice(0, 2));
      return !langs.length || langs.some((l) => allowed.has(l));
    });
  }

  // 3) taille max (Go)
  if (cfg.size) {
    const maxBytes = Number(cfg.size) * 1e9;
    streams = streams.filter((s) => !s._size || s._size <= maxBytes);
  }

  // 4) HDR : filtrage individuel par type
  if (Array.isArray(cfg.hdr)) {
    const allowedHdr = new Set(cfg.hdr);
    streams = streams.filter((s) => {
      const sh = s._hdr || [];
      if (!sh.length) return true;               // pas de HDR : OK
      return sh.some((h) => allowedHdr.has(h));  // au moins un HDR accepté
    });
  } else if (Number(cfg.hdr) === 0) {
    streams = streams.filter((s) => !(s._hdr && s._hdr.length));
  }

  // 5) filtre % de correspondance minimum
  if (cfg.minPct != null) {
    streams = streams.filter((s) => !s._pct || s._pct >= cfg.minPct);
  }

  // 6) tri par ordre de qualité choisi
  const order = new Map((cfg.quals || []).map((k, i) => [k, i]));
  const rankOf = (s) => (order.has(s._qual) ? order.get(s._qual) : 99);
  streams = streams.slice().sort((a, b) => rankOf(a) - rankOf(b));

  return streams;
}

const cache = new Map();
const builder = new addonBuilder(manifest);

async function searchAndStore(type, id, isRefresh, cfg) {
  const [baseId, s, e] = id.split(":");
  const meta = await getMeta(type, baseId);
  if (!meta) return null;

  let series = null;
  if (type === "series") {
    const season = parseInt(s, 10);
    const ep = parseInt(e, 10);
    if (isNaN(season) || isNaN(ep)) return null;
    const v = (meta.videos || []).find((x) => Number(x.season) === season && Number(x.episode) === ep);
    series = { season, ep, epTitle: v ? v.name || v.title || "" : "" };
  }

  let streams = await findStreams(meta, series, baseId);
  streams = applyUserCfg(streams, cfg);
  console.log(`  -> ${streams.length} Internet Archive result(s)${isRefresh ? " (background refresh)" : ""}`);
  if (streams.length) cache.set(id, { t: Date.now(), at: Date.now(), streams });
  if (DB_ON && streams.length && streams.complete) {
    dbSave({
      t: Date.now(), id, name: meta.name,
      year: String(meta.year || meta.releaseInfo || "").slice(0, 4),
      season: series ? series.season : null, ep: series ? series.ep : null,
      count: streams.length, streams,
    });
  } else if (DB_ON && !streams.complete) console.log("  (search had errors, not cached)");
  if (isRefresh && streams.complete && !streams.length) {
    cache.delete(id);
    if (DB_ON) await dbDelete(id);
    console.log("  (nothing found any more, removed from cache)");
  }
  return streams;
}

const refreshing = new Set();
function refreshInBackground(type, id, cfg) {
  const key = id + "|" + JSON.stringify(cfg || {});
  if (refreshing.has(key)) return;
  refreshing.add(key);
  console.log("  (cached result is old, searching again in the background)");
  searchAndStore(type, id, true, cfg)
    .catch((e) => console.log("  background refresh failed: " + e.message))
    .finally(() => refreshing.delete(key));
}

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie" && type !== "series") return { streams: [] };
  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < CACHE_MS) {
    const stale = Date.now() - hit.at > REFRESH_AFTER_MS;
    console.log(`  -> ${hit.streams.length} result(s) from cache (memory), saved ${fmtAgo(Date.now() - hit.at)}`);
    if (stale) refreshInBackground(type, id, null);
    return { streams: markCached(hit.streams, hit.at, stale) };
  }
  try {
    if (DB_ON) {
      const stored = await dbGet(id);
      if (stored && Array.isArray(stored.streams) && stored.streams.length && Date.now() - stored.t < DB_REUSE_MS) {
        const stale = Date.now() - stored.t > REFRESH_AFTER_MS;
        console.log(`  -> ${stored.streams.length} result(s) from cache (${CACHE_DIR ? "file" : "database"}), saved ${fmtAgo(Date.now() - stored.t)}`);
        cache.set(id, { t: Date.now(), at: stored.t, streams: stored.streams });
        if (stale) refreshInBackground(type, id, null);
        return { streams: markCached(stored.streams, stored.t, stale) };
      }
    }
    const streams = await searchAndStore(type, id, false, null);
    return { streams: streams || [] };
  } catch (e) {
    console.log("Stream handler error:", e.message);
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();

async function handleRequest(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const url = new URL(req.url, `${proto}://${host}`);
  let pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const cfgMatch = pathname.match(/^\/([A-Za-z0-9+/=_-]+)\/(manifest\.json|stream\/.*)$/);
  let userCfg = null;
  if (cfgMatch) {
    try {
      const raw = Buffer.from(cfgMatch[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") userCfg = parsed;
    } catch (e) {}
    if (userCfg) {
      pathname = "/" + cfgMatch[2];
      url.pathname = pathname;
    }
  }

  if (pathname === "/manifest.json" || pathname === "/") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "max-age=3600");
    return res.end(JSON.stringify(addonInterface.manifest));
  }

  const streamMatch = pathname.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
  if (streamMatch) {
    const type = streamMatch[1];
    const id = decodeURIComponent(streamMatch[2]);

    if (userCfg) {
      try {
        const streams = await searchAndStore(type, id, false, userCfg);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        return res.end(JSON.stringify({ streams: streams || [] }));
      } catch (e) {
        console.log("Stream route (cfg) error:", e.message);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.end(JSON.stringify({ streams: [], err: e.message }));
      }
    }

    try {
      const result = await addonInterface.get("stream", type, id);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify(result));
    } catch (e) {
      console.log("Stream route error:", e.message);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ streams: [], err: e.message }));
    }
  }

  if (pathname === "/configure") {
    const LOGO = addonInterface.manifest.logo;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d12">
<title>${addonInterface.manifest.name} — Configuration</title>
<link rel="icon" type="image/jpeg" href="${LOGO}">
<link rel="apple-touch-icon" href="${LOGO}">
<style>
  :root { --bg:#0f1117; --card:#171a23; --line:#2a2f3d; --txt:#e6e9f0; --dim:#8b93a7; --acc:#5b8cff; --ok:#3ddc84; --safe-b: env(safe-area-inset-bottom, 0px); }
  * { box-sizing:border-box; -webkit-tap-highlight-color: transparent; }
  html,body { height:100%; margin:0; overscroll-behavior:none; }
  body {
    font-family:system-ui,-apple-system,sans-serif;
    background:radial-gradient(ellipse at top, #1a1f2e 0%, #0b0d12 70%);
    color:var(--txt);
    display:flex; justify-content:center; align-items:flex-start;
    padding:0;
    min-height:100dvh;
  }
  .modal {
    width:100%; max-width:567px;
    background:var(--card);
    border-left:1px solid var(--line); border-right:1px solid var(--line);
    display:flex; flex-direction:column;
    min-height:100dvh; overflow:hidden; margin:0 auto;
  }
  @media (min-width:960px) {
    body { padding:1rem; align-items:center; }
    .modal {
      min-height:auto; max-height:calc(100vh - 2rem);
      border:1px solid var(--line); border-radius:18px;
      box-shadow:0 20px 60px rgba(0,0,0,.6);
    }
  }

  .modal header {
    display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:.6rem;
    padding:.7rem .8rem; border-bottom:1px solid var(--line);
    background:#12151c; position:sticky; top:0; z-index:5;
  }
  .logo {
    width:40px; height:40px; border-radius:10px;
    object-fit:cover; background:#0b0d12;
    border:1px solid var(--line); flex:none;
  }
  .title-block { min-width:0; }
  .title-block h1 { font-size:.95rem; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .title-block .desc { font-size:.7rem; color:var(--dim); margin-top:.2rem; line-height:1.3;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .badge { font-size:.62rem; padding:.2rem .5rem; border-radius:6px; background:#1c2a4a; color:var(--acc); white-space:nowrap; }

  .tabs {
    display:flex; border-bottom:1px solid var(--line); background:#12151c;
    padding:0 .4rem; gap:.2rem; overflow-x:auto; scrollbar-width:none;
    -webkit-overflow-scrolling:touch; position:sticky; top:57px; z-index:4;
  }
  .tabs::-webkit-scrollbar { display:none; }
  .tabs button {
    background:transparent; border:none; color:var(--dim);
    padding:.8rem .9rem; font-size:.83rem; font-weight:600; cursor:pointer;
    border-bottom:2px solid transparent; display:flex; align-items:center; gap:.4rem;
    white-space:nowrap; min-height:44px;
    transition:color .15s, border-color .15s;
  }
  .tabs button:hover { color:var(--txt); }
  .tabs button.active { color:var(--acc); border-bottom-color:var(--acc); }

  .content {
    flex:1; overflow-y:auto;
    padding:.85rem .8rem calc(.85rem + var(--safe-b));
    min-height:280px; -webkit-overflow-scrolling:touch;
  }
  .content::-webkit-scrollbar { width:6px; }
  .content::-webkit-scrollbar-thumb { background:var(--line); border-radius:6px; }
  .section { display:none; }
  .section.active { display:block; animation: fadeIn .15s ease; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }

  .section h2 {
    font-size:.88rem; color:var(--acc); margin:0 0 .6rem;
    display:flex; align-items:center; justify-content:space-between; gap:.5rem;
  }
  .section h2 .mini { display:flex; gap:.3rem; }
  .section h2 button {
    font-size:.7rem; padding:.45rem .65rem;
    border-radius:8px; border:1px solid var(--line);
    background:transparent; color:var(--dim); cursor:pointer;
    min-height:34px;
  }
  .section h2 button:hover { color:var(--txt); border-color:var(--acc); }
  .hint { font-size:.72rem; color:var(--dim); margin:.3rem 0 .8rem; line-height:1.4; }

  .lang-list, .qual-list { display:flex; flex-direction:column; gap:.35rem; }
  .lang-item, .qual-item {
    display:flex; align-items:center; gap:.55rem;
    padding:.6rem .65rem;
    background:#1e2230;
    border:1px solid var(--line);
    border-radius:10px;
    cursor:grab; user-select:none;
    touch-action:manipulation;
    min-height:48px;
    transition:background .1s, border-color .1s, transform .1s, opacity .15s;
  }
  .lang-item:hover, .qual-item:hover { border-color:#3a4254; }
  .lang-item.on, .qual-item.on { background:#1c2a4a; border-color:#2f4780; }
  .lang-item.off, .qual-item.off { opacity:.5; }
  .lang-item.dragging, .qual-item.dragging { opacity:.5; transform:scale(.98); }
  .lang-item .flag { font-size:1.2rem; flex:none; }
  .lang-item .nm, .qual-item .lbl { flex:1; font-size:.86rem; }
  .lang-item .pos, .qual-item .num {
    color:var(--dim); font-size:.68rem; font-variant-numeric:tabular-nums;
    min-width:24px; text-align:center;
    background:#0b0d12; border-radius:6px; padding:.12rem 0;
    font-weight:700;
  }
  .qual-item .num { background:var(--acc); color:#fff; border-radius:50%; min-width:22px; height:22px; padding:0; line-height:22px; }
  .lang-item .ck, .qual-item .ck {
    width:20px; height:20px; border-radius:50%;
    border:2px solid var(--line); flex:none;
    display:grid; place-items:center;
    transition:all .12s;
  }
  .lang-item.on .ck, .qual-item.on .ck { border-color:var(--ok); background:var(--ok); }
  .lang-item.on .ck::after, .qual-item.on .ck::after { content:"✓"; color:#04120a; font-size:.72rem; font-weight:900; }
  .lang-item .grip, .qual-item .grip { color:var(--dim); font-size:1rem; cursor:grab; padding:0 .15rem; }

  /* ==== HDR : 4 sur une seule ligne ==== */
  .hdr-grid {
    display:grid;
    grid-template-columns:repeat(4, 1fr);
    gap:.35rem;
  }
  .hdr-item {
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.25rem;
    padding:.55rem .25rem;
    background:#1e2230;
    border:1px solid var(--line);
    border-radius:10px;
    cursor:pointer; user-select:none;
    touch-action:manipulation;
    min-height:64px;
    font-size:.72rem;
    line-height:1.15;
    text-align:center;
    transition:background .1s, border-color .1s, opacity .15s;
    overflow:hidden;
  }
  .hdr-item .lbl {
    font-size:.7rem;
    font-weight:600;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    max-width:100%;
  }
  .hdr-item.on { background:#1c2a4a; border-color:#2f4780; }
  .hdr-item.off { opacity:.5; }
  .hdr-item .ck {
    width:18px; height:18px; border-radius:50%;
    border:2px solid var(--line); flex:none;
    display:grid; place-items:center;
    transition:all .12s;
  }
  .hdr-item.on .ck { border-color:var(--ok); background:var(--ok); }
  .hdr-item.on .ck::after { content:"✓"; color:#04120a; font-size:.7rem; font-weight:900; }

  .btn-more {
    width:100%; padding:.7rem;
    background:transparent; border:1px dashed var(--line);
    color:var(--dim); border-radius:10px; cursor:pointer;
    font-size:.82rem; margin-top:.5rem;
    min-height:42px;
  }
  .btn-more:hover { color:var(--acc); border-color:var(--acc); }

  .opt-row {
    display:flex; align-items:center; justify-content:space-between;
    gap:.6rem; padding:.8rem 0;
    border-bottom:1px solid var(--line);
  }
  .opt-row:last-of-type { border-bottom:none; }
  .opt-row label { font-size:.84rem; flex:1; line-height:1.35; }
  .opt-row small { display:block; color:var(--dim); font-size:.7rem; margin-top:.22rem; font-weight:400; }
  input[type=range] { width:100%; accent-color:var(--acc); margin-top:.45rem; height:30px; }
  .slider-val { color:var(--acc); font-weight:700; font-size:.8rem; }
  .slider-hint { display:flex; justify-content:space-between; font-size:.68rem; color:var(--dim); margin-top:.15rem; }

  .modal footer {
    padding:.65rem .8rem calc(.65rem + var(--safe-b));
    border-top:1px solid var(--line);
    background:#12151c;
    display:flex; gap:.45rem; align-items:stretch; flex-wrap:wrap;
    position:sticky; bottom:0; z-index:5;
  }
  .urlbox {
    flex:1 1 100%; order:3;
    font-size:.66rem; color:var(--dim);
    background:#0b0d12; padding:.5rem .65rem;
    border-radius:8px; word-break:break-all;
    border:1px solid var(--line);
    max-height:3rem; overflow:auto;
  }
  @media (min-width:640px) { .urlbox { order:1; flex:1 1 auto; } }
  .btn {
    border:none; border-radius:10px;
    padding:.7rem .9rem; font-size:.85rem; font-weight:700;
    cursor:pointer; text-decoration:none;
    display:inline-flex; align-items:center; justify-content:center; gap:.4rem;
    white-space:nowrap; min-height:46px; flex:1;
  }
  .btn.install { background:var(--ok); color:#04120a; }
  .btn.copy    { background:var(--acc); color:#fff; }
  .btn:hover { filter:brightness(1.08); }
  .btn:active { transform:scale(.98); }

  #toast {
    position:fixed; left:50%; bottom:calc(1.5rem + var(--safe-b));
    transform:translateX(-50%) translateY(20px);
    background:var(--ok); color:#04120a;
    padding:.65rem 1.3rem; border-radius:12px;
    font-weight:700; opacity:0;
    transition:all .25s; pointer-events:none; z-index:99;
    box-shadow:0 8px 24px rgba(61,220,132,.35);
    font-size:.88rem;
  }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

  @media (max-width:400px) {
    .title-block h1 { font-size:.88rem; }
    .title-block .desc { display:none; }
    .badge { display:none; }
    .logo { width:36px; height:36px; }
    .tabs { top:53px; }
  }
</style></head><body>

<div class="modal">
  <header>
    <img class="logo" src="${LOGO}" alt="${addonInterface.manifest.name}">
    <div class="title-block">
      <h1>🏛 ${addonInterface.manifest.name}</h1>
      <div class="desc">${addonInterface.manifest.description}</div>
    </div>
    <span class="badge" id="summary">v${addonInterface.manifest.version}</span>
  </header>

  <nav class="tabs">
    <button data-tab="quals" class="active">🎞️ Qualité</button>
    <button data-tab="langs">🗣️ Langues</button>
    <button data-tab="opts">⚙️ Options</button>
  </nav>

  <div class="content">

    <section class="section active" id="tab-quals">
      <h2>🎞️ Qualité d'image
        <span class="mini">
          <button id="qualAll">Tout</button>
          <button id="qualNone">Rien</button>
        </span>
      </h2>
      <p class="hint">Touchez pour activer/désactiver. Glissez pour changer l'ordre de priorité.</p>
      <div id="quals" class="qual-list"></div>
    </section>

    <section class="section" id="tab-langs">
      <h2>🗣️ Langues
        <span class="mini">
          <button id="langAll">Tout</button>
          <button id="langNone">Rien</button>
        </span>
      </h2>
      <p class="hint">Touchez pour activer/désactiver. Glissez pour changer l'ordre de priorité.</p>
      <div id="langsTop" class="lang-list"></div>
      <button class="btn-more" id="toggleOthers">▼ Afficher les autres langues</button>
      <div id="langsOthers" class="lang-list" style="display:none;margin-top:.6rem;"></div>
    </section>

    <section class="section" id="tab-opts">
      <h2>⚙️ Options</h2>

      <!-- HDR : 4 sur une seule ligne -->
      <div style="margin-bottom:.8rem;">
        <div style="font-size:.84rem; margin-bottom:.5rem; display:flex; align-items:center; justify-content:space-between; gap:.5rem;">
          <span>📺 HDR / Dolby Vision</span>
          <span style="display:flex; gap:.3rem;">
            <button id="hdrAll" style="font-size:.68rem; padding:.35rem .55rem; border:1px solid var(--line); background:transparent; color:var(--dim); border-radius:6px; cursor:pointer;">Tout</button>
            <button id="hdrNone" style="font-size:.68rem; padding:.35rem .55rem; border:1px solid var(--line); background:transparent; color:var(--dim); border-radius:6px; cursor:pointer;">Rien</button>
          </span>
        </div>
        <div id="hdrs" class="hdr-grid"></div>
      </div>

      <div class="opt-row" style="flex-direction:column;align-items:stretch;">
        <label>📦 Taille maximale <span class="slider-val" id="sizeVal">Illimitée</span><small>Filtre les fichiers trop gros</small></label>
        <input type="range" id="size" min="0" max="20" step="0.5" value="0">
        <div class="slider-hint"><span>0 Go</span><span>20 Go</span></div>
      </div>
      <div class="opt-row" style="flex-direction:column;align-items:stretch;">
        <label>🎯 % correspondance minimum <span class="slider-val" id="minPctVal">50%</span><small>Filtre les résultats peu sûrs</small></label>
        <input type="range" id="minPct" min="0" max="100" step="5" value="50">
        <div class="slider-hint"><span>0%</span><span>100%</span></div>
      </div>
    </section>

  </div>

  <footer>
    <div class="urlbox" id="url"></div>
    <button class="btn copy" id="copy">📋 Copier</button>
    <a class="btn install" id="install" href="#">▶ Installer</a>
  </footer>
</div>

<div id="toast">✅ OK · URL copiée</div>

<script>
const ALL_LANGS = [
  { code:"en", flag:"🇬🇧", name:"English" },
  { code:"fr", flag:"🇫🇷", name:"Français" },
  { code:"ar", flag:"🇸🇦", name:"العربية" },
  { code:"es", flag:"🇪🇸", name:"Español" },
  { code:"de", flag:"🇩🇪", name:"Deutsch" },
  { code:"hi", flag:"🇮🇳", name:"हिन्दी" },
  { code:"it", flag:"🇮🇹", name:"Italiano" },
  { code:"pt", flag:"🇵🇹", name:"Português" },
  { code:"ru", flag:"🇷🇺", name:"Русский" },
  { code:"ja", flag:"🇯🇵", name:"日本語" },
  { code:"ko", flag:"🇰🇷", name:"한국어" },
  { code:"zh", flag:"🇨🇳", name:"中文" },
  { code:"nl", flag:"🇳🇱", name:"Nederlands" },
  { code:"sv", flag:"🇸🇪", name:"Svenska" },
  { code:"pl", flag:"🇵🇱", name:"Polski" },
  { code:"tr", flag:"🇹🇷", name:"Türkçe" },
];
const TOP_COUNT = 6;
const QUALS = [
  { k:"4k",   label:"🔥 4K / 2160p" },
  { k:"1080", label:"⭐ 1080p" },
  { k:"720",  label:"✅ 720p" },
  { k:"480",  label:"📼 480p / 576p" },
  { k:"low",  label:"📺 360p et moins" },
  { k:"unk",  label:"❓ Inconnue" },
];
const HDRS = [
  { k:"HDR10",  label:"HDR10" },
  { k:"HDR10+", label:"HDR10+" },
  { k:"DV",     label:"DV" },
  { k:"10bit",  label:"10-bit" },
];

function load(k, def) { try { const v = JSON.parse(localStorage.getItem("ia_cfg_"+k)); return v ?? def; } catch(e){ return def; } }
function save(k, v) { localStorage.setItem("ia_cfg_"+k, JSON.stringify(v)); }

let langOrder  = load("langOrder",  ALL_LANGS.map(l => l.code));
let langOn     = load("langOn",     Object.fromEntries(ALL_LANGS.map(l => [l.code, true])));
let qualOrder  = load("qualOrder",  QUALS.map(q => q.k));
let qualOn     = load("qualOn",     Object.fromEntries(QUALS.map(q => [q.k, true])));
let hdrOn      = load("hdrOn",      Object.fromEntries(HDRS.map(h => [h.k, true])));
let maxSize    = load("size",       0);
let minPct     = load("minPct",     50);
let showOthers = false;

const langByCode = Object.fromEntries(ALL_LANGS.map(l => [l.code, l]));
const qualByKey = Object.fromEntries(QUALS.map(q => [q.k, q]));

document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
    document.querySelector('.content').scrollTop = 0;
  };
});

function enableReorder(container, onMove) {
  let dragFrom = null, placeholder = null;
  function getEl(e) { return e.target.closest('[data-code],[data-i]'); }
  container.addEventListener('pointerdown', (e) => {
    const el = getEl(e);
    if (!el) return;
    if (e.target.classList.contains('ck')) return;
    dragFrom = el;
    el.classList.add('dragging');
    const rect = el.getBoundingClientRect();
    placeholder = document.createElement('div');
    placeholder.style.cssText = 'height:'+rect.height+'px;border:2px dashed '+getComputedStyle(document.documentElement).getPropertyValue('--acc')+';border-radius:10px;opacity:.4';
    el.parentNode.insertBefore(placeholder, el.nextSibling);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  container.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    const after = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-code],[data-i]');
    if (!after || after === dragFrom) return;
    const afterRect = after.getBoundingClientRect();
    const midY = afterRect.top + afterRect.height / 2;
    const ref = (e.clientY < midY) ? after : after.nextSibling;
    if (ref === placeholder) return;
    container.insertBefore(placeholder, ref);
  });
  function finish() {
    if (!dragFrom) return;
    const order = [];
    let draggingIdx = -1;
    Array.from(container.children).forEach((c) => {
      if (c === placeholder) { draggingIdx = order.length; return; }
      if (c === dragFrom) return;
      const key = c.dataset.code || c.dataset.i;
      if (key != null) order.push(key);
    });
    const dragKey = dragFrom.dataset.code || dragFrom.dataset.i;
    if (draggingIdx < 0) draggingIdx = order.length;
    order.splice(draggingIdx, 0, dragKey);
    placeholder?.remove();
    placeholder = null;
    dragFrom.classList.remove('dragging');
    dragFrom = null;
    onMove(order);
  }
  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);
}

// ==== QUALITÉS ====
const qualsBox = document.getElementById("quals");
function renderQuals() {
  qualsBox.innerHTML = "";
  qualOrder.forEach((k, i) => {
    const q = qualByKey[k];
    if (!q) return;
    const el = document.createElement("div");
    el.className = "qual-item" + (qualOn[k] ? " on" : " off");
    el.dataset.i = k;
    el.innerHTML =
      '<span class="num">' + (i + 1) + '</span>' +
      '<span class="lbl">' + q.label + '</span>' +
      '<span class="grip">☰</span>' +
      '<span class="ck"></span>';
    el.onclick = (e) => {
      if (e.target.classList.contains("grip")) return;
      qualOn[k] = !qualOn[k];
      save("qualOn", qualOn);
      renderQuals();
      update();
    };
    qualsBox.appendChild(el);
  });
}
enableReorder(qualsBox, (order) => {
  qualOrder = order; save("qualOrder", qualOrder); renderQuals(); update();
});
document.getElementById("qualAll").onclick  = () => { Object.keys(qualOn).forEach(k => qualOn[k] = true);  save("qualOn", qualOn); renderQuals(); update(); };
document.getElementById("qualNone").onclick = () => { Object.keys(qualOn).forEach(k => qualOn[k] = false); save("qualOn", qualOn); renderQuals(); update(); };

// ==== LANGUES ====
const langsTopBox = document.getElementById("langsTop");
const langsOthersBox = document.getElementById("langsOthers");

function buildLangEl(code, idx) {
  const l = langByCode[code];
  if (!l) return null;
  const el = document.createElement("div");
  el.className = "lang-item" + (langOn[code] ? " on" : " off");
  el.dataset.code = code;
  el.innerHTML =
    '<span class="pos">' + (idx + 1) + '</span>' +
    '<span class="flag">' + l.flag + '</span>' +
    '<span class="nm">' + l.name + '</span>' +
    '<span class="grip">☰</span>' +
    '<span class="ck"></span>';
  el.onclick = (e) => {
    if (e.target.classList.contains("grip")) return;
    langOn[code] = !langOn[code];
    save("langOn", langOn);
    renderLangs();
    update();
  };
  return el;
}

function renderLangs() {
  langsTopBox.innerHTML = "";
  langsOthersBox.innerHTML = "";
  langOrder.slice(0, TOP_COUNT).forEach((code, i) => {
    const el = buildLangEl(code, i);
    if (el) langsTopBox.appendChild(el);
  });
  const rest = langOrder.slice(TOP_COUNT);
  document.getElementById("toggleOthers").textContent = showOthers
    ? "▲ Masquer les autres langues (" + rest.length + ")"
    : "▼ Afficher les autres langues (" + rest.length + ")";
  langsOthersBox.style.display = showOthers ? "" : "none";
  rest.forEach((code, i) => {
    const el = buildLangEl(code, TOP_COUNT + i);
    if (el) langsOthersBox.appendChild(el);
  });
}
function applyLangOrder() {
  const topKeys = Array.from(langsTopBox.children).map(c => c.dataset.code).filter(Boolean);
  const otherKeys = Array.from(langsOthersBox.children).map(c => c.dataset.code).filter(Boolean);
  langOrder = [...topKeys, ...otherKeys];
  save("langOrder", langOrder);
  renderLangs(); update();
}
enableReorder(langsTopBox, applyLangOrder);
enableReorder(langsOthersBox, applyLangOrder);
document.getElementById("toggleOthers").onclick = () => { showOthers = !showOthers; renderLangs(); };
document.getElementById("langAll").onclick  = () => { Object.keys(langOn).forEach(k => langOn[k] = true);  save("langOn", langOn); renderLangs(); update(); };
document.getElementById("langNone").onclick = () => { Object.keys(langOn).forEach(k => langOn[k] = false); save("langOn", langOn); renderLangs(); update(); };

// ==== HDR individuel (4 sur une ligne) ====
const hdrsBox = document.getElementById("hdrs");
function renderHdrs() {
  hdrsBox.innerHTML = "";
  HDRS.forEach((h) => {
    const el = document.createElement("div");
    el.className = "hdr-item" + (hdrOn[h.k] ? " on" : " off");
    el.dataset.k = h.k;
    el.innerHTML =
      '<span class="ck"></span>' +
      '<span class="lbl">' + h.label + '</span>';
    el.onclick = () => {
      hdrOn[h.k] = !hdrOn[h.k];
      save("hdrOn", hdrOn);
      renderHdrs();
      update();
    };
    hdrsBox.appendChild(el);
  });
}
document.getElementById("hdrAll").onclick  = () => { Object.keys(hdrOn).forEach(k => hdrOn[k] = true);  save("hdrOn", hdrOn); renderHdrs(); update(); };
document.getElementById("hdrNone").onclick = () => { Object.keys(hdrOn).forEach(k => hdrOn[k] = false); save("hdrOn", hdrOn); renderHdrs(); update(); };

// ==== SLIDERS ====
const sizeEl = document.getElementById("size"), sizeVal = document.getElementById("sizeVal");
sizeEl.value = maxSize;
const sizeText = v => v == 0 ? "Illimitée" : v + " Go max";
sizeVal.textContent = sizeText(maxSize);
sizeEl.oninput = () => { maxSize = +sizeEl.value; sizeVal.textContent = sizeText(maxSize); save("size", maxSize); update(); };

const pctEl = document.getElementById("minPct"), pctVal = document.getElementById("minPctVal");
pctEl.value = minPct;
pctVal.textContent = minPct + "%";
pctEl.oninput = () => { minPct = +pctEl.value; pctVal.textContent = minPct + "%"; save("minPct", minPct); update(); };

// ==== URL + COPY ====
function buildCfg() {
  return {
    quals:  qualOrder.filter(k => qualOn[k]),
    langs:  langOrder.filter(c => langOn[c]),
    hdr:    HDRS.map(h => h.k).filter(k => hdrOn[k]),
    size:   maxSize,
    minPct,
  };
}
function update() {
  const cfg = buildCfg();
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))))
    .replace(/=+$/, "").replace(/\\+/g, "-").replace(/\\//g, "_");
  const url = location.origin + "/" + b64 + "/manifest.json";
  document.getElementById("url").textContent = url;
  document.getElementById("install").href = "stremio://" + url.replace(/^https?:\\/\\//, "");

  const nbQ = cfg.quals.length;
  const nbL = cfg.langs.length;
  const nbH = cfg.hdr.length;
  document.getElementById("summary").textContent =
    "v1.7.9 · " + nbQ + "/" + QUALS.length + " Q · " + nbL + "/" + ALL_LANGS.length + " L · " +
    nbH + "/" + HDRS.length + " H · " + (maxSize ? maxSize + "Go" : "∞") + " · " + minPct + "%";
}

let toastTimer;
document.getElementById("copy").onclick = async () => {
  const url = document.getElementById("url").textContent;
  try { await navigator.clipboard.writeText(url); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = url; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  const t = document.getElementById("toast");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1400);
};

renderQuals();
renderLangs();
renderHdrs();
update();
</script>
</body></html>`);
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(JSON.stringify({ err: "Not found" }));
}

module.exports = handleRequest;

if (require.main === module) {
  const http = require("http");
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      console.error("Unhandled error:", e);
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });
  server.listen(PORT, () => {
    let lan = null;
    try {
      lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    } catch (e) {}
    const local = `127.0.0.1:${PORT}/manifest.json`;
    console.log("\n=== Add-on running (local mode) ===");
    console.log("This phone:     http://" + local);
    console.log("Tap to install: stremio://" + local);
    if (lan) console.log("Other devices:  http://" + lan.address + ":" + PORT + "/manifest.json");
    console.log("Config page:    http://" + (lan ? lan.address : "127.0.0.1") + ":" + PORT + "/configure");
    console.log("===================================\n");

    if (CACHE_DIR) {
      try {
        const n = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json")).length;
        console.log(`Cache folder: ${CACHE_DIR} (${n} saved title${n === 1 ? "" : "s"})`);
      } catch (e) {
        console.log(`Cache folder: ${CACHE_DIR} (empty, will be created)`);
      }
    }
  });
}
