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

const manifest = {
  id: "org.example.archivemoviesearch",
  version: "1.7.0",
  name: "Internet Archive DZ",
  description: "Public domain and freely available movies and TV episodes from the Internet Archive",
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

  // HDR / bit depth
  const hdr = [];
  if (/\bdolby vision\b|\b(?:dovi|dv)\b/.test(text)) hdr.push("DV");
  if (/\bhdr10\+\b/.test(text)) hdr.push("HDR10+");
  else if (/\bhdr10\b/.test(text)) hdr.push("HDR10");
  else if (/\bhdr\b/.test(text)) hdr.push("HDR");
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

// Convert quality info into a single line like "BluRay 📺 HDR | DV | 10bit 🎞️ HEVC"
function qualityLine(q) {
  const parts = [];
  if (q.source) parts.push(q.source);
  if (q.hdr.length) parts.push("📺 " + q.hdr.join(" | "));
  if (q.codec) parts.push("🎞️ " + q.codec);
  return parts.join(" ");
}

// Line for audio track info like "🎧 Atmos | TrueHD | DD+ 📡 5.1"
function audioLine(q) {
  const parts = [];
  if (q.audio.length) parts.push("🎧 " + q.audio.join(" | "));
  return parts.join(" ");
}

// Build the multi-line stream title matching the requested style
function buildStreamTitle({ doc, picked, ctx, pct }) {
  const { f, ext, mins } = picked;
  const { year, name, series } = ctx;
  const itemYear = doc.year ? String(doc.year).slice(0, 4) : "";
  const fileName = f.name.split("/").pop();
  const q = qualityInfo(f, doc);

  // resolution header line
  const resLine = q.res
    ? `${q.res === "4K" ? "🔥 4K UHD" : `🔥 ${q.res}`}`
    : "🎬 Unknown Quality";

  // title line
  const displayName = series ? `${name}` : cleanTitle(doc.title || doc.identifier, name);
  const titleLine = `🎬 ${displayName}${itemYear ? ` (${itemYear})` : ""}`;

  // quality line
  const qLine = qualityLine(q);

  // audio line
  const aLine = audioLine(q);

  // languages line
  const langText = languageLabel(doc, f);
  const langParts = langText.split(" · ").map((l) => LANG_FLAGS[l] || l);
  const langLine = langParts.length ? `🗣️ ${langParts.join(" / ")}` : "";

  // size line
  const sizeLine = f.size ? `📦 ${fmtSize(f.size)}` : "";

  // source link line
  const linkLine = `💻 Web Link 🔍 DZ`;

  // Assemble lines, skipping empty
  const lines = [resLine, titleLine];
  if (series) {
    const label = `S${pad2(series.season)}E${pad2(series.ep)}`;
    lines.push(`📺 ${label}${series.epTitle ? " · " + truncate(series.epTitle, 40) : ""}`);
  }
  if (qLine) lines.push(qLine);
  if (aLine) lines.push(aLine);
  if (langLine) lines.push(langLine);
  if (sizeLine) lines.push(sizeLine);
  if (mins) lines.push(`⏱️ ${fmtMins(mins)}${pct ? ` · ${pct}% match` : ""}`);
  lines.push(linkLine);

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

  return {
    pct,
    rank: q.rank,
    stream: {
      url,
      name: `🏛 Archive\n〈${series ? "Episode" : "Full Movie"}〉`,
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

// ---------- user config (langues / qualité / hdr / taille / min%) ----------
function applyUserCfg(streams, cfg) {
  if (!cfg) return streams;

  // 1) langues masquées
  const allowed = new Set((cfg.langs || []).map((l) => String(l).toLowerCase().slice(0, 2)));
  if (allowed.size) {
    streams = streams.filter((s) => {
      const langs = (s._langs || []).map((l) => String(l).toLowerCase().slice(0, 2));
      return !langs.length || langs.some((l) => allowed.has(l));
    });
  }

  // 2) taille max (Go)
  if (cfg.size) {
    const maxBytes = Number(cfg.size) * 1e9;
    streams = streams.filter((s) => !s._size || s._size <= maxBytes);
  }

  // 3) HDR refusé
  if (Number(cfg.hdr) === 0) {
    streams = streams.filter((s) => !(s._hdr && s._hdr.length));
  }

  // 4) filtre % de correspondance minimum
  if (cfg.minPct != null) {
    streams = streams.filter((s) => !s._pct || s._pct >= cfg.minPct);
  }

  // 5) tri par ordre de qualité choisi
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

  // URL avec config : /<base64>/manifest.json  et  /<base64>/stream/...
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

    // si une config est fournie, on court-circuite le cache "brut" et on applique le filtre
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
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${addonInterface.manifest.name} — Configuration</title>
<style>
  :root { --bg:#0f1117; --card:#171a23; --line:#2a2f3d; --txt:#e6e9f0; --dim:#8b93a7; --acc:#5b8cff; --ok:#3ddc84; }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { font-family:system-ui,-apple-system,sans-serif; margin:0; padding:.9rem; background:var(--bg); color:var(--txt); display:flex; flex-direction:column; gap:.7rem; }
  header { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
  header h1 { font-size:1.15rem; margin:0; }
  header .ver { color:var(--dim); font-size:.75rem; }
  .grid { display:grid; grid-template-columns:1.25fr 1fr 1fr; gap:.7rem; flex:1; min-height:0; }
  @media (max-width:900px) { .grid { grid-template-columns:1fr 1fr; } .opts { grid-column:span 2; } }
  @media (max-width:620px) { .grid { grid-template-columns:1fr; } .opts { grid-column:auto; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:.7rem .75rem; display:flex; flex-direction:column; min-height:0; }
  .card h2 { font-size:.85rem; margin:0 0 .5rem; color:var(--acc); display:flex; align-items:center; gap:.35rem; justify-content:space-between; }
  .card h2 .mini { display:flex; gap:.3rem; }
  .card h2 button { font-size:.7rem; padding:.2rem .45rem; border-radius:6px; border:1px solid var(--line); background:transparent; color:var(--dim); cursor:pointer; }
  .card h2 button:hover { color:var(--txt); border-color:var(--acc); }
  .scroll { overflow-y:auto; flex:1; min-height:0; padding-right:.2rem; }
  .scroll::-webkit-scrollbar { width:6px; }
  .scroll::-webkit-scrollbar-thumb { background:var(--line); border-radius:6px; }
  .lang { display:flex; align-items:center; gap:.4rem; padding:.32rem .5rem; border-radius:8px; cursor:pointer; user-select:none; transition:background .1s; }
  .lang:hover { background:#1e2230; }
  .lang.on { background:#1c2a4a; }
  .lang .flag { font-size:1.05rem; }
  .lang .nm { flex:1; font-size:.85rem; }
  .lang .ck { width:16px; height:16px; border-radius:50%; border:2px solid var(--line); flex:none; display:grid; place-items:center; }
  .lang.on .ck { border-color:var(--ok); background:var(--ok); }
  .lang.on .ck::after { content:"✓"; color:#04120a; font-size:.7rem; font-weight:900; }
  .qual { display:flex; align-items:center; gap:.5rem; padding:.5rem .6rem; margin-bottom:.35rem; background:#1e2230; border:1px solid var(--line); border-radius:10px; cursor:grab; user-select:none; }
  .qual .num { background:var(--acc); color:#fff; border-radius:50%; width:20px; height:20px; display:grid; place-items:center; font-size:.7rem; font-weight:700; flex:none; }
  .qual .lbl { flex:1; font-size:.82rem; }
  .qual .h { color:var(--dim); }
  .opts .row { display:flex; align-items:center; justify-content:space-between; gap:.5rem; padding:.5rem 0; border-bottom:1px solid var(--line); }
  .opts .row:last-of-type { border-bottom:none; }
  .opts .row label { font-size:.82rem; flex:1; }
  .opts .row small { display:block; color:var(--dim); font-size:.7rem; margin-top:.1rem; }
  .toggle { display:flex; gap:.25rem; }
  .toggle button { border:1px solid var(--line); background:transparent; color:var(--dim); border-radius:6px; padding:.25rem .5rem; font-size:.75rem; cursor:pointer; }
  .toggle button.on { background:var(--acc); border-color:var(--acc); color:#fff; }
  input[type=range] { width:100%; accent-color:var(--acc); }
  .sizeRow { display:flex; justify-content:space-between; font-size:.75rem; color:var(--dim); margin-top:.2rem; }
  .sizeRow b { color:var(--acc); }
  footer { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
  .btn { border:none; border-radius:10px; padding:.7rem 1rem; font-size:.9rem; font-weight:700; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:.35rem; }
  .btn.install { background:var(--ok); color:#04120a; flex:1; justify-content:center; }
  .btn.copy { background:var(--acc); color:#fff; }
  .urlbox { flex:1; min-width:200px; font-size:.7rem; color:var(--dim); background:#0b0d12; padding:.55rem .7rem; border-radius:8px; word-break:break-all; border:1px solid var(--line); }
  #toast { position:fixed; left:50%; bottom:1.5rem; transform:translateX(-50%) translateY(20px); background:var(--ok); color:#04120a; padding:.6rem 1.2rem; border-radius:10px; font-weight:700; opacity:0; transition:all .25s; pointer-events:none; z-index:99; }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  .badge { font-size:.65rem; padding:.1rem .4rem; border-radius:6px; background:#1c2a4a; color:var(--acc); }
</style></head><body>

<header>
  <h1>🏛 ${addonInterface.manifest.name}</h1>
  <span class="ver">v${addonInterface.manifest.version}</span>
  <span class="badge" id="summary"></span>
</header>

<div class="grid">

  <div class="card">
    <h2>🗣️ Langues
      <span class="mini"><button id="langAll">Tout</button><button id="langNone">Rien</button></span>
    </h2>
    <div class="scroll" id="langs"></div>
  </div>

  <div class="card">
    <h2>🎞️ Qualité d'image</h2>
    <div class="scroll" id="quals"></div>
  </div>

  <div class="card opts">
    <h2>⚙️ Options</h2>
    <div class="row">
      <label>📺 HDR / Dolby Vision<small>HDR10, HDR10+, DV, 10bit</small></label>
      <div class="toggle" data-k="hdr"><button data-v="1">Oui</button><button data-v="0">Non</button></div>
    </div>
    <div class="row" style="flex-direction:column;align-items:stretch;">
      <label>📦 Taille maximale <small>0 = pas de limite</small></label>
      <input type="range" id="size" min="0" max="20" step="0.5" value="0">
      <div class="sizeRow"><span>0 Go</span><b id="sizeVal">Illimitée</b><span>20 Go</span></div>
    </div>
    <div class="row">
      <label>🎯 % de correspondance minimum<small>Filtrer les résultats peu sûrs</small></label>
      <span class="badge" id="minPctVal">50%</span>
    </div>
    <input type="range" id="minPct" min="0" max="100" step="5" value="50">
  </div>

</div>

<footer>
  <div class="urlbox" id="url"></div>
  <button class="btn copy" id="copy">📋 Copier</button>
  <a class="btn install" id="install" href="#">▶ Installer</a>
</footer>

<div id="toast">✅ OK · URL copiée</div>

<script>
const LANGS_POP = [
  { code:"en", flag:"🇬🇧", name:"English" },
  { code:"fr", flag:"🇫🇷", name:"Français" },
  { code:"es", flag:"🇪🇸", name:"Español" },
  { code:"de", flag:"🇩🇪", name:"Deutsch" },
  { code:"it", flag:"🇮🇹", name:"Italiano" },
  { code:"pt", flag:"🇵🇹", name:"Português" },
  { code:"ru", flag:"🇷🇺", name:"Русский" },
  { code:"ar", flag:"🇸🇦", name:"العربية" },
  { code:"hi", flag:"🇮🇳", name:"हिन्दी" },
  { code:"ja", flag:"🇯🇵", name:"日本語" },
];
const LANGS_REST = [
  { code:"ko", flag:"🇰🇷", name:"한국어" },
  { code:"zh", flag:"🇨🇳", name:"中文" },
  { code:"nl", flag:"🇳🇱", name:"Nederlands" },
  { code:"sv", flag:"🇸🇪", name:"Svenska" },
  { code:"pl", flag:"🇵🇱", name:"Polski" },
  { code:"tr", flag:"🇹🇷", name:"Türkçe" },
];
const QUALS = [
  { k:"4k",   label:"🔥 4K / 2160p",    rank:5 },
  { k:"1080", label:"⭐ 1080p",          rank:4 },
  { k:"720",  label:"✅ 720p",           rank:3 },
  { k:"480",  label:"📼 480p / 576p",    rank:2 },
  { k:"low",  label:"📺 360p et moins",  rank:1 },
  { k:"unk",  label:"❓ Inconnue",        rank:0 },
];

function load(k, def) { try { const v = JSON.parse(localStorage.getItem("ia_cfg_"+k)); return v ?? def; } catch(e){ return def; } }
function save(k, v) { localStorage.setItem("ia_cfg_"+k, JSON.stringify(v)); }

let langOn  = load("langOn",  Object.fromEntries([...LANGS_POP, ...LANGS_REST].map(l => [l.code, true])));
let qualArr = load("quals",   QUALS.map(q => q.k));
let hdr     = load("hdr",     1);
let maxSize = load("size",    0);
let minPct  = load("minPct",  50);

const langsBox = document.getElementById("langs");
function renderLangs() {
  langsBox.innerHTML = "";
  const addGroup = (title, list) => {
    if (!list.length) return;
    const h = document.createElement("div");
    h.style.cssText = "font-size:.68rem;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin:.4rem 0 .25rem;";
    h.textContent = title;
    langsBox.appendChild(h);
    list.forEach(l => {
      const el = document.createElement("div");
      el.className = "lang" + (langOn[l.code] ? " on" : "");
      el.innerHTML = '<span class="flag">'+l.flag+'</span><span class="nm">'+l.name+'</span><span class="ck"></span>';
      el.onclick = () => { langOn[l.code] = !langOn[l.code]; save("langOn", langOn); renderLangs(); update(); };
      langsBox.appendChild(el);
    });
  };
  addGroup("⭐ Les plus utilisées", LANGS_POP);
  addGroup("Autres", LANGS_REST);
}

document.getElementById("langAll").onclick  = () => { Object.keys(langOn).forEach(k => langOn[k] = true);  save("langOn", langOn); renderLangs(); update(); };
document.getElementById("langNone").onclick = () => { Object.keys(langOn).forEach(k => langOn[k] = false); save("langOn", langOn); renderLangs(); update(); };

const qualsBox = document.getElementById("quals");
function renderQuals() {
  qualsBox.innerHTML = "";
  qualArr.forEach((k, i) => {
    const q = QUALS.find(x => x.k === k);
    if (!q) return;
    const el = document.createElement("div");
    el.className = "qual"; el.draggable = true; el.dataset.i = i;
    el.innerHTML = '<span class="num">'+(i+1)+'</span><span class="lbl">'+q.label+'</span><span class="h">☰</span>';
    el.ondragstart = e => e.dataTransfer.setData("text/plain", i);
    el.ondragover  = e => e.preventDefault();
    el.ondrop = e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData("text/plain"), to = i;
      if (from === to) return;
      const [m] = qualArr.splice(from, 1); qualArr.splice(to, 0, m);
      save("quals", qualArr); renderQuals(); update();
    };
    qualsBox.appendChild(el);
  });
}

function bindToggle(key, val, onSet) {
  document.querySelectorAll('[data-k="'+key+'"] button').forEach(b => {
    if (String(val) === b.dataset.v) b.classList.add("on");
    b.onclick = () => {
      const v = +b.dataset.v; onSet(v);
      document.querySelectorAll('[data-k="'+key+'"] button').forEach(x => x.classList.toggle("on", x === b));
      update();
    };
  });
}
bindToggle("hdr", hdr, v => { hdr = v; save("hdr", hdr); });

const sizeEl = document.getElementById("size"), sizeVal = document.getElementById("sizeVal");
sizeEl.value = maxSize;
const sizeText = v => v == 0 ? "Illimitée" : v + " Go max";
sizeVal.textContent = sizeText(maxSize);
sizeEl.oninput = () => { maxSize = +sizeEl.value; sizeVal.textContent = sizeText(maxSize); save("size", maxSize); update(); };

const pctEl = document.getElementById("minPct"), pctVal = document.getElementById("minPctVal");
pctEl.value = minPct;
pctVal.textContent = minPct + "%";
pctEl.oninput = () => { minPct = +pctEl.value; pctVal.textContent = minPct + "%"; save("minPct", minPct); update(); };

function buildCfg() {
  return {
    langs:  Object.entries(langOn).filter(([_,v]) => v).map(([k]) => k),
    quals:  qualArr,
    hdr, size: maxSize, minPct,
  };
}
function update() {
  const cfg = buildCfg();
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))))
    .replace(/=+$/,"").replace(/\\+/g,"-").replace(/\\//g,"_");
  const url = location.origin + "/" + b64 + "/manifest.json";
  document.getElementById("url").textContent = url;
  document.getElementById("install").href = "stremio://" + url.replace(/^https?:\\/\\//,"");

  const nbL = cfg.langs.length, total = LANGS_POP.length + LANGS_REST.length;
  document.getElementById("summary").textContent =
    nbL + "/" + total + " langues · " + (hdr ? "HDR" : "SDR") + " · " + (maxSize ? maxSize+"Go" : "∞") + " · " + minPct + "%";
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

renderLangs();
renderQuals();
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
