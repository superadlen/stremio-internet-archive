
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

// ============================================
// INTERNET ARCHIVE MOVIES — VERSION 1.9.0
// ============================================

const MIN_FILE_SIZE = Math.max(
    50,
    Number(process.env.MIN_FILE_SIZE_MB || 250)
) * 1024 * 1024;

const MAX_ARCHIVES = Math.max(
    5,
    Math.min(30, Number(process.env.MAX_ARCHIVES || 15))
);

const HTTP_TIMEOUT = 8000;

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.9.0",
    name: "Internet Archive Movies",
    description: "Films complets depuis Internet Archive.",
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

// ============================================
// NORMALISATION
// ============================================

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

function titleMatches(candidate, targetTitle, targetYear) {
    if (!targetTitle) return true;

    const candidateNorm = normalizeText(candidate);
    const titleNorm = normalizeText(targetTitle);

    if (!candidateNorm || !titleNorm) return false;

    const candidateYear = getYear(candidate);

    if (
        targetYear &&
        candidateYear &&
        Math.abs(candidateYear - Number(targetYear)) > 1
    ) {
        return false;
    }

    if (candidateNorm === titleNorm) return true;

    const candidateWords = candidateNorm.split(" ");
    const words = titleNorm.split(" ").filter(w => w.length > 1);

    if (!words.length) return candidateWords.includes(titleNorm);

    return words.every(word => candidateWords.includes(word));
}

function containsImdbId(metadata, imdbId) {
    if (!imdbId || !metadata) return false;

    const values = [];

    for (const [key, value] of Object.entries(metadata)) {
        if (/imdb|external|identifier/i.test(key)) {
            values.push(value);
        }
    }

    return JSON.stringify(values)
        .toLowerCase()
        .includes(String(imdbId).toLowerCase());
}

// ============================================
// LANGUE
// ============================================

function detectLanguage(text) {
    const value = String(text || "").toLowerCase();

    if (/\b(french|français|vf|vostfr)\b/.test(value))
        return "Français";

    if (/\b(english|anglais|eng)\b/.test(value))
        return "English";

    if (/\b(spanish|español|esp)\b/.test(value))
        return "Español";

    if (/\b(german|deutsch)\b/.test(value))
        return "Deutsch";

    if (/\b(italian|italiano)\b/.test(value))
        return "Italiano";

    return "Langue non précisée";
}

// ============================================
// QUALITÉ VIDÉO
// ============================================

function qualityInfo(filename, archiveTitle) {
    const value =
        `${filename || ""} ${archiveTitle || ""}`.toLowerCase();

    let quality = "Qualité non précisée";
    let score = 0;

    if (/2160p|4k|uhd/.test(value)) {
        quality = "4K";
        score = 40;
    } else if (/1080p|1920x1080/.test(value)) {
        quality = "1080p";
        score = 30;
    } else if (/720p|1280x720/.test(value)) {
        quality = "720p";
        score = 20;
    } else if (/480p|854x480/.test(value)) {
        quality = "480p";
        score = 10;
    } else if (/360p/.test(value)) {
        quality = "360p";
        score = 5;
    }

    let source = "";

    if (/web[ ._-]?dl|webrip/.test(value))
        source = "WEB";
    else if (/blu[ ._-]?ray|bdrip/.test(value))
        source = "BluRay";
    else if (/dvdrip|dvd/.test(value))
        source = "DVD";
    else if (/hdtv/.test(value))
        source = "HDTV";

    let codec = "";

    if (/hevc|h265|x265/.test(value))
        codec = "HEVC";
    else if (/avc|h264|x264/.test(value))
        codec = "H.264";

    return { quality, score, source, codec };
}

function formatSize(bytes) {
    const gb = bytes / (1024 ** 3);

    return gb >= 1
        ? `${gb.toFixed(2)} GB`
        : `${Math.round(bytes / (1024 ** 2))} MB`;
}

function encodeArchivePath(filename) {
    return String(filename)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
}

// ============================================
// VÉRIFICATION FICHIER DISTANT
// ============================================

async function isRemoteFileAvailable(url) {
    try {
        const head = await axios.head(url, {
            timeout: 5000,
            maxRedirects: 5,
            validateStatus: () => true
        });

        if (head.status >= 200 && head.status < 300) {
            const length = head.headers["content-length"];

            return length == null || Number(length) > 0;
        }

        if (![403, 405, 501].includes(head.status)) {
            return false;
        }
    } catch (_) {
        // Certains serveurs IA refusent HEAD.
    }

    let response;

    try {
        response = await axios.get(url, {
            responseType: "stream",
            headers: { Range: "bytes=0-0" },
            timeout: 6000,
            maxRedirects: 5,
            validateStatus: () => true
        });

        const valid =
            response.status === 200 ||
            response.status === 206;

        if (response.data?.destroy) {
            response.data.destroy();
        }

        return valid;
    } catch (_) {
        if (response?.data?.destroy) {
            response.data.destroy();
        }

        return false;
    }
}

// ============================================
// LIMITATION DES REQUÊTES SIMULTANÉES
// ============================================

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;

    const runners = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (true) {
                const index = next++;

                if (index >= items.length) return;

                try {
                    results[index] = await worker(items[index], index);
                } catch (_) {
                    results[index] = null;
                }
            }
        }
    );

    await Promise.all(runners);

    return results;
}

// ============================================
// RECHERCHE DES VIDÉOS INTERNET ARCHIVE
// ============================================

async function getStreamsFromIA(
    identifier,
    targetTitle = null,
    targetYear = null,
    imdbId = null
) {
    try {
        const metadataResponse = await axios.get(
            `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
            { timeout: HTTP_TIMEOUT }
        );

        const metadata = metadataResponse.data?.metadata;
        const files = metadataResponse.data?.files;

        if (!metadata || !Array.isArray(files)) return [];

        const archiveTitle = Array.isArray(metadata.title)
            ? metadata.title[0]
            : (metadata.title || identifier);

        const imdbMatch = containsImdbId(metadata, imdbId);

        const archiveTitleMatch = targetTitle
            ? titleMatches(
                `${archiveTitle} ${identifier}`,
                targetTitle,
                targetYear
            )
            : true;

        const candidates = files.filter(file => {
            if (!file || !file.name) return false;

            const name = String(file.name);
            const lower = name.toLowerCase();

            if (lower.endsWith(".ia.mp4")) return false;

            if (!/\.(mp4|mkv|m4v|avi|webm|ogv)$/i.test(lower)) {
                return false;
            }

            if (
                /(trailer|sample|teaser|clip|advertisement|commentary|review|behind[ ._-]?the[ ._-]?scenes|deleted[ ._-]?scenes|bloopers|making[ ._-]?of|preview|intro|outro)/i.test(lower)
            ) {
                return false;
            }

            const size = Number(file.size || 0);

            if (!Number.isFinite(size) || size < MIN_FILE_SIZE) {
                return false;
            }

            if (
                targetTitle &&
                !archiveTitleMatch &&
                !imdbMatch &&
                !titleMatches(name, targetTitle, targetYear)
            ) {
                return false;
            }

            return true;
        });

        const rankedCandidates = candidates
            .map(file => {
                const size = Number(file.size || 0);
                const quality = qualityInfo(file.name, archiveTitle);

                const fileTitleMatch = targetTitle
                    ? titleMatches(file.name, targetTitle, targetYear)
                    : false;

                return {
                    file,
                    size,
                    quality,
                    fileTitleMatch
                };
            })
            .sort((a, b) => {
                if (a.quality.score !== b.quality.score) {
                    return b.quality.score - a.quality.score;
                }

                return b.size - a.size;
            })
            .slice(0, 6);

        const verified = await mapLimit(
            rankedCandidates,
            3,
            async item => {
                const url =
                    `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeArchivePath(item.file.name)}`;

                return await isRemoteFileAvailable(url)
                    ? { ...item, url }
                    : null;
            }
        );

        return verified.filter(Boolean).map(item => {
            const filename = String(item.file.name).split("/").pop();
            const ext = filename.split(".").pop().toUpperCase();

            const language = detectLanguage(
                `${filename} ${archiveTitle} ${JSON.stringify(metadata.language || "")}`
            );

            const details = [item.quality.quality];

            if (item.quality.source) {
                details.push(item.quality.source);
            }

            if (item.quality.codec) {
                details.push(item.quality.codec);
            }

            const matchLabel = imdbMatch
                ? "IMDb confirmé"
                : item.fileTitleMatch
                    ? "Titre du fichier correspondant"
                    : "Titre de l'archive correspondant";

            return {
                name: "🏛 INTERNET ARCHIVE",

                title:
                    `🎬 ${filename}\n` +
                    `📦 ${formatSize(item.size)} · ${ext}\n` +
                    `🎞 ${details.join(" · ")}\n` +
                    `🌍 ${language} · ${matchLabel}`,

                url: item.url,

                behaviorHints: {
                    filename,
                    videoSize: item.size,
                    notWebReady: ext !== "MP4"
                },

                _imdbMatch: imdbMatch,
                _titleMatch: item.fileTitleMatch,
                _qualityScore: item.quality.score,
                _size: item.size
            };
        });

    } catch (error) {
        console.error(
            `[IA metadata] ${identifier}:`,
            error.message
        );

        return [];
    }
}

// ============================================
// NETTOYAGE DE LA RECHERCHE
// ============================================

function cleanSearchText(value) {
    return String(value || "")
        .replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// ============================================
// CATALOGUE INTERNET ARCHIVE
// ============================================

builder.defineCatalogHandler(async ({ extra }) => {
    try {
        let query = "mediatype:(movies)";

        if (extra && extra.search) {
            const search = cleanSearchText(extra.search);

            if (!search) return { metas: [] };

            query += ` AND title:("${search}")`;
        } else {
            query +=
                " AND (collection:(feature_films) OR collection:(opensource_movies))";
        }

        const url =
            `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}` +
            `&fl[]=identifier,title,description,year` +
            `&sort[]=downloads+desc&rows=30&output=json`;

        const response = await axios.get(url, {
            timeout: HTTP_TIMEOUT
        });

        const docs = response.data?.response?.docs || [];

        const metas = docs
            .filter(doc => doc.identifier)
            .map(doc => ({
                id: `ia:${doc.identifier}`,
                type: "movie",

                name: Array.isArray(doc.title)
                    ? doc.title[0]
                    : (doc.title || doc.identifier),

                description: Array.isArray(doc.description)
                    ? doc.description[0]
                    : (doc.description || "Film disponible sur Internet Archive."),

                releaseInfo: doc.year
                    ? String(doc.year).slice(0, 4)
                    : undefined,

                poster:
                    `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`
            }));

        return { metas };

    } catch (error) {
        console.error("Erreur catalogue IA:", error.message);

        return { metas: [] };
    }
});

// ============================================
// GESTION DES STREAMS STREMIO
// ============================================

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie" || !id) {
        return { streams: [] };
    }

    // Film sélectionné directement depuis le catalogue IA
    if (id.startsWith("ia:")) {
        const identifier = id.slice(3);

        const streams = await getStreamsFromIA(identifier);

        return {
            streams: streams.map(stripInternalFields),
            cacheMaxAge: 3600
        };
    }

    // Recherche IMDb
    if (!/^tt\d+$/.test(id)) {
        return { streams: [] };
    }

    try {
        const cinemetaResponse = await axios.get(
            `https://v3-cinemeta.strem.io/meta/movie/${id}.json`,
            { timeout: HTTP_TIMEOUT }
        );

        const movie = cinemetaResponse.data?.meta;

        if (!movie?.name) return { streams: [] };

        const title = movie.name;

        const year = movie.year
            ? String(movie.year).slice(0, 4)
            : null;

        const searchTitle = cleanSearchText(title);

        if (!searchTitle) return { streams: [] };

        const query =
            `mediatype:(movies) AND (identifier:${id} OR title:("${searchTitle}"))`;

        const searchUrl =
            `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}` +
            `&fl[]=identifier,title,year` +
            `&sort[]=downloads+desc&rows=${MAX_ARCHIVES}&output=json`;

        const searchResponse = await axios.get(searchUrl, {
            timeout: HTTP_TIMEOUT
        });

        const docs = searchResponse.data?.response?.docs || [];

        const results = await mapLimit(
            docs.filter(doc => doc.identifier),
            4,
            doc => getStreamsFromIA(
                doc.identifier,
                title,
                year,
                id
            )
        );

        const allStreams = results
            .flat()
            .sort((a, b) => {
                if (a._imdbMatch !== b._imdbMatch) {
                    return a._imdbMatch ? -1 : 1;
                }

                if (a._titleMatch !== b._titleMatch) {
                    return a._titleMatch ? -1 : 1;
                }

                if (a._qualityScore !== b._qualityScore) {
                    return b._qualityScore - a._qualityScore;
                }

                return b._size - a._size;
            });

        const unique = [];
        const seen = new Set();

        for (const stream of allStreams) {
            if (!seen.has(stream.url)) {
                seen.add(stream.url);
                unique.push(stripInternalFields(stream));
            }
        }

        return {
            streams: unique.slice(0, 20),
            cacheMaxAge: 1800
        };

    } catch (error) {
        console.error(
            `Erreur IMDb ${id} -> Internet Archive:`,
            error.message
        );

        return { streams: [] };
    }
});

// ============================================
// SUPPRESSION DES CHAMPS INTERNES
// ============================================

function stripInternalFields(stream) {
    const clean = { ...stream };

    delete clean._imdbMatch;
    delete clean._titleMatch;
    delete clean._qualityScore;
    delete clean._size;

    return clean;
}

// ============================================
// SERVEUR EXPRESS
// ============================================

const app = express();

app.use(
    express.static(path.join(__dirname, "../public"))
);

app.use(
    getRouter(builder.getInterface())
);

module.exports = app;
