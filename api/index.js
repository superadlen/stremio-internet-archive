const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.8.0", // Passage à la version 1.8.0
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

// Vérifie la correspondance du film (Titre + Année)
function isMatch(candidateText, targetTitle, targetYear) {
    const normCandidate = normalizeText(candidateText);
    const normTitle = normalizeText(targetTitle);

    const titleWords = normTitle.split(" ").filter(w => w.length > 1);
    if (titleWords.length === 0) return false;

    const hasAllWords = titleWords.every(word => normCandidate.includes(word));
    if (!hasAllWords) return false;

    const yearMatch = normCandidate.match(/\b(19\d{2}|20\d{2})\b/);
    if (targetYear && yearMatch) {
        const foundYear = parseInt(yearMatch[1], 10);
        const expectedYear = parseInt(targetYear, 10);
        if (Math.abs(foundYear - expectedYear) > 1) {
            return false;
        }
    }

    if (!normTitle.includes("part") && !normTitle.includes("ii") && !normTitle.includes("2") && !normTitle.includes("3")) {
        if (/\b(part\s*2|part\s*3|part\s*ii|part\s*iii|\bii\b|\biii\b)\b/.test(normCandidate)) {
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
    return "English / Multilingual"; // Par défaut sur IA
}

// Attribue un score de qualité pour trier les flux (Web-DL / 1080p en premier)
function getQualityScore(filename, archiveTitle) {
    const text = (filename + " " + archiveTitle).toLowerCase();
    let score = 0;

    // Source (Web-DL et BluRay en tête)
    if (text.includes("web-dl") || text.includes("webdl") || text.includes("web rip") || text.includes("webrip")) score += 50;
    else if (text.includes("bluray") || text.includes("blu-ray") || text.includes("bdrip")) score += 45;
    else if (text.includes("dvdrip") || text.includes("dvd")) score += 30;
    else if (text.includes("hdtv")) score += 25;

    // Résolution
    if (text.includes("2160p") || text.includes("4k")) score += 40;
    else if (text.includes("1080p")) score += 30;
    else if (text.includes("720p")) score += 20;
    else if (text.includes("480p") || text.includes("sd")) score += 10;

    return score;
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
        const archiveMatchesTitle = targetTitle ? isMatch(archiveTitle + " " + identifier, targetTitle, targetYear) : true;

        const videoFiles = files.filter(f => {
            if (!f.name) return false;
            const lowerName = f.name.toLowerCase();

            if (lowerName.endsWith(".ia.mp4")) return false;

            const isVideoExt = lowerName.endsWith(".mp4") || lowerName.endsWith(".mkv") || lowerName.endsWith(".avi") || lowerName.endsWith(".ogv");
            if (!isVideoExt) return false;

            const isJunk = /(trailer|sample|teaser|clip|advertisement|commentary|review|behind the scenes|deleted scenes|bloopers|making of)/i.test(lowerName);
            if (isJunk) return false;

            const fileSize = parseInt(f.size || "0", 10);
            if (fileSize < 150 * 1024 * 1024) return false;

            if (targetTitle) {
                const fileMatchesTitle = isMatch(f.name, targetTitle, targetYear);
                if (!fileMatchesTitle && !(archiveMatchesTitle && !hasImdbMatch ? false : archiveMatchesTitle)) {
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

            const infoStr = (file.name + " " + archiveTitle + " " + (meta.language || "")).toLowerCase();
            
            // Qualité lisible
            let quality = "HD";
            if (infoStr.includes("2160p") || infoStr.includes("4k")) quality = "4K";
            else if (infoStr.includes("1080p")) quality = "1080p";
            else if (infoStr.includes("720p")) quality = "720p";
            else if (infoStr.includes("480p")) quality = "480p";

            // Source (Web-DL, BluRay, etc.)
            let source = "";
            if (infoStr.includes("web-dl") || infoStr.includes("webdl")) source = " · WEB-DL";
            else if (infoStr.includes("bluray") || infoStr.includes("blu-ray")) source = " · BluRay";
            else if (infoStr.includes("dvdrip")) source = " · DVDRip";

            // Langue détectée
            const language = detectLanguage(infoStr);

            let codec = "";
            if (infoStr.includes("hevc") || infoStr.includes("x265")) codec = " · HEVC";
            else if (infoStr.includes("x264") || infoStr.includes("h264")) codec = " · H.264";

            const cleanFileName = file.name.split('/').pop();
            const displayTitle = cleanFileName.length > 12 ? cleanFileName : archiveTitle;
            const matchBadge = hasImdbMatch ? "◎ 100% match · IMDb ✓" : "◎ Title match";
            const qualityScore = getQualityScore(file.name, archiveTitle);

            return {
                name: "🏛 Archive\n〈Full Movie〉",
                title: `✎ ${displayTitle}\n◈ ${sizeDisplay} · ${ext}\n◆ ${quality}${source}${codec}\n🌍 ${language} · ${matchBadge}`,
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
            const cleanTitle = title.replace(/[^\w\s]/g, " ").trim();

            const searchQuery = `mediatype:(movies) AND (${id} OR title:("${cleanTitle}"))`;
            const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier,title,year&sort[]=downloads+desc&rows=12&output=json`;
            
            const searchRes = await axios.get(searchUrl);
            const docs = searchRes.data.response.docs || [];

            const streamPromises = docs.map(doc => getStreamsFromIA(doc.identifier, title, year, id));
            const results = await Promise.all(streamPromises);
            let allStreams = results.flat();

            // Tri intelligent : 
            // 1. D'abord les correspondances IMDb certifiées
            // 2. Ensuite par Score de Qualité (WEB-DL / 1080p en priorité absolue)
            // 3. Enfin par taille de fichier
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
