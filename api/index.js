
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

// ============================================================
// INTERNET ARCHIVE MOVIES — VERSION 2.0.0
// ============================================================

const VERSION = "2.0.0";
const HTTP_TIMEOUT = Number(process.env.HTTP_TIMEOUT_MS || 10000);
const MIN_FILE_SIZE = Math.max(50, Number(process.env.MIN_FILE_SIZE_MB || 250)) * 1024 * 1024;
const MAX_ARCHIVES = Math.max(10, Math.min(60, Number(process.env.MAX_ARCHIVES || 50)));
const MAX_STREAMS = Math.max(5, Math.min(30, Number(process.env.MAX_STREAMS || 20)));
const VERIFY_FILES = String(process.env.VERIFY_FILES || "true").toLowerCase() !== "false";
const PREFERRED_LANGUAGES = ["English", "Français"];

const http = axios.create({
    timeout: HTTP_TIMEOUT,
    headers: {
        "User-Agent": "InternetArchiveMovies-Stremio/2.0.0"
    },
    maxRedirects: 5
});

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: VERSION,
    name: "Internet Archive Movies",
    description: "Films Internet Archive avec recherche IMDb, contrôle des fichiers, langues et qualités.",
    resources: ["catalog", "stream"],
    types: ["movie"],
    catalogs: [{
        type: "movie",
        id: "ia_movies",
        name: "Internet Archive",
        extra: [{ name: "search", isRequired: false }]
    }],
    idPrefixes: ["ia:", "tt"]
});

// ============================================================
// NORMALISATION ET CORRESPONDANCE DES TITRES
// ============================================================

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getYear(value) {
    const match = String(value || "").match(/\b(19\d{2}|20\d{2})\b/);
    return match ? Number(match[1]) : null;
}

function coreWords(value) {
    const ignored = new Set([
        "the", "a", "an", "of", "and", "to",
        "in", "on", "for", "film", "movie"
    ]);

    return normalizeText(value)
        .split(" ")
        .filter(word => word.length > 1 && !ignored.has(word));
}

function titleMatchScore(candidate, targetTitle, targetYear) {
    if (!targetTitle) {
        return { score: 0, percent: 0, yearPenalty: false };
    }

    const candidateNorm = normalizeText(candidate);
    const targetNorm = normalizeText(targetTitle);
    const targetWords = [...new Set(coreWords(targetTitle))];
    const candidateWords = new Set(coreWords(candidate));

    if (!candidateNorm || !targetNorm || !targetWords.length) {
        return { score: 0, percent: 0, yearPenalty: false };
    }

    const matched = targetWords.filter(word => candidateWords.has(word)).length;
    let ratio = matched / targetWords.length;

    if (
        candidateNorm.includes(targetNorm) ||
        targetNorm.includes(candidateNorm)
    ) {
        ratio = Math.max(ratio, 0.96);
    }

    const candidateYear = getYear(candidate);
    let yearPenalty = false;

    if (targetYear && candidateYear) {
        const delta = Math.abs(candidateYear - Number(targetYear));

        if (delta === 0) ratio += 0.04;
        else if (delta === 1) ratio -= 0.03;
        else {
            ratio -= 0.22;
            yearPenalty = true;
        }
    }

    ratio = Math.max(0, Math.min(1, ratio));

    return {
        score: ratio,
        percent: Math.round(ratio * 100),
        yearPenalty
    };
}

function safeSearchText(value) {
    return String(value || "")
        .replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// ============================================================
// LANGUES
// ============================================================

function detectLanguage(value) {
    const text = normalizeText(value);

    if (/\b(french|francais|vf|vostfr|french dub|french dubbed)\b/.test(text))
        return "Français";

    if (/\b(english|anglais|eng|original audio)\b/.test(text))
        return "English";

    if (/\b(hindi|indian dubbed)\b/.test(text))
        return "Hindi (doublé)";

    if (/\b(arabic|arab|arabe)\b/.test(text))
        return "Arabe (doublé)";

    if (/\b(spanish|espanol|castellano|latino)\b/.test(text))
        return "Español (doublé)";

    if (/\b(german|deutsch)\b/.test(text))
        return "Deutsch (doublé)";

    if (/\b(italian|italiano)\b/.test(text))
        return "Italiano (doublé)";

    if (/\b(russian|russian dubbed)\b/.test(text))
        return "Russe (doublé)";

    if (/\b(tamil|telugu|bengali|korean|japanese|portuguese|turkish)\b/.test(text))
        return "Autre langue (doublé)";

    return "Langue non précisée";
}

function languageRank(language) {
    if (PREFERRED_LANGUAGES.includes(language)) return 0;
    if (language === "Langue non précisée") return 1;
    return 2;
}

// ============================================================
// QUALITÉ VIDÉO ET CODEC
// ============================================================

function getQuality(filename, archiveTitle) {
    const text = `${filename || ""} ${archiveTitle || ""}`.toLowerCase();

    let quality = "SD/HD";
    let score = 10;

    if (/2160p|4k|uhd/.test(text)) {
        quality = "4K";
        score = 40;
    } else if (/1080p|1920x1080/.test(text)) {
        quality = "1080p";
        score = 30;
    } else if (/720p|1280x720/.test(text)) {
        quality = "720p";
        score = 20;
    } else if (/480p|854x480/.test(text)) {
        quality = "480p";
        score = 8;
    } else if (/360p/.test(text)) {
        quality = "360p";
        score = 4;
    }

    let source = "";

    if (/web[ ._-]?dl|webrip/.test(text))
        source = "WEB-DL";
    else if (/blu[ ._-]?ray|bdrip|brrip/.test(text))
        source = "BluRay";
    else if (/dvdrip|dvd/.test(text))
        source = "DVDRip";
    else if (/hdtv/.test(text))
        source = "HDTV";

    let codec = "";

    if (/hevc|h265|x265/.test(text))
        codec = "HEVC";
    else if (/avc|h264|x264/.test(text))
        codec = "H.264";

    return { quality, score, source, codec };
}

function formatSize(bytes) {
    const size = Number(bytes) || 0;

    if (size >= 1024 ** 3) {
        return `${(size / (1024 ** 3)).toFixed(1)} GB`;
    }

    return `${Math.round(size / (1024 ** 2))} MB`;
}

function encodeArchivePath(filename) {
    return String(filename)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
}

// ============================================================
// DURÉE VIDÉO
// ============================================================

function parseDuration(value) {
    if (value == null || value === "") return null;

    if (
        typeof value === "number" ||
        /^\d+(\.\d+)?$/.test(String(value).trim())
    ) {
        const seconds = Number(value);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }

    const parts = String(value).trim().split(":").map(Number);

    if (parts.some(part => !Number.isFinite(part))) return null;

    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }

    return null;
}

function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return "Durée non indiquée";

    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;

    return hours
        ? `${hours}h ${String(remaining).padStart(2, "0")}m`
        : `${minutes} min`;
}

function getDuration(metadata, file) {
    const candidates = [
        file && file.length,
        file && file.runtime,
        metadata && metadata.runtime,
        metadata && metadata.length,
        metadata && metadata.duration
    ];

    for (const value of candidates) {
        const parsed = parseDuration(value);
        if (parsed) return parsed;
    }

    return null;
}

// ============================================================
// RECHERCHE INTERNET ARCHIVE
// ============================================================

async function advancedSearch(query, rows = MAX_ARCHIVES) {
    const url = "https://archive.org/advancedsearch.php";
    const params = new URLSearchParams();

    params.set("q", query);

    for (const field of [
        "identifier",
        "title",
        "year",
        "downloads",
        "description"
    ]) {
        params.append("fl[]", field);
    }

    params.append("sort[]", "downloads desc");
    params.set("rows", String(rows));
    params.set("page", "1");
    params.set("output", "json");

    const response = await http.get(
        `${url}?${params.toString()}`
    );

    return response.data?.response?.docs || [];
}

async function searchArchiveItems(title, year, imdbId) {
    const cleanTitle = safeSearchText(title);
    const words = [...new Set(coreWords(cleanTitle))];

    if (!cleanTitle || !words.length) return [];

    const queries = [];

    // Recherche du titre complet.
    queries.push(
        `mediatype:movies AND title:"${cleanTitle}"`
    );

    // Recherche par tous les mots importants.
    if (words.length >= 2) {
        queries.push(
            `mediatype:movies AND title:(${words.join(" AND ")})`
        );

        queries.push(
            `mediatype:movies AND (${words.map(word => `title:${word}`).join(" AND ")})`
        );
    }

    // Recherche élargie dans les métadonnées.
    if (words.length >= 2) {
        queries.push(
            `mediatype:movies AND (${words.slice(0, 2).map(word => `(${word})`).join(" AND ")})`
        );
    }

    // Recherche secondaire IMDb.
    if (imdbId) {
        queries.push(
            `mediatype:movies AND identifier:${imdbId}`
        );
    }

    const results = await Promise.allSettled(
        [...new Set(queries)].map(query =>
            advancedSearch(query, MAX_ARCHIVES)
        )
    );

    const byIdentifier = new Map();

    for (const result of results) {
        if (result.status !== "fulfilled") continue;

        for (const doc of result.value) {
            if (!doc.identifier) continue;

            const previous = byIdentifier.get(doc.identifier);

            if (
                !previous ||
                Number(doc.downloads || 0) > Number(previous.downloads || 0)
            ) {
                byIdentifier.set(doc.identifier, doc);
            }
        }
    }

    return [...byIdentifier.values()]
        .map(doc => {
            const docTitle = Array.isArray(doc.title)
                ? doc.title[0]
                : (doc.title || doc.identifier);

            const match = titleMatchScore(
                `${docTitle} ${doc.identifier}`,
                title,
                year
            );

            return {
                ...doc,
                _title: docTitle,
                _match: match
            };
        })
        .filter(doc => {
            return (
                doc._match.score >= 0.55 ||
                String(doc.identifier).toLowerCase().includes(
                    String(imdbId || "__none__").toLowerCase()
                )
            );
        })
        .sort((a, b) => {
            if (a._match.score !== b._match.score) {
                return b._match.score - a._match.score;
            }

            return Number(b.downloads || 0) - Number(a.downloads || 0);
        })
        .slice(0, MAX_ARCHIVES);
}

// ============================================================
// VÉRIFICATION DES FICHIERS
// ============================================================

async function verifyRemoteFile(url) {
    if (!VERIFY_FILES) return true;

    let response;

    try {
        response = await http.get(url, {
            responseType: "stream",
            headers: { Range: "bytes=0-0" },
            timeout: 7000,
            validateStatus: () => true
        });

        const valid =
            response.status === 206 ||
            response.status === 200;

        if (
            response.data &&
            typeof response.data.destroy === "function"
        ) {
            response.data.destroy();
        }

        return valid;

    } catch (error) {
        if (
            response?.data &&
            typeof response.data.destroy === "function"
        ) {
            response.data.destroy();
        }

        return false;
    }
}

async function mapLimit(items, limit, worker) {
    const output = new Array(items.length);
    let cursor = 0;

    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (true) {
                const index = cursor++;

                if (index >= items.length) return;

                try {
                    output[index] = await worker(items[index], index);
                } catch (_) {
                    output[index] = null;
                }
            }
        }
    );

    await Promise.all(workers);

    return output;
}

// ============================================================
// EXTRACTION DES STREAMS INTERNET ARCHIVE
// ============================================================

async function getStreamsFromIA(
    identifier,
    targetTitle = null,
    targetYear = null,
    imdbId = null,
    searchDoc = null
) {
    try {
        const response = await http.get(
            `https://archive.org/metadata/${encodeURIComponent(identifier)}`
        );

        const metadata = response.data?.metadata || {};
        const files = Array.isArray(response.data?.files)
            ? response.data.files
            : [];

        const archiveTitle = Array.isArray(metadata.title)
            ? metadata.title[0]
            : (metadata.title || searchDoc?._title || identifier);

        const imdbText = JSON.stringify(metadata).toLowerCase();

        const imdbMatch = Boolean(
            imdbId && imdbText.includes(String(imdbId).toLowerCase())
        );

        const archiveMatch = titleMatchScore(
            `${archiveTitle} ${identifier}`,
            targetTitle || archiveTitle,
            targetYear
        );

        const archiveDownloads = Number(searchDoc?.downloads || 0);

        // Filtrage des fichiers vidéo.
        const candidates = files.filter(file => {
            if (!file?.name) return false;

            const name = String(file.name);
            const lower = name.toLowerCase();

            // IMPORTANT : les fichiers .ia.mp4 sont acceptés.
            if (!/\.(mp4|mkv|m4v|avi|webm|ogv|mov)$/i.test(lower)) {
                return false;
            }

            if (
                /(trailer|sample|teaser|clip|advertisement|commentary|review|behind[ ._-]?the[ ._-]?scenes|deleted[ ._-]?scenes|bloopers|making[ ._-]?of|preview|proof|thumbnail)/i.test(lower)
            ) {
                return false;
            }

            const size = Number(file.size || 0);

            if (!Number.isFinite(size) || size < MIN_FILE_SIZE) {
                return false;
            }

            if (targetTitle) {
                const fileMatch = titleMatchScore(
                    `${name} ${archiveTitle}`,
                    targetTitle,
                    targetYear
                );

                if (
                    fileMatch.score < 0.48 &&
                    archiveMatch.score < 0.68 &&
                    !imdbMatch
                ) {
                    return false;
                }
            }

            return true;
        });

        // Préparation des résultats.
        const prepared = candidates.map(file => {
            const filename = String(file.name).split("/").pop();
            const size = Number(file.size || 0);

            const match = titleMatchScore(
                `${filename} ${archiveTitle}`,
                targetTitle || archiveTitle,
                targetYear
            );

            const quality = getQuality(filename, archiveTitle);

            const language = detectLanguage(
                `${filename} ${archiveTitle} ${metadata.language || ""}`
            );

            const duration = getDuration(metadata, file);

            return {
                file,
                filename,
                size,
                match,
                quality,
                language,
                duration
            };
        })
        .filter(item => {
            return !item.duration || item.duration >= 45 * 60;
        })
        .sort((a, b) => {
            // Français / anglais d'abord.
            if (languageRank(a.language) !== languageRank(b.language)) {
                return languageRank(a.language) - languageRank(b.language);
            }

            if (a.match.score !== b.match.score) {
                return b.match.score - a.match.score;
            }

            if (a.quality.score !== b.quality.score) {
                return b.quality.score - a.quality.score;
            }

            return b.size - a.size;
        })
        .slice(0, 8);

        // Vérification de disponibilité des fichiers.
        const checked = await mapLimit(
            prepared,
            4,
            async item => {
                const url =
                    `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeArchivePath(item.file.name)}`;

                if (!(await verifyRemoteFile(url))) return null;

                return { ...item, url };
            }
        );

        return checked.filter(Boolean).map(item => {
            const ext = item.filename.split(".").pop().toUpperCase();

            const details = [item.quality.quality];

            if (item.quality.source) details.push(item.quality.source);
            if (item.quality.codec) details.push(item.quality.codec);

            const durationText = item.duration
                ? `${formatDuration(item.duration)} ✓`
                : "Durée non vérifiée";

            const matchPercent = imdbMatch
                ? 100
                : Math.max(item.match.percent, archiveMatch.percent);

            const matchLabel = imdbMatch
                ? "IMDb match"
                : `${matchPercent}% match`;

            const downloadsLabel = archiveDownloads > 0
                ? ` · ⇩ ${archiveDownloads.toLocaleString("en-US")}`
                : "";

            return {
                name: "🏛 Archive\n〈Full Movie〉",

                title:
                    `✎ ${item.filename}\n` +
                    `◈ ${durationText} · ${formatSize(item.size)} · ${ext}\n` +
                    `◆ ${details.join(" · ")}\n` +
                    `◐ ${item.language}\n` +
                    `◎ ${matchLabel}${downloadsLabel}`,

                url: item.url,

                behaviorHints: {
                    filename: item.filename,
                    videoSize: item.size,
                    notWebReady: false
                },

                _imdb: imdbMatch,
                _match: matchPercent,
                _languageRank: languageRank(item.language),
                _quality: item.quality.score,
                _downloads: archiveDownloads,
                _size: item.size
            };
        });

    } catch (error) {
        console.error(
            `[IA metadata] ${identifier}: ${error.message}`
        );

        return [];
    }
}

// ============================================================
// NETTOYAGE DES CHAMPS INTERNES
// ============================================================

function stripInternal(stream) {
    const result = { ...stream };

    delete result._imdb;
    delete result._match;
    delete result._languageRank;
    delete result._quality;
    delete result._downloads;
    delete result._size;

    return result;
}

// ============================================================
// CATALOGUE
// ============================================================

builder.defineCatalogHandler(async ({ extra }) => {
    try {
        let query = "mediatype:movies";

        if (extra?.search) {
            const search = safeSearchText(extra.search);

            if (!search) return { metas: [] };

            query += ` AND title:(${search.split(" ").join(" AND ")})`;
        } else {
            query +=
                " AND (collection:feature_films OR collection:opensource_movies)";
        }

        const docs = await advancedSearch(query, 30);

        const metas = docs
            .filter(doc => doc.identifier)
            .map(doc => {
                const title = Array.isArray(doc.title)
                    ? doc.title[0]
                    : (doc.title || doc.identifier);

                const description = Array.isArray(doc.description)
                    ? doc.description[0]
                    : (doc.description || "Film disponible sur Internet Archive.");

                return {
                    id: `ia:${doc.identifier}`,
                    type: "movie",
                    name: title,
                    description,
                    releaseInfo: doc.year
                        ? String(doc.year).slice(0, 4)
                        : undefined,
                    poster:
                        `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`
                };
            });

        return { metas };

    } catch (error) {
        console.error("Erreur catalogue IA:", error.message);
        return { metas: [] };
    }
});

// ============================================================
// STREAMS STREMIO
// ============================================================

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie" || !id) {
        return { streams: [] };
    }

    // Film lancé depuis le catalogue Internet Archive.
    if (id.startsWith("ia:")) {
        const identifier = id.slice(3);

        const streams = await getStreamsFromIA(identifier);

        return {
            streams: streams.map(stripInternal),
            cacheMaxAge: 1800
        };
    }

    // Recherche par IMDb.
    if (!/^tt\d+$/.test(id)) {
        return { streams: [] };
    }

    try {
        const cinemeta = await http.get(
            `https://v3-cinemeta.strem.io/meta/movie/${id}.json`
        );

        const movie = cinemeta.data?.meta;

        if (!movie?.name) return { streams: [] };

        const title = movie.name;

        const year = movie.year
            ? String(movie.year).slice(0, 4)
            : null;

        const docs = await searchArchiveItems(title, year, id);

        console.log(
            `[IA search] ${id} — ${title} (${year || "year unknown"}) — ${docs.length} archives candidates`
        );

        const groups = await mapLimit(
            docs,
            4,
            doc => getStreamsFromIA(
                doc.identifier,
                title,
                year,
                id,
                doc
            )
        );

        const all = groups.flat().sort((a, b) => {
            // Correspondance IMDb, langue, qualité, popularité, taille.
            if (a._imdb !== b._imdb) {
                return a._imdb ? -1 : 1;
            }

            if (a._languageRank !== b._languageRank) {
                return a._languageRank - b._languageRank;
            }

            if (a._match !== b._match) {
                return b._match - a._match;
            }

            if (a._quality !== b._quality) {
                return b._quality - a._quality;
            }

            if (a._downloads !== b._downloads) {
                return b._downloads - a._downloads;
            }

            return b._size - a._size;
        });

        const unique = [];
        const seen = new Set();

        for (const stream of all) {
            if (seen.has(stream.url)) continue;

            seen.add(stream.url);
            unique.push(stripInternal(stream));

            if (unique.length >= MAX_STREAMS) break;
        }

        console.log(
            `[IA streams] ${id} — ${unique.length} verified streams returned`
        );

        return {
            streams: unique,
            cacheMaxAge: 1800
        };

    } catch (error) {
        console.error(
            `[IMDb -> IA] ${id}: ${error.message}`
        );

        return { streams: [] };
    }
});

// ============================================================
// EXPRESS — HUGGING FACE / VERCEL
// ============================================================

const app = express();

app.use(
    express.static(path.join(__dirname, "../public"))
);

app.use(
    getRouter(builder.getInterface())
);

module.exports = app;
