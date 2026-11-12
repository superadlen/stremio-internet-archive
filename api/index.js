const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "2.1.0",
    name: "Internet Archive Movies",
    description: "Recherche et diffuse des films depuis Internet Archive (Community Video & Feature Films).",
    resources: ["catalog", "stream"],
    types: ["movie"],
    catalogs: [
        {
            type: "movie",
            id: "ia_movies",
            name: "Internet Archive",
            extra: [{ name: "search", isRequired: false }]
        }
    ],
    idPrefixes: ["ia:", "tt"]
});

/* ============================================================
   UTILITAIRES DE NORMALISATION
   ============================================================ */

function normalizeText(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Retire les articles "the/a/an" pour comparer les titres
function stripArticles(normStr) {
    return normStr
        .split(" ")
        .filter(w => !["the", "a", "an"].includes(w))
        .join(" ")
        .trim();
}

/* ============================================================
   MATCHING STRICT (3 niveaux de comparaison)
   ============================================================ */

function isMatch(candidateText, targetTitle, targetYear) {
    const normCandidate = normalizeText(candidateText);
    const normTitle = normalizeText(targetTitle);
    if (!normTitle || !normCandidate) return false;

    // Comparaison 1 : titre complet par mots entiers
    const titlePattern = new RegExp(`(^|\\s)${escapeRegExp(normTitle)}(\\s|$)`);
    let titleFound = titlePattern.test(normCandidate);

    // Comparaison 2 : séquence contiguë des mots (ordre respecté)
    if (!titleFound) {
        const titleWords = normTitle.split(" ").filter(w => w.length > 1);
        if (titleWords.length > 0) {
            const joined = " " + normCandidate + " ";
            const seq = " " + titleWords.join(" ") + " ";
            if (joined.includes(seq)) titleFound = true;
        }
    }

    // Comparaison 3 : sans articles (The Twilight Saga Eclipse == Twilight Saga Eclipse)
    if (!titleFound) {
        const strippedTitle = stripArticles(normTitle);
        const strippedCandidate = stripArticles(normCandidate);
        if (strippedTitle && strippedTitle !== normTitle) {
            const strippedPattern = new RegExp(`(^|\\s)${escapeRegExp(strippedTitle)}(\\s|$)`);
            if (strippedPattern.test(strippedCandidate)) titleFound = true;
        }
    }

    if (!titleFound) return false;

    // Anti-séquelles (uniquement si la cible n'est pas elle-même une suite)
    const isSequelTarget = /\b(part\s*\d+|chapter\s*\d+|\bii\b|\biii\b|\biv\b)\b/.test(normTitle);
    if (!isSequelTarget) {
        const sequelMarkers = /\b(part\s*[2-9]|part\s*(ii|iii|iv)|chapter\s*[2-9]|\b(ii|iii|iv|v)\b|reloaded|revenge|returns|rises|forever|reborn|resurrection|awakening|legacy|origins|begins)\b/;
        const idx = normCandidate.indexOf(normTitle);
        if (idx >= 0) {
            const after = normCandidate.substring(idx + normTitle.length).trim();
            if (sequelMarkers.test(after)) return false;
        }
    }

    // Vérification de l'année (tolérance ±1 an)
    const yearMatch = normCandidate.match(/\b(19\d{2}|20\d{2})\b/);
    if (targetYear && yearMatch) {
        const foundYear = parseInt(yearMatch[1], 10);
        const expectedYear = parseInt(targetYear, 10);
        if (Math.abs(foundYear - expectedYear) > 1) return false;
    }

    return true;
}

/* ============================================================
   LANGUE / QUALITÉ / SCORES
   ============================================================ */

function detectLanguage(text) {
    const lower = text.toLowerCase();
    if (lower.includes("french") || lower.includes("vf") || lower.includes("vostfr") || lower.includes("french.")) return "Français";
    if (lower.includes("english") || lower.includes("eng") || lower.includes("en.")) return "English";
    if (lower.includes("spanish") || lower.includes("esp")) return "Español";
    if (lower.includes("german") || lower.includes("deutsch")) return "Deutsch";
    if (lower.includes("italian") || lower.includes("italiano")) return "Italiano";
    return "English / Multilingual";
}

function getQualityScore(filename, archiveTitle) {
    const text = (filename + " " + archiveTitle).toLowerCase();
    let score = 0;

    if (text.includes("web-dl") || text.includes("webdl") || text.includes("web rip") || text.includes("webrip")) score += 50;
    else if (text.includes("bluray") || text.includes("blu-ray") || text.includes("bdrip")) score += 45;
    else if (text.includes("dvdrip") || text.includes("dvd")) score += 30;
    else if (text.includes("hdtv")) score += 25;

    if (text.includes("2160p") || text.includes("4k")) score += 40;
    else if (text.includes("1080p")) score += 30;
    else if (text.includes("720p")) score += 20;
    else if (text.includes("480p") || text.includes("sd")) score += 10;

    return score;
}

function getMatchScore(hasImdbMatch, fileMatchesTitle, archiveMatchesTitle) {
    if (hasImdbMatch) return 100;
    if (fileMatchesTitle && archiveMatchesTitle) return 90;
    if (archiveMatchesTitle) return 80;
    if (fileMatchesTitle) return 60;
    return 0;
}

/* ============================================================
   CONSTRUCTION DES REQUÊTES (CORRIGÉE — keyword-based)
   ============================================================ */

function buildSearchQueries(id, title, year) {
    const queries = [];

    // 1. ID IMDb
    queries.push(`mediatype:(movies) AND (${id})`);

    // 2. Recherche par mots-clés (SANS title:)
    const words = title
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(w => w.length > 1 && !["the", "a", "an"].includes(w.toLowerCase()));

    if (words.length > 0) {
        const keywordQuery = words.join(" ");
        if (year) {
            queries.push(`mediatype:(movies) AND (${keywordQuery}) AND year:${year}`);
        }
        queries.push(`mediatype:(movies) AND (${keywordQuery})`);

        if (words.length >= 3) {
            const coreWords = words.slice(0, 3).join(" ");
            if (year) {
                queries.push(`mediatype:(movies) AND (${coreWords}) AND year:${year}`);
            }
            queries.push(`mediatype:(movies) AND (${coreWords})`);
        }
    }

    // 3. Recherche par préfixe d'identifiant (le slug du titre est souvent dans l'identifier)
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, ".")
        .trim();
    if (slug.length > 5) {
        queries.push(`mediatype:(movies) AND identifier:(${slug}*)`);
    }

    return queries;
}

/* ============================================================
   RÉCUPÉRATION DES FLUX DEPUIS UN IDENTIFIANT IA
   ============================================================ */

async function getStreamsFromIA(identifier, targetTitle = null, targetYear = null, imdbId = null) {
    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl, { timeout: 6000 });
        const meta = response.data.metadata || {};
        const files = response.data.files || [];

        const archiveTitle = Array.isArray(meta.title) ? meta.title[0] : (meta.title || identifier);
        const archiveDesc = JSON.stringify(meta).toLowerCase();

        const hasImdbMatch = imdbId ? archiveDesc.includes(imdbId.toLowerCase()) : false;
        const archiveMatchesTitle = targetTitle
            ? isMatch(archiveTitle + " " + identifier, targetTitle, targetYear)
            : true;

        const videoFiles = files.filter(f => {
            if (!f.name) return false;
            const lowerName = f.name.toLowerCase();

            if (lowerName.endsWith(".ia.mp4")) return false;

            const isVideoExt = lowerName.endsWith(".mp4")
                || lowerName.endsWith(".mkv")
                || lowerName.endsWith(".avi")
                || lowerName.endsWith(".ogv");
            if (!isVideoExt) return false;

            const isJunk = /(trailer|sample|teaser|clip|advertisement|commentary|review|behind the scenes|deleted scenes|bloopers|making of)/i.test(lowerName);
            if (isJunk) return false;

            const isDoc = /\b(documentary|interview|conference|lecture|panel|q\s*&\s*a|podcast|audiobook)\b/i.test(lowerName);
            if (isDoc && targetTitle && !/\bdocumentary\b/i.test(targetTitle)) return false;

            const fileSize = parseInt(f.size || "0", 10);
            if (fileSize < 150 * 1024 * 1024) return false;

            // --- Logique de matching strict ---
            if (hasImdbMatch) return true;

            if (targetTitle) {
                const fileMatches = isMatch(f.name, targetTitle, targetYear);

                if (!fileMatches && !archiveMatchesTitle) return false;

                if (fileMatches && !archiveMatchesTitle) {
                    const archiveYearMatch = (archiveTitle + " " + identifier).match(/\b(19\d{2}|20\d{2})\b/);
                    if (targetYear && archiveYearMatch) {
                        if (Math.abs(parseInt(archiveYearMatch[1]) - parseInt(targetYear)) > 1) return false;
                    }
                }
                if (archiveMatchesTitle && !fileMatches) {
                    const fileYearMatch = f.name.match(/\b(19\d{2}|20\d{2})\b/);
                    if (targetYear && fileYearMatch) {
                        if (Math.abs(parseInt(fileYearMatch[1]) - parseInt(targetYear)) > 1) return false;
                    }
                }
            }

            return true;
        });

        return videoFiles.map(file => {
            const sizeBytes = parseInt(file.size || "0", 10);
            const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(1);
            const sizeDisplay = sizeGB >= 1 ? `${sizeGB} GB` : `${Math.round(sizeBytes / (1024 * 1024))} MB`;
            const ext = file.name.split('.').pop().toUpperCase();

            const infoStr = (file.name + " " + archiveTitle + " " + (meta.language || "")).toLowerCase();

            let quality = "HD";
            if (infoStr.includes("2160p") || infoStr.includes("4k")) quality = "4K";
            else if (infoStr.includes("1080p")) quality = "1080p";
            else if (infoStr.includes("720p")) quality = "720p";
            else if (infoStr.includes("480p")) quality = "480p";

            let source = "";
            if (infoStr.includes("web-dl") || infoStr.includes("webdl")) source = " · WEB-DL";
            else if (infoStr.includes("bluray") || infoStr.includes("blu-ray")) source = " · BluRay";
            else if (infoStr.includes("dvdrip")) source = " · DVDRip";

            const language = detectLanguage(infoStr);

            let codec = "";
            if (infoStr.includes("hevc") || infoStr.includes("x265")) codec = " · HEVC";
            else if (infoStr.includes("x264") || infoStr.includes("h264")) codec = " · H.264";

            const cleanFileName = file.name.split('/').pop();
            const displayTitle = cleanFileName.length > 12 ? cleanFileName : archiveTitle;

            const fileMatchesTitle = targetTitle ? isMatch(file.name, targetTitle, targetYear) : false;
            const matchScore = getMatchScore(hasImdbMatch, fileMatchesTitle, archiveMatchesTitle);

            const matchBadge = hasImdbMatch
                ? "◎ 100% match · IMDb ✓"
                : matchScore >= 90
                    ? "◎ Match exact ✓"
                    : "◎ Title match";

            const qualityScore = getQualityScore(file.name, archiveTitle);

            return {
                name: "🏛 Archive\n〈Full Movie〉",
                title: `✎ ${displayTitle}\n◈ ${sizeDisplay} · ${ext}\n◆ ${quality}${source}${codec}\n🌍 ${language} · ${matchBadge}`,
                url: `https://archive.org/download/${identifier}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
                _hasImdb: hasImdbMatch,
                _matchScore: matchScore,
                _qualityScore: qualityScore,
                _size: sizeBytes
            };
        });
    } catch (error) {
        return [];
    }
}

/* ============================================================
   HANDLER CATALOGUE
   ============================================================ */

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        let searchQuery = "mediatype:(movies)";

        if (extra && extra.search) {
            searchQuery += ` AND title:(${extra.search})`;
        } else {
            searchQuery += " AND (collection:(feature_films) OR collection:(opensource_movies))";
        }

        const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier,title,description,year&sort[]=downloads+desc&rows=30&output=json`;
        const response = await axios.get(url);
        const docs = response.data.response.docs || [];

        const metas = docs.map(doc => ({
            id: `ia:${doc.identifier}`,
            type: "movie",
            name: Array.isArray(doc.title) ? doc.title[0] : (doc.title || "Titre inconnu"),
            description: Array.isArray(doc.description) ? doc.description[0] : (doc.description || "Aucune description disponible."),
            releaseInfo: doc.year ? String(doc.year) : undefined,
            poster: `https://archive.org/services/img/${doc.identifier}`
        }));

        return { metas };
    } catch (error) {
        console.error("Erreur catalogue:", error.message);
        return { metas: [] };
    }
});

/* ============================================================
   HANDLER STREAM
   ============================================================ */

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    if (id.startsWith("ia:")) {
        const identifier = id.replace("ia:", "");
        const streams = await getStreamsFromIA(identifier);
        return { streams };
    }

    if (id.startsWith("tt")) {
        try {
            const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
            const movieMeta = cinemetaRes.data && cinemetaRes.data.meta;
            if (!movieMeta || !movieMeta.name) return { streams: [] };

            const title = movieMeta.name;
            const year = movieMeta.year ? String(movieMeta.year).substring(0, 4) : null;

            const searchQueries = buildSearchQueries(id, title, year);
            console.log(`[IA] Requêtes pour "${title}" (${year}):`, searchQueries);

            const searchPromises = searchQueries.map(q => {
                const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier,title,year&sort[]=downloads+desc&rows=20&output=json`;
                return axios.get(url, { timeout: 6000 })
                    .then(res => res.data.response.docs || [])
                    .catch((e) => {
                        console.log(`[IA] Requête échouée: ${q}`, e.message);
                        return [];
                    });
            });

            const results = await Promise.all(searchPromises);
            const docsMap = new Map();
            results.flat().forEach(d => docsMap.set(d.identifier, d));
            const docs = Array.from(docsMap.values());

            console.log(`[IA] ${searchQueries.length} requêtes → ${docs.length} items uniques`);

            const validDocs = docs.filter(doc => {
                const docTitle = Array.isArray(doc.title) ? doc.title[0] : (doc.title || "");
                return isMatch(docTitle + " " + doc.identifier, title, year);
            });

            console.log(`[IA] ${validDocs.length} items valides après isMatch`);

            const limitedDocs = validDocs.slice(0, 10);

            const streamPromises = limitedDocs.map(doc => getStreamsFromIA(doc.identifier, title, year, id));
            const results2 = await Promise.all(streamPromises);
            let allStreams = results2.flat().filter(s => s._matchScore > 0);

            allStreams.sort((a, b) => {
                if (a._matchScore !== b._matchScore) return b._matchScore - a._matchScore;
                if (a._qualityScore !== b._qualityScore) return b._qualityScore - a._qualityScore;
                return b._size - a._size;
            });

            const uniqueStreams = [];
            const seenUrls = new Set();
            for (const s of allStreams) {
                if (!seenUrls.has(s.url)) {
                    seenUrls.add(s.url);
                    delete s._hasImdb;
                    delete s._matchScore;
                    delete s._qualityScore;
                    delete s._size;
                    uniqueStreams.push(s);
                }
            }

            console.log(`[IA] ${uniqueStreams.length} flux finaux`);
            return { streams: uniqueStreams };
        } catch (error) {
            console.error("Erreur recherche IMDb -> IA:", error.message);
            return { streams: [] };
        }
    }

    return { streams: [] };
});

/* ============================================================
   CONFIGURATION EXPRESS
   ============================================================ */

const app = express();
app.use(express.static(path.join(__dirname, "../public")));

const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

module.exports = app;
