const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "2.2.0", // Passage à la version 2.2.0
    name: "Internet Archive Movies",
    description: "Recherche et diffuse des films depuis Internet Archive.",
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

// Normalisation du texte (enlève ponctuation, accents et met en minuscules)
function normalizeText(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Extrait les mots-clés significatifs d'un titre
function getSignificantWords(title) {
    const stopWords = ["the", "a", "an", "of", "and", "to", "in", "saga", "part", "le", "la", "les", "de", "du", "des"];
    return normalizeText(title)
        .split(" ")
        .filter(w => w.length > 1 && !stopWords.includes(w));
}

// Vérifie la correspondance entre un texte candidat et le film recherché
function strictMatch(text, targetTitle, targetYear) {
    const normText = normalizeText(text);
    const titleWords = getSignificantWords(targetTitle);

    if (titleWords.length === 0) return false;

    // Tous les mots-clés significatifs doivent être présents dans le nom du fichier ou de l'archive
    const allWordsPresent = titleWords.every(word => normText.includes(word));
    if (!allWordsPresent) return false;

    // Vérification de l'année si présente dans le candidat (tolérance de 1 an)
    const yearMatch = normText.match(/\b(19\d{2}|20\d{2})\b/);
    if (targetYear && yearMatch) {
        const foundYear = parseInt(yearMatch[1], 10);
        const expectedYear = parseInt(targetYear, 10);
        if (Math.abs(foundYear - expectedYear) > 1) {
            return false;
        }
    }

    return true;
}

// Détection de la langue
function detectLanguage(text) {
    const lower = text.toLowerCase();
    if (/\b(french|vf|vostfr|truefrench)\b/.test(lower)) return "Français";
    if (/\b(hindi|dubbed)\b/.test(lower)) return "Hindi / Dubbed";
    if (/\b(spanish|espanol|latino)\b/.test(lower)) return "Español";
    if (/\b(german|deutsch)\b/.test(lower)) return "Deutsch";
    if (/\b(italian|italiano)\b/.test(lower)) return "Italiano";
    return "English / Multilingual";
}

// Score de qualité pour trier (WEB-DL / BluRay / 1080p en premier)
function getQualityScore(filename, archiveTitle) {
    const text = (filename + " " + archiveTitle).toLowerCase();
    let score = 0;

    if (text.includes("web-dl") || text.includes("webdl") || text.includes("webrip")) score += 50;
    else if (text.includes("bluray") || text.includes("blu-ray") || text.includes("brrip") || text.includes("bdrip")) score += 45;
    else if (text.includes("dvdrip") || text.includes("dvd")) score += 30;

    if (text.includes("2160p") || text.includes("4k")) score += 40;
    else if (text.includes("1080p")) score += 30;
    else if (text.includes("720p")) score += 20;
    else if (text.includes("480p")) score += 10;

    return score;
}

// Récupère et filtre les flux vidéo d'une archive IA
async function getStreamsFromIA(identifier, targetTitle = null, targetYear = null, imdbId = null) {
    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl, { timeout: 6000 });
        const meta = response.data.metadata || {};
        const files = response.data.files || [];

        const archiveTitle = Array.isArray(meta.title) ? meta.title[0] : (meta.title || identifier);
        const archiveDesc = JSON.stringify(meta).toLowerCase();
        
        const hasImdbMatch = imdbId ? archiveDesc.includes(imdbId.toLowerCase()) : false;
        const archiveMatches = targetTitle ? strictMatch(archiveTitle + " " + identifier, targetTitle, targetYear) : true;

        // Si ni l'ID IMDb ni le titre/identifiant de l'archive ne correspondent, on rejette l'archive
        if (targetTitle && !hasImdbMatch && !archiveMatches) {
            return [];
        }

        const videoFiles = files.filter(f => {
            if (!f.name) return false;
            const lowerName = f.name.toLowerCase();

            // Ignorer les dérivés automatiques en double (.ia.mp4)
            if (lowerName.endsWith(".ia.mp4")) return false;

            const isVideoExt = lowerName.endsWith(".mp4") || lowerName.endsWith(".mkv") || lowerName.endsWith(".avi") || lowerName.endsWith(".ogv");
            if (!isVideoExt) return false;

            const isJunk = /(trailer|sample|teaser|clip|advertisement|commentary|review|bloopers|making of)/i.test(lowerName);
            if (isJunk) return false;

            const fileSize = parseInt(f.size || "0", 10);
            if (fileSize < 100 * 1024 * 1024) return false; // 100 Mo minimum

            // Si l'archive contient plusieurs films différents, le fichier lui-même doit correspondre
            if (targetTitle && !hasImdbMatch) {
                const fileMatches = strictMatch(f.name, targetTitle, targetYear);
                if (!fileMatches) {
                    return false;
                }
            }

            return true;
        });

        return videoFiles.map(file => {
            const sizeBytes = parseInt(file.size || "0", 10);
            const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(1);
            const sizeDisplay = sizeGB >= 1 ? `${sizeGB} GB` : `${Math.round(sizeBytes / (1024 * 1024))} MB`;
            const ext = file.name.split('.').pop().toUpperCase();

            const infoStr = (file.name + " " + archiveTitle).toLowerCase();
            
            let quality = "HD";
            if (infoStr.includes("2160p") || infoStr.includes("4k")) quality = "4K";
            else if (infoStr.includes("1080p")) quality = "1080p";
            else if (infoStr.includes("720p")) quality = "720p";
            else if (infoStr.includes("480p")) quality = "480p";

            let source = "";
            if (infoStr.includes("web-dl") || infoStr.includes("webdl")) source = " · WEB-DL";
            else if (infoStr.includes("bluray") || infoStr.includes("blu-ray") || infoStr.includes("brrip")) source = " · BluRay";
            else if (infoStr.includes("yify") || infoStr.includes("yts")) source = " · YTS";

            const language = detectLanguage(infoStr);
            const cleanFileName = file.name.split('/').pop();
            const displayTitle = cleanFileName.length > 12 ? cleanFileName : archiveTitle;
            const matchBadge = hasImdbMatch ? "◎ 100% match · IMDb ✓" : "◎ Strict match";
            const qualityScore = getQualityScore(file.name, archiveTitle);

            return {
                name: "🏛 Archive\n〈Full Movie〉",
                title: `✎ ${displayTitle}\n◈ ${sizeDisplay} · ${ext}\n◆ ${quality}${source}\n🌍 ${language} · ${matchBadge}`,
                url: `https://archive.org/download/${identifier}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
                _hasImdb: hasImdbMatch,
                _qualityScore: qualityScore,
                _size: sizeBytes
            };
        });
    } catch (error) {
        return [];
    }
}

// Catalogue
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        let searchQuery = "mediatype:(movies)";
        if (extra && extra.search) {
            const words = getSignificantWords(extra.search);
            searchQuery += words.length > 0 ? ` AND title:(${words.join(" AND ")})` : ` AND title:(${extra.search})`;
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
        return { metas: [] };
    }
});

// Streams
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
            const words = getSignificantWords(title);

            if (words.length === 0) return { streams: [] };

            // Requête Solr sans caractères spéciaux bloquants (ex: title:(twilight AND eclipse))
            const wordQuery = words.join(" AND ");
            const searchQuery = `mediatype:(movies) AND (${id} OR title:(${wordQuery}) OR identifier:(${wordQuery}))`;
            const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier,title,year&sort[]=downloads+desc&rows=15&output=json`;
            
            const searchRes = await axios.get(searchUrl);
            const docs = searchRes.data.response.docs || [];

            const streamPromises = docs.map(doc => getStreamsFromIA(doc.identifier, title, year, id));
            const results = await Promise.all(streamPromises);
            let allStreams = results.flat();

            // Tri par pertinence IMDb, score de qualité (WEB-DL/1080p) et taille
            allStreams.sort((a, b) => {
                if (a._hasImdb !== b._hasImdb) return b._hasImdb ? 1 : -1;
                if (a._qualityScore !== b._qualityScore) return b._qualityScore - a._qualityScore;
                return b._size - a._size;
            });

            const uniqueStreams = [];
            const seenUrls = new Set();
            for (const s of allStreams) {
                if (!seenUrls.has(s.url)) {
                    seenUrls.add(s.url);
                    delete s._hasImdb;
                    delete s._qualityScore;
                    delete s._size;
                    uniqueStreams.push(s);
                }
            }

            return { streams: uniqueStreams };
        } catch (error) {
            return { streams: [] };
        }
    }

    return { streams: [] };
});

const app = express();
app.use(express.static(path.join(__dirname, "../public")));

const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

module.exports = app;
