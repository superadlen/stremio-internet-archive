  if (pathname === "/configure") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${addonInterface.manifest.name} — Configuration</title>
<style>
  :root { --bg:#0f1117; --card:#171a23; --line:#2a2f3d; --txt:#e6e9f0; --dim:#8b93a7; --acc:#5b8cff; --ok:#3ddc84; --danger:#ff6b6b; }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body {
    font-family:system-ui,-apple-system,sans-serif;
    background:radial-gradient(ellipse at top, #1a1f2e 0%, #0b0d12 70%);
    color:var(--txt);
    display:grid; place-items:center;
    padding:1rem;
  }

  /* === Fenêtre centrale === */
  .modal {
    width:min(920px, 100%);
    max-height:calc(100vh - 2rem);
    background:var(--card);
    border:1px solid var(--line);
    border-radius:18px;
    box-shadow:0 20px 60px rgba(0,0,0,.6);
    display:flex; flex-direction:column;
    overflow:hidden;
  }
  .modal header {
    display:flex; align-items:center; gap:.6rem;
    padding:1rem 1.2rem;
    border-bottom:1px solid var(--line);
    background:#12151c;
  }
  .modal header h1 { font-size:1.05rem; margin:0; flex:1; }
  .modal header .ver { color:var(--dim); font-size:.75rem; }
  .modal header .badge { font-size:.65rem; padding:.15rem .5rem; border-radius:6px; background:#1c2a4a; color:var(--acc); }

  /* === Onglets === */
  .tabs {
    display:flex;
    border-bottom:1px solid var(--line);
    background:#12151c;
    padding:0 .5rem;
    gap:.2rem;
  }
  .tabs button {
    background:transparent;
    border:none;
    color:var(--dim);
    padding:.75rem 1rem;
    font-size:.85rem;
    font-weight:600;
    cursor:pointer;
    border-bottom:2px solid transparent;
    display:flex; align-items:center; gap:.4rem;
    transition:color .15s, border-color .15s;
  }
  .tabs button:hover { color:var(--txt); }
  .tabs button.active { color:var(--acc); border-bottom-color:var(--acc); }

  /* === Contenu de l'onglet === */
  .content {
    flex:1;
    overflow-y:auto;
    padding:1rem 1.2rem;
    min-height:280px;
  }
  .content::-webkit-scrollbar { width:8px; }
  .content::-webkit-scrollbar-thumb { background:var(--line); border-radius:8px; }

  .section { display:none; }
  .section.active { display:block; }

  .section h2 { font-size:.9rem; color:var(--acc); margin:0 0 .6rem; display:flex; align-items:center; justify-content:space-between; gap:.5rem; }
  .section h2 .mini { display:flex; gap:.3rem; }
  .section h2 button {
    font-size:.7rem; padding:.25rem .55rem;
    border-radius:6px; border:1px solid var(--line);
    background:transparent; color:var(--dim); cursor:pointer;
  }
  .section h2 button:hover { color:var(--txt); border-color:var(--acc); }

  .hint { font-size:.75rem; color:var(--dim); margin:.3rem 0 .8rem; }

  /* === Langues (drag & drop) === */
  .lang-list { display:flex; flex-direction:column; gap:.35rem; }
  .lang-item {
    display:flex; align-items:center; gap:.6rem;
    padding:.5rem .7rem;
    background:#1e2230;
    border:1px solid var(--line);
    border-radius:10px;
    cursor:grab;
    user-select:none;
    transition:background .1s, border-color .1s;
  }
  .lang-item:hover { border-color:#3a4254; }
  .lang-item.on { background:#1c2a4a; border-color:#2f4780; }
  .lang-item.dragging { opacity:.4; }
  .lang-item.drag-over { border-color:var(--acc); background:#243358; }
  .lang-item .flag { font-size:1.15rem; }
  .lang-item .nm { flex:1; font-size:.88rem; }
  .lang-item .pos { color:var(--dim); font-size:.7rem; font-variant-numeric:tabular-nums; min-width:22px; text-align:center; }
  .lang-item .ck {
    width:18px; height:18px; border-radius:50%;
    border:2px solid var(--line); flex:none;
    display:grid; place-items:center;
  }
  .lang-item.on .ck { border-color:var(--ok); background:var(--ok); }
  .lang-item.on .ck::after { content:"✓"; color:#04120a; font-size:.75rem; font-weight:900; }
  .lang-item .grip { color:var(--dim); font-size:.9rem; cursor:grab; }

  .group-title {
    font-size:.7rem; color:var(--dim);
    text-transform:uppercase; letter-spacing:.08em;
    margin:.8rem 0 .4rem; font-weight:700;
  }
  .group-title:first-child { margin-top:0; }

  .btn-more {
    width:100%; padding:.55rem;
    background:transparent; border:1px dashed var(--line);
    color:var(--dim); border-radius:10px; cursor:pointer;
    font-size:.8rem; margin-top:.5rem;
  }
  .btn-more:hover { color:var(--acc); border-color:var(--acc); }

  /* === Qualité === */
  .qual-item {
    display:flex; align-items:center; gap:.6rem;
    padding:.6rem .75rem; margin-bottom:.4rem;
    background:#1e2230; border:1px solid var(--line);
    border-radius:10px; cursor:grab; user-select:none;
  }
  .qual-item.dragging { opacity:.4; }
  .qual-item .num {
    background:var(--acc); color:#fff; border-radius:50%;
    width:22px; height:22px; display:grid; place-items:center;
    font-size:.72rem; font-weight:700; flex:none;
  }
  .qual-item .lbl { flex:1; font-size:.86rem; }
  .qual-item .grip { color:var(--dim); }

  /* === Options === */
  .opt-row {
    display:flex; align-items:center; justify-content:space-between;
    gap:.6rem; padding:.7rem 0;
    border-bottom:1px solid var(--line);
  }
  .opt-row:last-of-type { border-bottom:none; }
  .opt-row label { font-size:.85rem; flex:1; }
  .opt-row small { display:block; color:var(--dim); font-size:.72rem; margin-top:.15rem; }
  .toggle { display:flex; gap:.25rem; }
  .toggle button {
    border:1px solid var(--line); background:transparent;
    color:var(--dim); border-radius:7px;
    padding:.32rem .65rem; font-size:.78rem; cursor:pointer;
  }
  .toggle button.on { background:var(--acc); border-color:var(--acc); color:#fff; }
  input[type=range] { width:100%; accent-color:var(--acc); margin-top:.4rem; }
  .slider-val { color:var(--acc); font-weight:700; font-size:.8rem; }
  .slider-hint { display:flex; justify-content:space-between; font-size:.7rem; color:var(--dim); margin-top:.15rem; }

  /* === Footer === */
  .modal footer {
    padding:.8rem 1.2rem;
    border-top:1px solid var(--line);
    background:#12151c;
    display:flex; gap:.6rem; align-items:center; flex-wrap:wrap;
  }
  .urlbox {
    flex:1; min-width:180px;
    font-size:.7rem; color:var(--dim);
    background:#0b0d12; padding:.5rem .7rem;
    border-radius:8px; word-break:break-all;
    border:1px solid var(--line);
  }
  .btn {
    border:none; border-radius:10px;
    padding:.6rem 1rem; font-size:.85rem; font-weight:700;
    cursor:pointer; text-decoration:none;
    display:inline-flex; align-items:center; gap:.35rem;
    white-space:nowrap;
  }
  .btn.install { background:var(--ok); color:#04120a; }
  .btn.copy    { background:var(--acc); color:#fff; }
  .btn:hover { filter:brightness(1.1); }

  /* === Toast === */
  #toast {
    position:fixed; left:50%; bottom:2rem;
    transform:translateX(-50%) translateY(20px);
    background:var(--ok); color:#04120a;
    padding:.65rem 1.3rem; border-radius:10px;
    font-weight:700; opacity:0;
    transition:all .25s; pointer-events:none; z-index:99;
    box-shadow:0 8px 24px rgba(61,220,132,.35);
  }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
</style></head><body>

<div class="modal">
  <header>
    <h1>🏛 ${addonInterface.manifest.name}</h1>
    <span class="ver">v${addonInterface.manifest.version}</span>
    <span class="badge" id="summary"></span>
  </header>

  <nav class="tabs">
    <button data-tab="langs" class="active">🗣️ Langues</button>
    <button data-tab="quals">🎞️ Qualité</button>
    <button data-tab="opts">⚙️ Options</button>
  </nav>

  <div class="content">

    <!-- LANGUES -->
    <section class="section active" id="tab-langs">
      <h2>🗣️ Langues
        <span class="mini">
          <button id="langAll">Tout</button>
          <button id="langNone">Rien</button>
        </span>
      </h2>
      <p class="hint">Glissez pour classer (haut = prioritaire). Touchez pour afficher/masquer.</p>
      <div id="langsTop" class="lang-list"></div>
      <button class="btn-more" id="toggleOthers">▼ Afficher les autres langues</button>
      <div id="langsOthers" class="lang-list" style="display:none;margin-top:.5rem;"></div>
    </section>

    <!-- QUALITÉ -->
    <section class="section" id="tab-quals">
      <h2>🎞️ Qualité d'image</h2>
      <p class="hint">Glissez pour changer l'ordre de préférence (haut = prioritaire).</p>
      <div id="quals"></div>
    </section>

    <!-- OPTIONS -->
    <section class="section" id="tab-opts">
      <h2>⚙️ Options</h2>
      <div class="opt-row">
        <label>📺 HDR / Dolby Vision<small>HDR10, HDR10+, DV, 10bit</small></label>
        <div class="toggle" data-k="hdr"><button data-v="1">Oui</button><button data-v="0">Non</button></div>
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
// Langues : ordre par défaut = les plus utilisées en tête
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

function load(k, def) { try { const v = JSON.parse(localStorage.getItem("ia_cfg_"+k)); return v ?? def; } catch(e){ return def; } }
function save(k, v) { localStorage.setItem("ia_cfg_"+k, JSON.stringify(v)); }

// langOrder = liste ordonnée de codes ; langOn = map code → bool
let langOrder = load("langOrder", ALL_LANGS.map(l => l.code));
let langOn    = load("langOn",    Object.fromEntries(ALL_LANGS.map(l => [l.code, true])));
let qualArr   = load("quals",     QUALS.map(q => q.k));
let hdr       = load("hdr",       1);
let maxSize   = load("size",      0);
let minPct    = load("minPct",    50);
let showOthers = false;

const langByCode = Object.fromEntries(ALL_LANGS.map(l => [l.code, l]));

// === ONGLETS ===
document.querySelectorAll('.tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  };
});

// === RENDER LANGUES avec drag & drop ===
function renderLangs() {
  const top    = document.getElementById("langsTop");
  const others = document.getElementById("langsOthers");
  top.innerHTML = "";
  others.innerHTML = "";

  const buildItem = (code, indexInFullList) => {
    const l = langByCode[code];
    if (!l) return null;
    const el = document.createElement("div");
    el.className = "lang-item" + (langOn[code] ? " on" : "");
    el.draggable = true;
    el.dataset.code = code;
    el.dataset.idx = indexInFullList;
    el.innerHTML =
      '<span class="pos">' + (indexInFullList + 1) + '</span>' +
      '<span class="flag">' + l.flag + '</span>' +
      '<span class="nm">' + l.name + '</span>' +
      '<span class="grip">☰</span>' +
      '<span class="ck"></span>';

    // toggle on/off au clic (sauf sur le grip)
    el.onclick = (e) => {
      if (e.target.classList.contains("grip")) return;
      langOn[code] = !langOn[code];
      save("langOn", langOn);
      renderLangs();
      update();
    };

    // drag & drop pour réordonner
    el.ondragstart = e => {
      e.dataTransfer.setData("text/plain", code);
      el.classList.add("dragging");
    };
    el.ondragend = () => el.classList.remove("dragging");
    el.ondragover = e => { e.preventDefault(); el.classList.add("drag-over"); };
    el.ondragleave = () => el.classList.remove("drag-over");
    el.ondrop = e => {
      e.preventDefault();
      el.classList.remove("drag-over");
      const fromCode = e.dataTransfer.getData("text/plain");
      const toCode = code;
      if (!fromCode || fromCode === toCode) return;
      const from = langOrder.indexOf(fromCode);
      const to = langOrder.indexOf(toCode);
      if (from < 0 || to < 0) return;
      const [m] = langOrder.splice(from, 1);
      langOrder.splice(to, 0, m);
      save("langOrder", langOrder);
      renderLangs();
      update();
    };
    return el;
  };

  // top 6
  langOrder.slice(0, TOP_COUNT).forEach((code, i) => {
    const el = buildItem(code, i);
    if (el) top.appendChild(el);
  });

  // "Autres langues" (le reste)
  const rest = langOrder.slice(TOP_COUNT);
  document.getElementById("toggleOthers").textContent = showOthers
    ? "▲ Masquer les autres langues (" + rest.length + ")"
    : "▼ Afficher les autres langues (" + rest.length + ")";
  others.style.display = showOthers ? "" : "none";

  rest.forEach((code, i) => {
    const el = buildItem(code, TOP_COUNT + i);
    if (el) others.appendChild(el);
  });
}

document.getElementById("toggleOthers").onclick = () => { showOthers = !showOthers; renderLangs(); };
document.getElementById("langAll").onclick  = () => { Object.keys(langOn).forEach(k => langOn[k] = true);  save("langOn", langOn); renderLangs(); update(); };
document.getElementById("langNone").onclick = () => { Object.keys(langOn).forEach(k => langOn[k] = false); save("langOn", langOn); renderLangs(); update(); };

// === QUALITÉ (drag & drop) ===
const qualsBox = document.getElementById("quals");
function renderQuals() {
  qualsBox.innerHTML = "";
  qualArr.forEach((k, i) => {
    const q = QUALS.find(x => x.k === k);
    if (!q) return;
    const el = document.createElement("div");
    el.className = "qual-item";
    el.draggable = true;
    el.dataset.i = i;
    el.dataset.k = k;
    el.innerHTML =
      '<span class="num">' + (i + 1) + '</span>' +
      '<span class="lbl">' + q.label + '</span>' +
      '<span class="grip">☰</span>';
    el.ondragstart = e => { e.dataTransfer.setData("text/plain", i); el.classList.add("dragging"); };
    el.ondragend = () => el.classList.remove("dragging");
    el.ondragover = e => e.preventDefault();
    el.ondrop = e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData("text/plain");
      const to = i;
      if (from === to) return;
      const [m] = qualArr.splice(from, 1);
      qualArr.splice(to, 0, m);
      save("quals", qualArr);
      renderQuals();
      update();
    };
    qualsBox.appendChild(el);
  });
}

// === HDR ===
function bindToggle(key, val, onSet) {
  document.querySelectorAll('[data-k="' + key + '"] button').forEach(b => {
    if (String(val) === b.dataset.v) b.classList.add("on");
    b.onclick = () => {
      const v = +b.dataset.v;
      onSet(v);
      document.querySelectorAll('[data-k="' + key + '"] button').forEach(x => x.classList.toggle("on", x === b));
      update();
    };
  });
}
bindToggle("hdr", hdr, v => { hdr = v; save("hdr", hdr); });

// === SLIDERS ===
const sizeEl = document.getElementById("size"), sizeVal = document.getElementById("sizeVal");
sizeEl.value = maxSize;
const sizeText = v => v == 0 ? "Illimitée" : v + " Go max";
sizeVal.textContent = sizeText(maxSize);
sizeEl.oninput = () => { maxSize = +sizeEl.value; sizeVal.textContent = sizeText(maxSize); save("size", maxSize); update(); };

const pctEl = document.getElementById("minPct"), pctVal = document.getElementById("minPctVal");
pctEl.value = minPct;
pctVal.textContent = minPct + "%";
pctEl.oninput = () => { minPct = +pctEl.value; pctVal.textContent = minPct + "%"; save("minPct", minPct); update(); };

// === URL + COPY ===
function buildCfg() {
  return {
    langs:  langOrder.filter(c => langOn[c]),
    quals:  qualArr,
    hdr,
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

  const nbL = cfg.langs.length, total = ALL_LANGS.length;
  document.getElementById("summary").textContent =
    nbL + "/" + total + " langues · " + (hdr ? "HDR" : "SDR") + " · " + (maxSize ? maxSize + "Go" : "∞") + " · " + minPct + "%";
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

// === INIT ===
renderLangs();
renderQuals();
update();
</script>
</body></html>`);
  }
