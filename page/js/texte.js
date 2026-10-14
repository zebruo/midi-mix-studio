// Mixeur MIDI — onglet Texte : le fichier MIDI en texte commenté (format de tools\midi-texte\midi_texte.py),
// à voir et corriger en tableau (filtres, cellules modifiables, actions groupées) ou en texte brut,
// vérifié en continu par le serveur, puis enregistré en nouveau .mid (jamais d'écrasement).
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

const TX = (() => {
  const PAR_PAGE = 250, HAUT_LIGNE = 18.75;              // lignes par page du tableau ; hauteur d'une ligne du texte brut (px)
  const NOMS = ["Do", "Do♯", "Ré", "Ré♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"];
  const BASES = {do: 0, "ré": 2, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11};
  const LIBELLES = {note: "note", instrument: "instrument", cc: "contrôleur", tempo: "tempo", chiffrage: "chiffrage",
    "tonalité": "tonalité", pitch: "pitch", pression: "pression", "pression-note": "pression note", fin: "fin de piste",
    nom: "nom", texte: "texte", marqueur: "marqueur", paroles: "paroles", brut: "brut", "meta-brut": "meta"};
  let lignes = [], infos = [], pistes = [], hist = [], futur = [], erreurs = new Map(), coches = new Set();
  let chemin = null, vue = "tableau", page = 0, mes = null, original = "";
  let minuterieVerif = null, minuterieBrut = null, demande = 0;

  // ───── notes, instruments
  function lireNote(s) {
    s = String(s).trim();
    if (/^\d{1,3}$/.test(s)) return +s <= 127 ? +s : null;
    const m = s.match(/^(do|ré|re|mi|fa|sol|la|si)([♯#♭b]*)(-?\d+)$/i);
    if (!m) return null;
    const n = BASES[m[1].toLowerCase()] + [...m[2]].reduce((t, c) => t + ("♯#".includes(c) ? 1 : -1), 0) + (+m[3] + 2) * 12;
    return n >= 0 && n <= 127 ? n : null;
  }
  const nomNote = (n, canal) => canal === 9 ? String(n) : NOMS[n % 12] + (Math.floor(n / 12) - 2);
  const gm = p => { const s = SONS.gu.find(x => x.id === `gu:0:${p}`); return s ? s.nom.replace(/^\d+ /, "") : `programme ${p}`; };

  // ───── mesures ⇄ ticks (comme midi_texte.py)
  class Mesures {
    constructor(tpb) { this.tpb = tpb; this.seg = [[0, 1, 4, 4]]; }
    long(n, d) { return Math.floor(this.tpb * 4 * n / d); }
    unTemps(d) { return Math.floor(this.tpb * 4 / d); }
    ajoute(tick, n, d) {
      const [t0, m0, n0, d0] = this.seg[this.seg.length - 1];
      if (tick <= t0) { this.seg[this.seg.length - 1] = [t0, m0, n, d]; return; }
      this.seg.push([tick, m0 + Math.ceil((tick - t0) / this.long(n0, d0)), n, d]);
    }
    tick(m, t, k) { let s = this.seg[0]; for (const x of this.seg) if (x[1] <= m) s = x; return s[0] + (m - s[1]) * this.long(s[2], s[3]) + (t - 1) * this.unTemps(s[3]) + k; }
    position(tick) {
      let s = this.seg[0]; for (const x of this.seg) if (x[0] <= tick) s = x;
      const L = this.long(s[2], s[3]), tp = this.unTemps(s[3]), q = Math.floor((tick - s[0]) / L), r = tick - s[0] - q * L;
      return [s[1] + q, Math.floor(r / tp) + 1, r % tp];
    }
    temps(tick) { let s = this.seg[0]; for (const x of this.seg) if (x[0] <= Math.max(0, tick)) s = x; return this.unTemps(s[3]); }
  }

  // ───── lecture des lignes
  function coupe(l) {                                    // [code, commentaire] ; « # » en début ou après un espace
    let dans = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') dans = !dans;
      if (c === "#" && !dans && (i === 0 || l[i - 1] === " " || l[i - 1] === "\t")) return [l.slice(0, i).trimEnd(), l.slice(i + 1).trim()];
    }
    return [l.trimEnd(), null];
  }
  function analyse() {
    infos = []; pistes = [];
    let piste = -1, canal = 0, tpb = 480;
    const chif = [];
    lignes.forEach((l, i) => {
      const [code, com] = coupe(l), s = code.trim(), o = {i, type: "autre", com};
      if (!s) o.type = "vide";
      else if (/^fichier\b/.test(s)) { o.type = "fichier"; const m = s.match(/ticks\s+(\d+)/); if (m) tpb = +m[1]; }
      else if (/^piste\b/.test(s)) {
        piste++; canal = 0; o.type = "piste";
        pistes.push({n: piste, titre: s.replace(/^piste\s+/, "piste ") + (com ? " · " + com.replace(/^\s*/, "") : "")});
      } else if (/^canal\s+\d+$/.test(s)) { canal = +s.split(/\s+/)[1] - 1; o.type = "canal"; }
      else {
        const m = s.match(/^(\d+)\.(\d+)\.(\d+)\s+(.*)$/);
        if (m) {
          Object.assign(o, {type: "evt", m: +m[1], t: +m[2], k: +m[3], piste, canal, propre: null});
          let reste = m[4];
          const c = reste.match(/\s+canal\s+(\d+)$/);
          if (c && !/^(brut|meta-brut)\b/.test(reste)) { o.propre = +c[1] - 1; o.canal = o.propre; reste = reste.slice(0, c.index); }
          o.genre = reste.split(/\s+/)[0];
          o.reste = reste.slice(o.genre.length).trim();
          if (o.genre === "note") {
            const e = reste.match(/^note\s+(\S+)\s+dur\s+(\d+)\.(\d+)\s+v(\d+)(.*)$/);
            if (e) Object.assign(o, {note: e[1], dur: `${+e[2]}.${e[3].padStart(3, "0")}`, vel: +e[4], extra: e[5].trim()});
            else o.malforme = true;
          }
          if (o.genre === "chiffrage") { const e = reste.match(/chiffrage\s+(\d+)\/(\d+)/); if (e) chif.push([o.m, o.t, o.k, +e[1], +e[2]]); }
        }
      }
      infos.push(o);
    });
    mes = new Mesures(tpb);
    chif.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (const [m, t, k, n, d] of chif) mes.ajoute(mes.tick(m, t, k), n, d);
    for (const o of infos) if (o.type === "evt") o.tick = mes.tick(o.m, o.t, o.k);
  }
  function ecrire(o) {
    const pos = `${String(o.m).padStart(4)}.${o.t}.${String(o.k).padStart(3, "0")}`;
    const desc = o.genre === "note" && !o.malforme
      ? `note ${o.note.padEnd(6)} dur ${o.dur}  v${o.vel}` + (o.extra ? "  " + o.extra : "")
      : o.genre + (o.reste ? " " + o.reste : "");
    const l = `${pos}  ${desc}${o.propre !== null && o.propre !== undefined ? `  canal ${o.propre + 1}` : ""}`;
    return o.com ? l + " ".repeat(Math.max(2, 50 - l.length)) + "# " + o.com : l;
  }
  const comAuto = c => c === null || /^MIDI \d+$/.test(c) || c === "percussion";
  function noteVers(o, n) {                               // change la hauteur d'une note (et son commentaire automatique)
    o.note = nomNote(n, o.canal);
    if (comAuto(o.com)) o.com = o.canal === 9 ? "percussion" : `MIDI ${n}`;
  }

  // ───── modifications, historique, brouillon
  function avant() { hist.push(lignes.slice()); if (hist.length > 100) hist.shift(); futur = []; }
  function apres(structure) {
    if (structure) coches.clear();
    analyse(); memorise(); dessine(); afficheErreurs(); verifierBientot();
    if (vue === "brut") remplitBrut(true);
  }
  function modifie(i, o) { avant(); lignes[i] = ecrire(o); apres(false); }
  const cle = () => "mixeur.texte:" + chemin;
  function memorise() {
    try { const t = lignes.join("\n"); if (t === original) localStorage.removeItem(cle()); else localStorage.setItem(cle(), t); } catch (e) {}
  }
  function annuler() { if (!hist.length) return; futur.push(lignes); lignes = hist.pop(); apres(true); }
  function retablir() { if (!futur.length) return; hist.push(lignes); lignes = futur.pop(); apres(true); }

  // ───── vérification par le serveur
  function verifierBientot() { clearTimeout(minuterieVerif); minuterieVerif = setTimeout(verifier, 600); }
  async function verifier() {
    if (!chemin) return;
    const n = ++demande;
    try {
      const r = await api("/api/texte/verifier", {texte: lignes.join("\n")});
      if (n !== demande) return;
      erreurs = new Map(r.erreurs.map(e => [e.ligne, e.message]));
    } catch (e) { erreurs = new Map([[0, e.message]]); }
    afficheErreurs(); dessine(true);
  }
  function afficheErreurs() {
    const zone = $("#tx-erreurs"), etat = $("#tx-etat"), modif = lignes.join("\n") !== original;
    const nb = infos.filter(o => o.type === "evt").length;
    etat.className = "tx-etat " + (erreurs.size ? "err" : "ok");
    etat.textContent = (erreurs.size ? `${erreurs.size} erreur(s) à corriger` : "✓ aucune erreur")
      + ` · ${lignes.length} lignes · ${nb} événements`
      + (modif ? " · corrigé (appliqué au document en quittant l'onglet ou avec « Enregistrer »)" : " · identique au document");
    zone.hidden = !erreurs.size;
    zone.innerHTML = [...erreurs].slice(0, 30).map(([n, msg]) =>
      `<div><button type="button" data-ligne="${n}">ligne ${n}</button> : ${msg.replace(/</g, "&lt;")}</div>`).join("")
      + (erreurs.size > 30 ? `<div>… et ${erreurs.size - 30} autres</div>` : "");
  }
  $("#tx-erreurs").addEventListener("click", e => { const b = e.target.closest("button[data-ligne]"); if (b) montre(+b.dataset.ligne); });

  // ───── tableau
  const groupe = g => g === "note" ? "note" : g === "instrument" ? "instrument" : g === "cc" ? "cc"
    : ["tempo", "chiffrage", "tonalité"].includes(g) ? "tempo" : "autre";
  function filtrees() {
    const p = $("#tx-piste").value, de = +$("#tx-de").value || 0, a = +$("#tx-a").value || Infinity, g = $("#tx-genre").value;
    const q = $("#tx-cherche").value.trim().toLowerCase(), q2 = q.replace(/#/g, "♯");
    return infos.filter(o => o.type === "evt" && (p === "" || o.piste === +p) && o.m >= de && o.m <= a && (!g || groupe(o.genre) === g)
      && (!q || lignes[o.i].toLowerCase().includes(q) || lignes[o.i].toLowerCase().includes(q2)))
      .sort((a, b) => a.tick - b.tick || a.i - b.i);       // dans l'ordre du temps (puis du texte)
  }
  // une attaque un tout petit peu avant un temps (1/8 de temps au plus, humanisation) : « ≈ 3.1 » = en réalité ce temps-là
  function approx(o) {
    const temps = mes.temps(o.tick), avance = Math.floor(mes.tpb / 8);
    if (o.genre === "fin" || o.k === 0 || temps - o.k > avance) return "";
    const [m, t] = mes.position(o.tick + temps - o.k), d = temps - o.k;
    const quoi = t === 1 ? `1er temps de la mesure ${m}` : `${t}e temps de la mesure ${m}`;
    return `<span class="approx" title="attaque ${d} tick(s) avant le temps : en réalité le ${quoi}">≈ ${m}.${t}</span>`;
  }
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  function celluleValeur(o) {
    if (o.genre === "note" && !o.malforme) return `<input type="text" class="val" data-champ="note" value="${esc(o.note)}" title="ex. Fa♯4, Si♭2, ou un numéro MIDI">`;
    if (o.genre === "instrument" && o.canal !== 9 && /^\d+$/.test(o.reste)) {
      let opts = ""; for (let p = 0; p < 128; p++) opts += `<option value="${p}"${p === +o.reste ? " selected" : ""}>${p} ${esc(gm(p))}</option>`;
      return `<select class="val" data-champ="instrument">${opts}</select>`;
    }
    return `<input type="text" class="val" data-champ="reste" value="${esc(o.reste)}">`;
  }
  function dessine(classesSeules) {
    if (vue !== "tableau" || !chemin) return;
    const liste = filtrees(), nbPages = Math.max(1, Math.ceil(liste.length / PAR_PAGE));
    page = Math.min(page, nbPages - 1);
    const vus = liste.slice(page * PAR_PAGE, (page + 1) * PAR_PAGE), tb = $("#tx-lignes");
    if (classesSeules) {                                 // après une vérification : seulement les lignes en erreur
      for (const tr of tb.rows) { const n = +tr.dataset.i + 1; tr.classList.toggle("erreur", erreurs.has(n)); tr.title = erreurs.get(n) || ""; }
      return;
    }
    tb.innerHTML = vus.map(o => {
      const note = o.genre === "note" && !o.malforme, n = o.i + 1;
      return `<tr data-i="${o.i}" class="${erreurs.has(n) ? "erreur" : ""}${coches.has(o.i) ? " cochee" : ""}" title="${esc(erreurs.get(n) || "")}">
        <td><input type="checkbox" class="coche"${coches.has(o.i) ? " checked" : ""} aria-label="Cocher la ligne ${n}"></td>
        <td class="num">${n}</td>
        <td><input type="text" class="pos" data-champ="pos" value="${o.m}.${o.t}.${String(o.k).padStart(3, "0")}" title="mesure.temps.tick">${approx(o)}</td>
        <td class="pis" title="${esc((pistes[o.piste] || {}).titre)}">${esc((pistes[o.piste] || {}).titre || "")}</td>
        <td class="num">${o.canal + 1}</td>
        <td class="genre ${note ? "note" : ""}">${LIBELLES[o.genre] || esc(o.genre)}</td>
        <td>${celluleValeur(o)}</td>
        <td>${note ? `<input type="text" class="dur" data-champ="dur" value="${o.dur}" title="temps.ticks (1.000 = un temps)">` : ""}</td>
        <td>${note ? `<input type="text" class="vel" data-champ="vel" value="${o.vel}" title="1 à 127">` : ""}</td>
        <td><input type="text" class="com" data-champ="com" value="${esc(o.com)}"></td>
        <td><div class="acts"><button type="button" data-act="dup" title="Dupliquer cette ligne">⧉</button>
          <button type="button" data-act="ins" title="Ajouter une note juste après (même piste)">+</button>
          <button type="button" data-act="sup" title="Supprimer cette ligne">✕</button></div></td></tr>`;
    }).join("");
    $("#tx-pages").innerHTML = liste.length
      ? `<button type="button" data-p="-1"${page ? "" : " disabled"}>◀</button> page ${page + 1} / ${nbPages} · ${liste.length} ligne(s)
         <button type="button" data-p="1"${page < nbPages - 1 ? "" : " disabled"}>▶</button>`
      : "aucune ligne ne correspond aux filtres";
    $("#tx-tout").checked = vus.length > 0 && vus.every(o => coches.has(o.i));
    majCoches();
  }
  function majCoches() {
    $("#tx-choix").textContent = coches.size ? `${coches.size} ligne(s) cochée(s) :` : "";
    document.querySelectorAll(".tx-actions button[data-a]").forEach(b => b.disabled = !coches.size);
    $("#tx-decocher").disabled = !coches.size;
  }
  $("#tx-cocher-filtre").addEventListener("click", () => { for (const o of filtrees()) coches.add(o.i); dessine(); });
  $("#tx-decocher").addEventListener("click", () => { coches.clear(); dessine(); });
  $("#tx-pages").addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b) { page += +b.dataset.p; dessine(); } });
  for (const id of ["tx-piste", "tx-genre"]) $("#" + id).addEventListener("change", () => { page = 0; dessine(); });
  for (const id of ["tx-de", "tx-a", "tx-cherche"]) $("#" + id).addEventListener("input", () => { page = 0; dessine(); });
  $("#tx-effacer-filtres").addEventListener("click", () => {
    for (const id of ["tx-piste", "tx-de", "tx-a", "tx-genre", "tx-cherche"]) $("#" + id).value = "";
    page = 0; dessine();
  });
  $("#tx-tout").addEventListener("change", e => {
    const vus = filtrees().slice(page * PAR_PAGE, (page + 1) * PAR_PAGE);
    for (const o of vus) e.target.checked ? coches.add(o.i) : coches.delete(o.i);
    dessine();
  });
  // modification d'une cellule
  $("#tx-lignes").addEventListener("change", e => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const i = +tr.dataset.i, o = {...infos[i]}, v = e.target.value.trim(), champ = e.target.dataset.champ;
    if (e.target.classList.contains("coche")) {
      e.target.checked ? coches.add(i) : coches.delete(i); tr.classList.toggle("cochee", e.target.checked); return majCoches();
    }
    const faux = msg => { e.target.classList.add("faux"); e.target.title = msg; statut(`Ligne ${i + 1} : ${msg}`, "err"); };
    e.target.classList.remove("faux");
    if (champ === "pos") {
      const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!m || +m[1] < 1 || +m[2] < 1) return faux("position attendue : mesure.temps.tick, ex. 25.1.000");
      Object.assign(o, {m: +m[1], t: +m[2], k: +m[3]});
    } else if (champ === "note") {
      const n = lireNote(v); if (n === null) return faux("note inconnue (ex. Do3, Fa♯4, Si♭2 ou un numéro MIDI)");
      noteVers(o, n);
    } else if (champ === "dur") {
      const m = v.match(/^(\d+)(?:\.(\d+))?$/); if (!m || (+m[1] === 0 && !+(m[2] || 0))) return faux("durée attendue : temps.ticks, ex. 1.240");
      o.dur = `${+m[1]}.${(m[2] || "0").padStart(3, "0")}`;
    } else if (champ === "vel") {
      if (!/^\d+$/.test(v) || +v < 1 || +v > 127) return faux("vélocité de 1 à 127");
      o.vel = +v;
    } else if (champ === "instrument") {
      if (o.com === null || o.com === gm(+o.reste)) o.com = gm(+v);
      o.reste = v;
    } else if (champ === "reste") o.reste = v;
    else if (champ === "com") o.com = v || null;
    modifie(i, o);
  });
  $("#tx-lignes").addEventListener("click", e => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const i = +b.closest("tr").dataset.i, o = infos[i];
    avant();
    if (b.dataset.act === "dup") lignes.splice(i + 1, 0, lignes[i]);
    else if (b.dataset.act === "sup") lignes.splice(i, 1);
    else {
      const n = {m: o.m, t: o.t, k: o.k, genre: "note", note: o.genre === "note" && !o.malforme ? o.note : "Do3",
                 dur: o.genre === "note" && o.dur ? o.dur : "1.000", vel: o.vel || 80, extra: "", canal: o.canal, propre: o.propre, com: null};
      noteVers(n, lireNote(n.note) ?? 60);
      lignes.splice(i + 1, 0, ecrire(n));
    }
    apres(true);
    if (b.dataset.act !== "sup") setTimeout(() => montre(i + 2, true), 0);
  });
  // actions sur les lignes cochées
  document.querySelector(".tx-actions").addEventListener("click", e => {
    const a = e.target.dataset && e.target.dataset.a; if (!a || !coches.size) return;
    const ids = [...coches].sort((x, y) => x - y);
    avant();
    if (a === "suppr") { for (const i of ids.reverse()) lignes.splice(i, 1); return apres(true); }
    if (a === "dur-" || a === "dur+" || a === "lie") { dureesGroupees(ids, a); return apres(false); }
    if (a === "cale") { caleSurLeTemps(ids); return apres(false); }
    for (const i of ids) {
      const o = {...infos[i]}; if (o.type !== "evt") continue;
      if (a.startsWith("vel") && o.genre === "note" && !o.malforme) o.vel = Math.max(1, Math.min(127, o.vel + +a.slice(3)));
      else if (a.startsWith("tr") && o.genre === "note" && !o.malforme && o.canal !== 9) {
        const n = lireNote(o.note); if (n === null) continue;
        noteVers(o, Math.max(0, Math.min(127, n + +a.slice(2))));
      } else if (a.startsWith("dec")) {
        const t0 = mes.tick(o.m, o.t, o.k), t1 = t0 + Math.sign(+a.slice(3)) * mes.temps(t0);
        if (t1 < 0) continue;
        [o.m, o.t, o.k] = mes.position(t1);
      } else continue;
      lignes[i] = ecrire(o);
    }
    apres(false);
  });
  // durées des notes cochées : ± 1/8 de temps, ou « lié » (jusqu'à la note suivante de la même piste, moins un souffle)
  const dureeTicks = o => { const [b, k] = o.dur.split(".").map(Number); return b * mes.temps(o.tick) + k; };
  const ecritDuree = (o, d) => { const tp = mes.temps(o.tick); o.dur = `${Math.floor(d / tp)}.${String(d % tp).padStart(3, "0")}`; };
  function dureesGroupees(ids, a) {
    let suivantes = null;
    if (a === "lie") {                                   // débuts de notes de chaque piste et canal, triés
      suivantes = new Map();
      for (const o of infos) if (o.type === "evt" && o.genre === "note" && !o.malforme) {
        const k = `${o.piste}:${o.canal}`;
        if (!suivantes.has(k)) suivantes.set(k, []);
        suivantes.get(k).push(o.tick);
      }
      for (const l of suivantes.values()) l.sort((x, y) => x - y);
    }
    let n = 0;
    for (const i of ids) {
      const o = {...infos[i]};
      if (o.type !== "evt" || o.genre !== "note" || o.malforme) continue;
      const tp = mes.temps(o.tick), d = dureeTicks(o);
      let nd = d;
      if (a === "lie") {
        const prochaine = suivantes.get(`${o.piste}:${o.canal}`).find(t => t > o.tick);
        if (prochaine === undefined) continue;          // dernière note de la piste : on n'y touche pas
        nd = Math.max(1, prochaine - o.tick - Math.max(1, Math.round(tp / 16)));
      } else nd = Math.max(1, d + (a === "dur+" ? 1 : -1) * Math.max(1, Math.round(tp / 8)));
      if (nd === d) continue;
      ecritDuree(o, nd); lignes[i] = ecrire(o); n++;
    }
    statut(`${n} note(s) modifiée(s).`, "ok");
  }

  // caler sur le temps : une attaque à 1/16 de temps au plus d'un quart de temps y est ramenée, la fin de la note ne bouge pas
  function caleSurLeTemps(ids) {
    let n = 0;
    for (const i of ids) {
      const o = {...infos[i]};
      if (o.type !== "evt" || o.genre !== "note" || o.malforme) continue;
      const tp = mes.temps(o.tick), grille = tp / 4, tol = tp / 16;
      const cible = Math.round(o.tick / grille) * grille;
      if (cible === o.tick || Math.abs(cible - o.tick) > tol) continue;
      const fin = o.tick + dureeTicks(o);
      [o.m, o.t, o.k] = mes.position(cible);
      o.tick = cible;
      ecritDuree(o, Math.max(1, fin - cible));
      lignes[i] = ecrire(o); n++;
    }
    statut(`${n} note(s) calée(s) sur le temps (les notes déjà justes ou franchement décalées ne bougent pas).`, "ok");
  }

  // montrer une ligne (depuis la liste d'erreurs, ou après un ajout)
  function montre(n, garderFiltres) {
    const o = infos[n - 1];
    if (vue === "brut" || !o || o.type !== "evt") { if (vue !== "brut") choisitVue("brut"); return allerLigne(n); }
    if (vue !== "tableau") choisitVue("tableau");
    let liste = filtrees(), k = liste.indexOf(o);
    if (k < 0 && !garderFiltres) { for (const id of ["tx-piste", "tx-de", "tx-a", "tx-genre", "tx-cherche"]) $("#" + id).value = ""; liste = filtrees(); k = liste.indexOf(o); }
    if (k < 0) return;
    page = Math.floor(k / PAR_PAGE); dessine();
    const tr = $(`#tx-lignes tr[data-i="${n - 1}"]`);
    if (tr) { tr.scrollIntoView({block: "center"}); tr.classList.add("eclair"); setTimeout(() => tr.classList.remove("eclair"), 1700); }
  }

  // ───── texte brut
  function remplitBrut(garderPosition) {
    const z = $("#tx-zone"), haut = z.scrollTop, sel = [z.selectionStart, z.selectionEnd];
    const t = lignes.join("\n");
    if (z.value !== t) z.value = t;
    $("#tx-numeros").textContent = lignes.map((_, i) => i + 1).join("\n");
    if (garderPosition) { z.scrollTop = haut; z.setSelectionRange(...sel); }
    $("#tx-numeros").scrollTop = z.scrollTop;
  }
  function litBrut() {                                   // le texte brut tapé devient le contenu
    clearTimeout(minuterieBrut);
    const t = $("#tx-zone").value;
    if (t === lignes.join("\n")) return;
    avant(); lignes = t.split("\n");
    analyse(); memorise(); afficheErreurs(); verifierBientot();
    $("#tx-numeros").textContent = lignes.map((_, i) => i + 1).join("\n");
  }
  $("#tx-zone").addEventListener("input", () => { clearTimeout(minuterieBrut); minuterieBrut = setTimeout(litBrut, 500); });
  $("#tx-zone").addEventListener("scroll", e => { $("#tx-numeros").scrollTop = e.target.scrollTop; });
  function allerLigne(n) {
    const z = $("#tx-zone"); n = Math.max(1, Math.min(lignes.length, n));
    const deb = lignes.slice(0, n - 1).reduce((t, l) => t + l.length + 1, 0);
    z.focus(); z.setSelectionRange(deb, deb + lignes[n - 1].length);
    z.scrollTop = Math.max(0, (n - 1) * HAUT_LIGNE - z.clientHeight / 3);
    $("#tx-numeros").scrollTop = z.scrollTop;
  }
  $("#tx-aller").addEventListener("change", e => { if (+e.target.value) allerLigne(+e.target.value); });
  $("#tx-aller-mesure").addEventListener("change", e => {
    const v = +e.target.value, o = infos.find(x => x.type === "evt" && x.m >= v) || null;
    const rep = infos.find(x => x.com && new RegExp(`── mesure ${v} `).test(x.com));
    if (rep || o) allerLigne((rep || o).i + 1);
  });
  // rechercher / remplacer dans le texte brut (texte exact, sans expressions régulières)
  const zone = () => $("#tx-zone");
  function compte() {
    const q = $("#tx-rech").value;
    $("#tx-trouve").textContent = q ? `${zone().value.split(q).length - 1} occurrence(s)` : "";
  }
  function suivant() {
    const q = $("#tx-rech").value, z = zone(); if (!q) return false;
    let i = z.value.indexOf(q, z.selectionEnd);
    if (i < 0) i = z.value.indexOf(q);                  // on repart du début
    if (i < 0) { $("#tx-trouve").textContent = "introuvable"; return false; }
    z.focus(); z.setSelectionRange(i, i + q.length);
    const n = z.value.slice(0, i).split("\n").length;
    z.scrollTop = Math.max(0, (n - 1) * HAUT_LIGNE - z.clientHeight / 3); $("#tx-numeros").scrollTop = z.scrollTop;
    return true;
  }
  $("#tx-rech").addEventListener("input", compte);
  $("#tx-rech").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); suivant(); } });
  $("#tx-suivant").addEventListener("click", suivant);
  $("#tx-remplacer").addEventListener("click", () => {
    const q = $("#tx-rech").value, r = $("#tx-remp").value, z = zone(); if (!q) return;
    if (z.value.slice(z.selectionStart, z.selectionEnd) !== q) return suivant();
    const deb = z.selectionStart;
    z.setRangeText(r, z.selectionStart, z.selectionEnd, "end");
    litBrut(); remplitBrut(true); z.setSelectionRange(deb + r.length, deb + r.length);
    suivant(); compte();
  });
  $("#tx-tout-remplacer").addEventListener("click", () => {
    const q = $("#tx-rech").value, r = $("#tx-remp").value; if (!q) return;
    litBrut();
    const avantTexte = lignes.join("\n"), n = avantTexte.split(q).length - 1;
    if (!n) { $("#tx-trouve").textContent = "introuvable"; return; }
    avant(); lignes = avantTexte.split(q).join(r).split("\n"); apres(true);
    remplitBrut(true); compte();
    statut(`${n} remplacement(s) : « ${q} » → « ${r} ».`, "ok");
  });

  function choisitVue(v) {
    if (vue === "brut") litBrut();
    vue = v;
    $("#tx-tableau").hidden = v !== "tableau"; $("#tx-brut").hidden = v !== "brut";
    $("#tx-vue-tableau").setAttribute("aria-pressed", v === "tableau"); $("#tx-vue-brut").setAttribute("aria-pressed", v === "brut");
    if (v === "brut") remplitBrut(); else dessine();
  }
  $("#tx-vue-tableau").addEventListener("click", () => choisitVue("tableau"));
  $("#tx-vue-brut").addEventListener("click", () => choisitVue("brut"));
  $("#tx-annuler").addEventListener("click", () => { if (vue === "brut") litBrut(); annuler(); });
  $("#tx-retablir").addEventListener("click", retablir);

  // ───── chargement du texte du document
  function remplitPistes() {
    const sel = $("#tx-piste"), avant = sel.value;
    sel.innerHTML = `<option value="">toutes</option>` + pistes.map(p => `<option value="${p.n}">${esc(p.titre)}</option>`).join("");
    if ([...sel.options].some(o => o.value === avant)) sel.value = avant;
  }
  async function charge(sansBrouillon) {
    if (!MORCEAU) return;
    chemin = MORCEAU.chemin; hist = []; futur = []; coches.clear(); erreurs = new Map(); page = 0;
    const nom = DOC ? (DOC.copie || DOC.original).split(/[\\/]/).pop() : chemin.split(/[\\/]/).pop();
    $("#tx-source").innerHTML = `Le document en cours de <b>${esc(nom)}</b>${DOC && DOC.courante > 1 ? ` (version ${DOC.courante}, montage et corrections compris)` : ""}.`;
    $("#tx-etat").textContent = "lecture du document…";
    try {
      original = (await api("/api/texte/lire", {fichier: chemin})).texte.replace(/\n$/, "");
      let brouillon = null; try { brouillon = sansBrouillon ? null : localStorage.getItem(cle()); } catch (e) {}
      lignes = (brouillon ?? original).split("\n");
      analyse(); remplitPistes(); afficheErreurs();
      if (brouillon) statut("Texte : corrections en cours reprises (pas encore appliquées au document).", "ok");
      vue === "brut" ? remplitBrut() : dessine();
      verifier();
    } catch (e) { $("#tx-etat").textContent = ""; statut(e.message, "err"); }
  }
  $("#tx-reprendre").addEventListener("click", () => {
    if (lignes.join("\n") !== original && !confirm("Abandonner les corrections pas encore appliquées et revenir au texte du document ?")) return;
    try { localStorage.removeItem(cle()); } catch (e) {}
    charge(true);
  });

  document.addEventListener("keydown", e => {
    if (ONGLET !== "texte" || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey;
    if (c && k === "z" && !e.shiftKey) { e.preventDefault(); annuler(); }
    else if (c && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); retablir(); }
  });

  return {
    nouveauMorceau() { chemin = null; lignes = []; infos = []; original = ""; $("#tx-lignes").innerHTML = ""; if (ONGLET === "texte") charge(); },
    affiche() { if (MORCEAU && chemin !== MORCEAU.chemin) charge(); else if (vue === "brut") remplitBrut(true); else dessine(); },
    // corrections pas encore appliquées au document
    enAttente() {
      if (!chemin || !MORCEAU || chemin !== MORCEAU.chemin || !original) return false;
      return (vue === "brut" ? $("#tx-zone").value : lignes.join("\n")) !== original;
    },
    texte() { if (vue === "brut") litBrut(); return lignes.join("\n"); },
    oublie() { try { localStorage.removeItem(cle()); } catch (e) {} },
    montreErreurs(liste) { erreurs = new Map(liste.map(e => [e.ligne, e.message])); afficheErreurs(); dessine(true); },
  };
})();
