const express = require("express");
const app = express();
const PORT = Number(process.env.PORT || 10000);

const CINEMETA = "https://v3-cinemeta.strem.io/meta/movie";
const IA = "https://archive.org";

const OPEN_TEST_MOVIES = {
  "tt1254207": {
    title: "Big Buck Bunny",
    streams: [{
      name: "Internet Archive",
      title: "Big Buck Bunny • 720p • CC BY 3.0",
      url: "https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4",
      quality: "720p",
      behaviorHints: { bingeGroup: "internet-archive" }
    }]
  }
};

function archiveSearchUrl(title, exact = true) {
  const clean = String(title || "").trim().replace(/"/g, "\\\"");
  const titleQuery = exact ? `title:"${clean}"` : clean;
  const q = `${titleQuery} AND mediatype:movies`;
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("rows", "20");
  params.set("page", "1");
  params.set("output", "json");
  return `${IA}/advancedsearch.php?${params.toString()}`;
}

async function archiveMetadata(id) {
  const r = await fetch(`${IA}/metadata/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`metadata ${r.status}`);
  return r.json();
}

function videoFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter(f => f && !f.private && /\.(mp4|webm|ogv|m4v)$/i.test(f.name || ""))
    .sort((a, b) => {
      const rank = n => /\.mp4$/i.test(n) ? 0 : /\.webm$/i.test(n) ? 1 : 2;
      return rank(a.name) - rank(b.name);
    });
}

function openlyLicensed(metadata) {
  const m = metadata?.metadata || {};
  const text = [m.licenseurl, m.license, m.rights, m.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    /creativecommons\.org\/licenses\//.test(text) ||
    /creativecommons/i.test(text) ||
    /public domain/.test(text) ||
    /public-domain/.test(text) ||
    /pd-us/.test(text) ||
    /pd-old/.test(text)
  );
}

async function cinemetaTitle(id) {
  const r = await fetch(`${CINEMETA}/${encodeURIComponent(id)}.json`);
  if (!r.ok) throw new Error(`cinemeta ${r.status}`);
  const data = await r.json();
  return data.meta?.name || data.meta?.title || null;
}

function normaliseMovieId(id) {
  return String(id || "")
    .replace(/^tmdb:/i, "")
    .replace(/^imdb:/i, "");
}

async function findArchiveItems(title) {
  const searches = [archiveSearchUrl(title, true), archiveSearchUrl(title, false)];
  const seen = new Set();
  const results = [];

  for (const url of searches) {
    const r = await fetch(url);
    if (!r.ok) continue;
    const data = await r.json();
    for (const item of (data.response?.docs || [])) {
      if (item.identifier && !seen.has(item.identifier)) {
        seen.add(item.identifier);
        results.push(item);
      }
    }
    if (results.length >= 20) break;
  }
  return results;
}

function makeStream(id, file, title, quality = "") {
  const url = `${IA}/download/${encodeURIComponent(id)}/${file.name.split("/").map(encodeURIComponent).join("/")}`;
  return {
    name: "Internet Archive",
    title: `${title} • ${quality || file.name}`,
    url,
    ...(quality ? { quality } : {}),
    behaviorHints: { bingeGroup: "internet-archive" }
  };
}

app.get("/manifest.json", (_req, res) => res.json({
  id: "com.example.nuvio.internetarchive",
  version: "1.8.0",
  name: "Internet Archive Movies",
  description: "Nuvio addon for public-domain and openly licensed Internet Archive video.",
  resources: ["stream", "catalog"],
  types: ["movie"],
  idPrefixes: ["tt", "tmdb:", "ia:"],
  catalogs: [{
    type: "movie",
    id: "internet-archive-movies",
    name: "Internet Archive Movies"
  }]
}));

// Keep the catalog query deliberately simple. Internet Archive's Advanced
// Search is more reliable when we let it return its normal fields instead of
// sending comma-separated fl/sort parameters. We only use mediatype:movies
// here. Licensing and playable-file checks happen at stream time.
app.get("/catalog/movie/internet-archive-movies.json", async (_req, res) => {
  try {
    const params = new URLSearchParams();
    params.set("q", "mediatype:movies");
    params.set("rows", "100");
    params.set("page", "1");
    params.set("output", "json");

    const url = `${IA}/advancedsearch.php?${params.toString()}`;
    const r = await fetch(url);

    if (!r.ok) throw new Error(`archive catalog ${r.status}`);
    const data = await r.json();
    const docs = Array.isArray(data.response?.docs) ? data.response.docs : [];

    const metas = docs
      .filter(x => x && x.identifier)
      .slice(0, 100)
      .map(x => ({
        id: `ia:${x.identifier}`,
        type: "movie",
        name: x.title || x.identifier,
        ...(x.year ? { year: Number(x.year) } : {}),
        poster: `${IA}/services/img/${encodeURIComponent(x.identifier)}`
      }));

    console.log(`[catalog] returning ${metas.length} Internet Archive movie records`);
    return res.json({ metas });
  } catch (e) {
    console.error("[catalog] primary query failed", e);

    // Small fallback query in case the Archive search endpoint changes its
    // handling of the mediatype field. This still avoids license assumptions.
    try {
      const fallback = await fetch(`${IA}/advancedsearch.php?q=mediatype%3Amovies&rows=25&output=json`);
      if (fallback.ok) {
        const data = await fallback.json();
        const metas = (data.response?.docs || [])
          .filter(x => x && x.identifier)
          .map(x => ({
            id: `ia:${x.identifier}`,
            type: "movie",
            name: x.title || x.identifier,
            ...(x.year ? { year: Number(x.year) } : {}),
            poster: `${IA}/services/img/${encodeURIComponent(x.identifier)}`
          }));
        console.log(`[catalog] fallback returning ${metas.length} records`);
        return res.json({ metas });
      }
    } catch (fallbackError) {
      console.error("[catalog] fallback failed", fallbackError);
    }

    return res.status(502).json({ metas: [] });
  }
});

app.get("/meta/movie/:id.json", async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id).replace(/^ia:/i, "");
    const data = await archiveMetadata(id);
    res.json({ meta: {
      id: `ia:${id}`,
      type: "movie",
      name: data.metadata?.title || id,
      description: data.metadata?.description || "",
      ...(data.metadata?.year ? { year: Number(data.metadata.year) } : {}),
      poster: `${IA}/services/img/${encodeURIComponent(id)}`
    }});
  } catch (e) {
    console.error("[meta]", e);
    res.status(502).json({ meta: null });
  }
});

app.get("/stream/movie/:id.json", async (req, res) => {
  try {
    const requestedId = decodeURIComponent(req.params.id);

    if (OPEN_TEST_MOVIES[requestedId]) {
      return res.json({ streams: OPEN_TEST_MOVIES[requestedId].streams });
    }

    if (requestedId.startsWith("ia:")) {
      const id = requestedId.replace(/^ia:/i, "");
      const data = await archiveMetadata(id);

      if (!openlyLicensed(data)) return res.json({ streams: [] });

      const files = videoFiles(data.files).slice(0, 5);
      return res.json({
        streams: files.map(file => makeStream(id, file, data.metadata?.title || id))
      });
    }

    const lookupId = normaliseMovieId(requestedId);
    const title = await cinemetaTitle(lookupId);
    if (!title) return res.json({ streams: [] });

    const matches = await findArchiveItems(title);
    const streams = [];

    for (const match of matches.slice(0, 10)) {
      try {
        const data = await archiveMetadata(match.identifier);
        if (!openlyLicensed(data)) continue;
        const files = videoFiles(data.files);
        for (const file of files.slice(0, 2)) {
          streams.push(makeStream(match.identifier, file, data.metadata?.title || match.title || title));
        }
        if (streams.length >= 5) break;
      } catch (e) {
        console.error("[stream match]", match.identifier, e.message);
      }
    }

    return res.json({ streams: streams.slice(0, 5) });
  } catch (e) {
    console.error("[stream]", e);
    return res.status(502).json({ streams: [] });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "nuvio-archive-addon" }));

app.get("/", (_req, res) => res.send(
  "Nuvio Internet Archive Addon is running. Open /manifest.json to view the manifest."
));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Nuvio Archive Addon listening on port ${PORT}`);
});
