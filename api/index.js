const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.9.0", // Version mise à jour avec matching strict
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

// Nettoie une chaîne pour faciliter la comparaison
function normalizeText(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Échappe les caractères spéciaux pour RegExp
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Vérifie la correspondance STRICTE du film (Titre + Année)
// - Le titre doit apparaître en tant que mots entiers (pas en sous-chaîne)
// - Rejet des séquelles/remakes si la cible n'en est pas une
// - Tolérance d'année ±1
function isMatch(candidateText, targetTitle, targetYear) {
    const normCandidate = normalizeText(candidateText);
    const normTitle = normalizeText(targetTitle);
    if (!normTitle || !normCandidate) return false;

    // 1. Vérification stricte par mots entiers OU séquence contiguë
    const titlePattern = new RegExp(
        `(^|\\s)${escapeRegExp(normTitle)}(\\s|$)`
    );

    let titleFound = titlePattern.test(normCandidate);

    if (!titleFound) {
        // Tolérance : séquence contiguë des mots du titre (ordre respecté)
        const titleWords = normTitle.split(" ").filter(w => w.length > 1);
        if (titleWords.length === 0) return false;
        const joined = " " + normCandidate + " ";
        const seq = " " + titleWords.join(" ") + " ";
        if (!joined.includes(seq)) return false;
    }

    // 2. Anti-séquelles/remakes : si la cible n'est PAS une suite,
    //    rejeter les variantes explicites (Part 2, Reloaded, Returns, etc.)
    const isSequelTarget = /\b(part\s*\d+|chapter\s*\d+|\bii\b|\biii\b|\biv\b|\d{2,})\b/.test(normTitle);
    if (!isSequelTarget) {
        const sequelMarkers = /\b(part\s*[2-9]|part\s*(ii|iii|iv)|chapter\s*[2-9]|\b(ii|iii|iv|v)\b|reloaded|revenge|returns|rises|forever|reborn|resurrection|awakening|legacy|origins|begins|the\s+movie\s+[2-9])\b/;
        const idx = normCandidate.indexOf(normTitle);
        if (idx >= 0) {
            const after = normCandidate.substring(idx + normTitle.length).trim();
            if (sequelMarkers.test(after)) return false;
        }
    }

    // 3. Vérification de l'année (tolérance ±1 an)
    const yearMatch = normCandidate.match(/\b(19\d{2}|20\d{2})\b/);
    if (targetYear && yearMatch) {
        const foundYear = parseInt(yearMatch[1], 10);
        const expectedYear = parseInt(targetYear, 10);
        if (Math.abs(foundYear - expectedYear) > 1) {
            return false;
        }
    }

    return true;
}

// Détecte la langue dans le texte (titre, nom de fichier ou métadonnées)
function detectLanguage(text) {
    const lower = text.toLowerCase();
    if (lower.includes("french") || lower.includes("vf") || lower.includes("vostfr") || lower.includes("french.")) return "Français";
    if (lower.includes("english") || lower.includes("eng") || lower.includes("en.")) return "English";
    if (lower.includes("spanish") || lower.includes("esp")) return "Español";
    if (lower.includes("german") || lower.includes("deutsch")) return "Deutsch";
    if (lower.includes("italian") || lower.includes("italiano")) return "Italiano";
    return "English / Multilingual";
}

// Attribue un score de qualité pour trier les flux (Web-DL / 1080p en premier)
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

// Calcule un score de confiance pour un flux (0 = rejeté)
function getMatchScore(hasImdbMatch, fileMatchesTitle, archiveMatchesTitle) {
    if (hasImdbMatch) return 100;
    if (fileMatchesTitle && archiveMatchesTitle) return 90;
    if (archiveMatchesTitle) return 80;
    if (fileMatchesTitle) return 60;
    return 0;
}

// Récupère et filtre intelligemment les flux vidéo
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

            // Rejet des documentaires/interviews sauf si la cible en est un
            const isDoc = /\b(documentary|interview|conference|lecture|panel|q\s*&\s*a|podcast|audiobook)\b/i.test(lowerName);
            if (isDoc && targetTitle && !/\bdocumentary\b/i.test(targetTitle)) return false;

            const fileSize = parseInt(f.size || "0", 10);
            if (fileSize < 150 * 1024 * 1024) return false;

            // --- Logique de matching strict ---
            if (hasImdbMatch) return true; // Confiance maximale via IMDb

            if (targetTitle) {
                const fileMatches = isMatch(f.name, targetTitle, targetYear);

                // Il faut au moins un match fiable
                if (!fileMatches && !archiveMatchesTitle) return false;

                // Si un seul matche, exiger que l'autre ne soit pas contradictoire (année)
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

// Gestion du catalogue
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

// Gestion des flux vidéo (Stream)
builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") {
        return { streams: [] };
    }

    if (id.startsWith("ia:")) {
        const identifier = id.replace("ia:", "");
        const streams = await getStreamsFromIA(identifier);
        return { streams };
    }

    if (id.startsWith("tt")) {
        try {
            const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
            const movieMeta = cinemetaRes.data && cinemetaRes.data.meta;

            if (!movieMeta || !movieMeta.name) {
                return { streams: [] };
            }

            const title = movieMeta.name;
            const year = movieMeta.year ? String(movieMeta.year).substring(0, 4) : null;
            const cleanTitle = title.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

            // --- Double passe : ID IMDb + titre exact avec année ---
            const idQuery = `mediatype:(movies) AND (${id} OR identifier:(${id}))`;
            const titleQuery = year
                ? `mediatype:(movies) AND title:("${cleanTitle}") AND year:${year}`
                : `mediatype:(movies) AND title:("${cleanTitle}")`;

            const searchUrls = [
                `https://archive.org/advancedsearch.php?q=${encodeURIComponent(idQuery)}&fl[]=identifier,title,year&sort[]=downloads+desc&rows=10&output=json`,
                `https://archive.org/advancedsearch.php?q=${encodeURIComponent(titleQuery)}&fl[]=identifier,title,year&sort[]=downloads+desc&rows=15&output=json`
            ];

            const docsMap = new Map();
            for (const url of searchUrls) {
                try {
                    const res = await axios.get(url, { timeout: 6000 });
                    (res.data.response.docs || []).forEach(d => docsMap.set(d.identifier, d));
                } catch (_) { /* ignore */ }
            }
            const docs = Array.from(docsMap.values());

            // Filtre préalable : ne garder que les docs dont le titre matche strictement
            // (ou dont l'ID IMDb est présent dans l'identifiant/titre)
            const validDocs = docs.filter(doc => {
                const docTitle = Array.isArray(doc.title) ? doc.title[0] : (doc.title || "");
                if (doc.identifier.toLowerCase().includes(id.toLowerCase())) return true;
                return isMatch(docTitle + " " + doc.identifier, title, year);
            });

            const streamPromises = validDocs.map(doc => getStreamsFromIA(doc.identifier, title, year, id));
            const results = await Promise.all(streamPromises);
            let allStreams = results.flat();

            // Rejeter les flux sans match (score 0)
            allStreams = allStreams.filter(s => s._matchScore > 0);

            // Tri : 
            // 1. Score de match (IMDb > exact > titre)
            // 2. Score de qualité (WEB-DL / 1080p)
            // 3. Taille de fichier
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

            return { streams: uniqueStreams };
        } catch (error) {
            console.error("Erreur recherche IMDb -> IA:", error.message);
            return { streams: [] };
        }
    }

    return { streams: [] };
});

// Configuration Express
const app = express();
app.use(express.static(path.join(__dirname, "../public")));

const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

module.exports = app;
