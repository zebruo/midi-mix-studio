// Mixeur MIDI — banc de montage : mesures entières (couper, copier, coller, dupliquer, déplacer)
// et retouche des notes d'une mesure (déplacer, durée, ajouter, supprimer, vélocité, transposer)
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)
//
// Le montage est la liste des mesures de l'original dans l'ordre voulu, ex. [1, 2, …, 18, 105, 106, …].
// Une mesure retouchée devient un objet {b, notes} : elle porte sa propre liste de notes
// [canal, note, vélocité, début, fin] (ticks depuis sa barre) ; ses autres copies gardent celles de l'original.
// Le serveur assemble le .mid avec des raccords propres (montage.py).

const MT = (() => {
  const cS = $("#mt-source"), cM = $("#mt-montage"), cG = $("#mt-grille"), cD = $("#mt-detail"), bulle = $("#mt-bulle");
  const GOUT = 150;                              // colonne des libellés, à gauche des bandes
  const COUL = ["#c98a3a", "#4f9f95", "#8c6fc0", "#b65c5c", "#5f8fc4", "#9aa04a", "#c47aa0", "#6aa86a"];
  let barres = [], hist = [], futur = [], presse = null, sel = null, selSrc = null, focus = "mt";
  let geste = null, sections = [], version = 0;
  let parBarre = [], etendue = {}, cibles = [], vue = null, gesteD = null, velNouvelle = 80;

  const nbSrc = () => MORCEAU ? MORCEAU.montage.secondes.length - 1 : 0;
  const plage = (a, b) => Array.from({length: Math.max(0, b - a + 1)}, (_, i) => a + i);
  const sb = x => typeof x === "number" ? x : x.b;                    // mesure de l'original
  const retouchee = x => typeof x !== "number";
  const copie = x => typeof structuredClone === "function" ? structuredClone(x) : JSON.parse(JSON.stringify(x));
  // plages pour le serveur : les mesures retouchées sont envoyées seules, avec leurs notes
  function segments(liste = barres) {
    const res = [];
    for (const x of liste) {
      const b = sb(x), d = res[res.length - 1];
      if (retouchee(x)) res.push({a: b, b, notes: x.notes});
      else if (d && !d.notes && d.b + 1 === b) d.b = b;
      else res.push({a: b, b});
    }
    return res;
  }
  // suites de mesures consécutives de l'original (retouchées ou non) : pour l'affichage et les raccords
  function suites(liste = barres) {
    const res = [];
    for (const x of liste) { const b = sb(x), d = res[res.length - 1]; if (d && d.b + 1 === b) d.b = b; else res.push({a: b, b}); }
    return res;
  }
  const fmtDuree = s => { s = Math.round(s); return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`; };

  // carte des tempos et des mesures du montage, pour la barre de transport
  function plan() {
    if (!MORCEAU) return {duree: 0, tempos: []};
    const C = MORCEAU.tempos, T = MORCEAU.montage.secondes, tempos = [];
    const segA = tt => C.reduce((s, x) => x.t <= tt + 1e-6 ? x : s, C[0]);
    const pousse = x => {
      let p = tempos[tempos.length - 1];
      if (p && Math.abs(p.t - x.t) < 1e-9) { tempos.pop(); p = tempos[tempos.length - 1]; }
      if (p && p.bpm === x.bpm && p.num === x.num && p.den === x.den) return;
      tempos.push(x);
    };
    let t = 0, m = 0;
    for (const g of suites()) {
      const t0 = T[g.a - 1], t1 = T[g.b], base = segA(t0);
      pousse({t, mesure: m, bpm: base.bpm, num: base.num, den: base.den});
      for (const x of C) if (x.t > t0 + 1e-6 && x.t < t1 - 1e-6)
        pousse({t: t + x.t - t0, mesure: m + x.mesure - (g.a - 1), bpm: x.bpm, num: x.num, den: x.den});
      t += t1 - t0; m += g.b - g.a + 1;
    }
    return {duree: t, tempos: tempos.length ? tempos : [{t: 0, mesure: 0, bpm: 120, num: 4, den: 4}]};
  }

  // ───── mémoire (par morceau, dans ce navigateur) et historique
  const cle = () => "mixeur.montage:" + MORCEAU.chemin;
  function memorise() { try { localStorage.setItem(cle(), JSON.stringify(barres)); } catch (e) {} }
  function nouveauMorceau() {
    hist = []; futur = []; presse = sel = selSrc = null; vue = null; version++;
    const n = nbSrc();
    const valide = x => Number.isInteger(x) ? x >= 1 && x <= n
      : x && Number.isInteger(x.b) && x.b >= 1 && x.b <= n && Array.isArray(x.notes);
    let lu = null; try { lu = JSON.parse(localStorage.getItem(cle()) || "null"); } catch (e) {}
    barres = Array.isArray(lu) && lu.length && lu.every(valide) ? lu : plage(1, n);
    sections = [0];
    for (let b = 1; b <= n; b++) { let k = 0; MORCEAU.tempos.forEach((x, i) => { if (x.mesure <= b - 1 + 1e-6) k = i; }); sections[b] = k; }
    // notes de l'original par mesure, en ticks depuis la barre (une attaque un peu en avance compte pour la mesure suivante)
    const B = MORCEAU.montage.bornes, avance = MORCEAU.montage.tpb >> 3;
    parBarre = Array.from({length: n + 1}, () => []); etendue = {};
    for (const [c, p, v, d, f] of MORCEAU.montage.notes) {
      let lo = 1, hi = n;
      while (lo < hi) { const mi = (lo + hi + 1) >> 1; if (B[mi - 1] <= d + avance) lo = mi; else hi = mi - 1; }
      parBarre[lo].push([c, p, v, d - B[lo - 1], f - B[lo - 1]]);
      const e = etendue[c] || (etendue[c] = [p, p]); e[0] = Math.min(e[0], p); e[1] = Math.max(e[1], p);
    }
    dessineTout();
  }
  const notesDe = x => retouchee(x) ? x.notes : parBarre[x];
  // un canal joué par plusieurs instruments (ex. clarinette puis piano) a une ligne par instrument :
  // une note appartient à l'instrument en place à son attaque (+ 1/8 de temps, pour les attaques en avance)
  function progDe(canal, tick) {
    const chg = MORCEAU.montage.programmes[String(canal)]; if (!chg) return null;
    let p = 0; for (const [t, q] of chg) { if (t > tick + (MORCEAU.montage.tpb >> 3)) break; p = q; }
    return p;
  }
  const cleLigne = p => p.prog == null ? String(p.canal) : `${p.canal}:${p.prog}`;
  const cleNote = (canal, tickSource) => { const q = progDe(canal, tickSource); return q == null ? String(canal) : `${canal}:${q}`; };
  function modifie(f, nouvelleSel, garderVue) {
    hist.push(copie(barres)); if (hist.length > 200) hist.shift(); futur = [];
    f(); apres(nouvelleSel, garderVue);
  }
  function apres(nouvelleSel, garderVue) {
    sel = nouvelleSel; version++;
    if (!garderVue) { focus = "mt"; vue = null; }
    memorise();
    if (ONGLET === "montage") TR.majCarte(plan());
    dessineTout(); aChange();
  }

  // ───── opérations sur les mesures
  const rien = () => majInfo("sélectionnez d'abord des mesures du montage");
  function copier() {
    const s = focus === "src" && selSrc ? plage(selSrc.de, selSrc.a) : sel ? copie(barres.slice(sel.de - 1, sel.a)) : null;
    if (!s) return majInfo("sélectionnez d'abord des mesures (original ou montage)");
    presse = s; majInfo(`${s.length} mesure(s) copiée(s)`);
  }
  function supprimer() {
    if (!sel) return rien();
    const de = sel.de, n = sel.a - sel.de + 1;
    if (n >= barres.length) return majInfo("le montage ne peut pas être vide");
    modifie(() => barres.splice(de - 1, n), null);
  }
  function couper() { if (!sel) return rien(); focus = "mt"; copier(); supprimer(); }
  function coller(apresSel) {
    if (!presse) return majInfo("rien à coller : copiez ou coupez d'abord des mesures");
    const k = sel ? (apresSel ? sel.a : sel.de - 1) : barres.length, bloc = copie(presse);
    modifie(() => barres.splice(k, 0, ...bloc), {de: k + 1, a: k + bloc.length});
  }
  function dupliquer() {
    if (!sel) return rien();
    const bloc = copie(barres.slice(sel.de - 1, sel.a)), k = sel.a;
    modifie(() => barres.splice(k, 0, ...bloc), {de: k + 1, a: k + bloc.length});
  }
  function garder() {
    if (!sel) return rien();
    const bloc = barres.slice(sel.de - 1, sel.a);
    modifie(() => { barres = bloc; }, {de: 1, a: bloc.length});
  }
  function deplace(k) {                          // k = frontière d'arrivée (0 = tout au début)
    const de = sel.de, a = sel.a, n = a - de + 1;
    if (k >= de - 1 && k <= a) return;
    const bloc = barres.slice(de - 1, a), kk = k > a ? k - n : k;
    modifie(() => { barres.splice(de - 1, n); barres.splice(kk, 0, ...bloc); }, {de: kk + 1, a: kk + n});
  }
  function annuler() { if (!hist.length) return majInfo("rien à annuler"); futur.push(barres); barres = hist.pop(); apres(sel && sel.a <= barres.length ? sel : null); }
  function retablir() { if (!futur.length) return majInfo("rien à rétablir"); hist.push(barres); barres = futur.pop(); apres(sel && sel.a <= barres.length ? sel : null); }
  function reinit() {                            // « Abandonner le montage » (↶ Annuler le rétablit)
    if (!enAttente()) return majInfo("aucun montage en cours à abandonner");
    if (!confirm("Abandonner le montage pas encore appliqué et revenir au document tel qu'il était en arrivant dans l'onglet ?")) return;
    modifie(() => { barres = plage(1, nbSrc()); }, null);
  }

  // ───── dessin des bandes
  function prepare(c, h) {
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth;
    c.style.height = h + "px";
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, h);
    return {g, W, H: h};
  }
  const echelle = W => (W - GOUT) / Math.max(nbSrc(), barres.length, 1);
  function libelle(g, titre, sous, H) {
    g.textBaseline = "alphabetic";
    g.fillStyle = "#c9ccd2"; g.font = "600 12px Bahnschrift, 'Arial Narrow', sans-serif"; g.fillText(titre.toUpperCase(), 8, H / 2 + 1);
    g.fillStyle = "#7d828c"; g.font = "11px Consolas, monospace"; g.fillText(sous, 8, H / 2 + 15);
  }
  function cases(g, liste, w, y, h, alpha) {
    liste.forEach((x, i) => {
      g.globalAlpha = alpha ? alpha(sb(x)) : .9; g.fillStyle = COUL[sections[sb(x)] % COUL.length];
      g.fillRect(GOUT + i * w, y, Math.max(1, w - (w > 4 ? 1 : 0)), h);
    });
    g.globalAlpha = 1;
  }
  function graduation(g, n, w, H, numero) {
    const pas = [1, 2, 4, 5, 10, 20, 50].find(p => w * p >= 24) || 100;
    g.font = "9px Consolas, monospace"; g.fillStyle = "#8a8f99";
    const W = g.canvas.clientWidth;
    for (let i = 1; i <= n; i++) {
      const txt = String(numero(i)), x = GOUT + (i - 1) * w + 2;
      if ((i === 1 || i % pas === 0) && x + g.measureText(txt).width <= W) g.fillText(txt, x, H - 1);
    }
  }
  function cadre(g, x, larg, H, actif) {
    g.fillStyle = actif ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.07)"; g.fillRect(x, 12, larg, H - 22);
    g.strokeStyle = actif ? "#ffae3c" : "#8a8f99"; g.lineWidth = 2; g.strokeRect(x + 1, 13, larg - 2, H - 24);
  }
  function dessineSource() {
    const {g, W, H} = prepare(cS, 52); if (!MORCEAU) return;
    const w = echelle(W), n = nbSrc(), utilisees = new Set(barres.map(sb));
    libelle(g, "Original", `${n} mesures`, H);
    cases(g, plage(1, n), w, 14, H - 26, b => utilisees.has(b) ? .9 : .25);
    g.font = "10px Consolas, monospace"; g.fillStyle = "#d8d4ca";
    let libre = 0;                                 // pas d'étiquettes de tempo qui se chevauchent
    for (const x of MORCEAU.tempos) {
      const txt = `${Math.round(x.bpm)} · ${x.num}/${x.den}`, px = GOUT + x.mesure * w + 3;
      if (px >= libre && px + g.measureText(txt).width <= W) { g.fillText(txt, px, 10); libre = px + g.measureText(txt).width + 8; }
    }
    graduation(g, n, w, H, i => i);
    if (selSrc) cadre(g, GOUT + (selSrc.de - 1) * w, (selSrc.a - selSrc.de + 1) * w, H, focus === "src");
  }
  function dessineMontage() {
    const {g, W, H} = prepare(cM, 52); if (!MORCEAU) return;
    const w = echelle(W);
    libelle(g, "Montage", `${barres.length} mesures`, H);
    cases(g, barres, w, 14, H - 26);
    g.fillStyle = "#ffffff";                       // point blanc = mesure dont les notes ont été retouchées
    barres.forEach((x, i) => { if (retouchee(x)) { g.beginPath(); g.arc(GOUT + (i + .5) * w, 19, Math.max(1.5, Math.min(3, w / 3)), 0, 7); g.fill(); } });
    let i0 = 0; g.font = "10px Consolas, monospace";
    for (const s of suites()) {
      const n = s.b - s.a + 1, x = GOUT + i0 * w, txt = s.a === s.b ? `${s.a}` : `${s.a}–${s.b}`;
      if (i0) { g.fillStyle = "#ffffff"; g.fillRect(x - 1, 8, 2, H - 14); }
      if (g.measureText(txt).width + 8 < n * w) { g.fillStyle = "#e8e4da"; g.fillText(txt, x + 5, 10); }
      i0 += n;
    }
    graduation(g, barres.length, w, H, i => i);
    if (sel) cadre(g, GOUT + (sel.de - 1) * w, (sel.a - sel.de + 1) * w, H, focus !== "src");
    if (geste && geste.type === "deplace" && geste.k !== null) { g.fillStyle = "#ffae3c"; g.fillRect(GOUT + geste.k * w - 2, 0, 4, H); }
    if (ONGLET === "montage") {
      const m = TR.mesure();
      if (m >= 0) { g.fillStyle = "#7dff9a"; g.fillRect(GOUT + m * w - 1, 0, 2, H); }
    }
  }
  function dessineGrille() {
    const hl = 13, H = Math.max(1, PISTES.length) * hl + 4;
    const {g, W} = prepare(cG, H); if (!MORCEAU) return;
    const w = echelle(W), A = MORCEAU.montage.activite, B = MORCEAU.montage.bornes;
    g.textBaseline = "middle";
    PISTES.forEach((p, r) => {
      const y = 2 + r * hl, ligne = A[cleLigne(p)] || [];
      const rvb = p.son.startsWith("sf:") ? "92,198,184" : "240,168,60";
      g.fillStyle = "#9a978f"; g.font = "11px 'Segoe UI', sans-serif";
      let nom = p.nom; while (nom.length > 3 && g.measureText(nom).width > GOUT - 14) nom = nom.slice(0, -2) + "…";
      g.fillText(nom, 8, y + hl / 2);
      barres.forEach((x, i) => {
        const k = retouchee(x) ? x.notes.filter(n => n[0] === p.canal && cleNote(n[0], B[x.b - 1] + n[3]) === cleLigne(p)).length
                               : ligne[x - 1] || 0;
        if (!k) return;
        g.fillStyle = `rgba(${rvb},${Math.min(1, .25 + k / 10)})`;
        g.fillRect(GOUT + i * w, y + 2, Math.max(1, w - (w > 4 ? 1 : 0)), hl - 3);
      });
    });
    g.textBaseline = "alphabetic";
  }
  function majInfo(msg) {
    const zone = $("#mt-info");
    if (!MORCEAU) { zone.textContent = "Chargez un morceau pour monter ses mesures."; return; }
    const raccords = suites().length - 1, nr = barres.filter(retouchee).length;
    let s = `Montage : <b>${barres.length}</b> mesures (original ${nbSrc()}) · <b>${fmtDuree(plan().duree)}</b> · ${raccords} raccord(s)`;
    if (nr) s += ` · ${nr} mesure(s) retouchée(s)`;
    if (sel) s += ` · sélection : mesures ${sel.de}–${sel.a} du montage`;
    if (selSrc) s += ` · original : mesures ${selSrc.de}–${selSrc.a}`;
    if (presse) s += ` · copiées : ${presse.length}`;
    zone.innerHTML = s + (msg ? ` — <b>${msg}</b>` : "");
  }

  // ───── détail des mesures : piano-roll, modifiable pour les mesures du montage
  const MAXD = 16;
  const NOMS = ["Do", "Do♯", "Ré", "Ré♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"];
  const nomNote = (p, canal) => canal === 9 ? `note ${p}` : `${NOMS[p % 12]}${Math.floor(p / 12) - 2}`;   // Do3 = do du milieu
  const virgule = x => String(Math.round(x * 100) / 100).replace(".", ",");
  function vueDetail() {
    if (focus === "src" && selSrc) return {liste: plage(selSrc.de, Math.min(selSrc.a, selSrc.de + MAXD - 1)), n: selSrc.a - selSrc.de + 1,
      titre: selSrc.de === selSrc.a ? `mesure ${selSrc.de} de l'original` : `mesures ${selSrc.de}–${selSrc.a} de l'original`, de: null};
    if (sel) {
      const liste = barres.slice(sel.de - 1, Math.min(sel.a, sel.de - 1 + MAXD));
      const orig = suites(liste).map(s => s.a === s.b ? `${s.a}` : `${s.a}–${s.b}`).join(", ");
      return {liste, n: sel.a - sel.de + 1, de: sel.de,
        titre: (sel.de === sel.a ? `mesure ${sel.de} du montage` : `mesures ${sel.de}–${sel.a} du montage`) + ` (= original ${orig})`};
    }
    return null;
  }
  // modèle de la vue : colonnes (mesures) et notes en ticks depuis le début de la vue
  function construitVue() {
    const v = MORCEAU && vueDetail();
    if (!v) return (vue = null);
    const cleVue = JSON.stringify([focus === "src", v.de, v.n, selSrc, version]);
    if (vue && vue.cle === cleVue) return vue;
    const M = MORCEAU.montage, B = M.bornes, C = MORCEAU.tempos;
    let off = 0;
    const cols = v.liste.map((x, i) => {
      const b = sb(x), s = C[sections[b]], L = B[b] - B[b - 1];
      const c = {b, x, L, off, num: s.num, den: s.den, bpm: s.bpm, retouchee: retouchee(x),
                 suite: i + 1 < v.liste.length && sb(v.liste[i + 1]) === b + 1};
      off += L; return c;
    });
    const notes = [];
    cols.forEach((c, i) => { for (const [ch, p, vel, d, f] of notesDe(c.x)) notes.push({ch, p, vel, d: c.off + d, f: c.off + f}); });
    const ancien = vue && vue.de === v.de && vue.cols.length === cols.length ? vue.choix : null;
    vue = {...v, cle: cleVue, cols, total: off, notes, choix: new Set(), edition: v.de !== null};
    if (ancien) for (const n of notes) for (const a of ancien) if (a.ch === n.ch && a.p === n.p && a.d === n.d && a.f === n.f) vue.choix.add(n);
    return vue;
  }
  const colDe = t => { const c = vue.cols; let k = 0; for (let i = 0; i < c.length; i++) if (c[i].off <= t) k = i; return c[k]; };
  function cale(t) {                              // calage sur la grille choisie, dans la mesure qui contient t
    const c = colDe(Math.max(0, t)), pas = c.L / c.num * +$("#mt-pas").value;
    return Math.max(0, Math.min(vue.total - 1, c.off + Math.round((t - c.off) / pas) * pas));
  }
  const pasT = t => { const c = colDe(Math.max(0, t)); return c.L / c.num * +$("#mt-pas").value; };
  const finAffichee = n => {                     // une note qui déborde sur un raccord résonne au plus un temps
    const c = colDe(n.d), lim = c.suite ? vue.total : c.off + c.L + c.L / c.num;
    return Math.min(n.f, lim, vue.total);
  };
  // les notes modifiées de la vue sont réécrites dans les mesures du montage
  function valideNotes() {
    const avance = MORCEAU.montage.tpb >> 3, nouv = vue.cols.map(() => []);
    for (const n of vue.notes) {
      let k = 0; vue.cols.forEach((c, i) => { if (c.off <= n.d + avance) k = i; });
      const c = vue.cols[k];
      nouv[k].push([n.ch, n.p, n.vel, Math.round(n.d - c.off), Math.round(n.f - c.off)]);
    }
    const sig = l => l.map(x => x.join(",")).sort().join("|");
    const avant = copie(vue.choix.size ? [...vue.choix] : []);
    modifie(() => {
      vue.cols.forEach((c, i) => {
        const idx = vue.de - 1 + i;
        if (sig(nouv[i]) === sig(notesDe(barres[idx]))) return;
        barres[idx] = sig(nouv[i]) === sig(parBarre[c.b]) ? c.b : {b: c.b, notes: nouv[i]};
      });
    }, sel, true);
    vue = null; construitVue();
    for (const n of vue.notes) for (const a of avant) if (a.ch === n.ch && a.p === n.p && a.d === n.d && a.f === n.f) vue.choix.add(n);
    dessineDetail();
  }
  function notesOrigine() {
    if (!vue || !vue.edition) return;
    modifie(() => vue.cols.forEach((c, i) => { barres[vue.de - 1 + i] = c.b; }), sel);
  }
  // pistes affichées : celles qui jouent dans la vue, resserrées sur leurs notes ; en modification, les autres
  // suivent en une ligne fine (double-clic dessus = ajouter une note au milieu de la tessiture de la piste)
  const cleDeVue = n => { const c = colDe(n.d); return cleNote(n.ch, MORCEAU.montage.bornes[c.b - 1] + n.d - c.off); };
  function rangees() {
    const parLigne = new Map();
    for (const n of vue.notes) { const k = cleDeVue(n); if (!parLigne.has(k)) parLigne.set(k, []); parLigne.get(k).push(n); }
    const pleines = PISTES.filter(p => parLigne.has(cleLigne(p))).map(p => {
      const ns = parLigne.get(cleLigne(p)), ps = ns.map(n => n.p);
      let lo = Math.max(0, Math.min(...ps) - 4), hi = Math.min(127, Math.max(...ps) + 4);
      while (hi - lo + 1 < 13) { if (lo > 0) lo--; if (hi - lo + 1 < 13 && hi < 127) hi++; }
      const hn = Math.max(4, Math.min(8, 170 / (hi - lo + 1)));
      return {p, ns, lo, hi, hn, h: (hi - lo + 1) * hn, bas: Math.min(...ps), haut: Math.max(...ps)};
    });
    const vides = vue.edition ? PISTES.filter(p => !parLigne.has(cleLigne(p))).map(p => {
      const e = etendue[p.canal] || [60, 60], m = Math.round((e[0] + e[1]) / 2);
      return {p, ns: [], lo: m, hi: m, hn: 16, h: 16, vide: true};
    }) : [];
    return [...pleines, ...vides];
  }
  function dessineDetail() {
    const titre = $("#mt-detail-titre");
    construitVue();
    cibles = [];
    $("#mt-edition").hidden = !(vue && vue.edition);
    $("#mt-detail-fermer").hidden = !vue;
    $("#mt-suivre").hidden = !(vue && vue.edition);
    cD.parentElement.hidden = !vue;                 // détail fermé : pas de cadre noir vide
    cD.classList.toggle("edition", !!(vue && vue.edition));
    if (!vue) {
      titre.textContent = "Détail : sélectionnez une ou plusieurs mesures (montage ou original) pour voir leurs notes.";
      return;
    }
    const lignes = rangees(), ENT = 18, esp = l => l.vide ? 2 : 6;
    const H = ENT + lignes.reduce((t, l) => t + l.h + esp(l), 0) + 4;
    const {g, W} = prepare(cD, Math.max(H, 40)), sx = (W - GOUT) / vue.total;
    vue.sx = sx; vue.lignes = lignes;
    g.font = "10px Consolas, monospace"; g.textBaseline = "alphabetic";
    vue.cols.forEach((c, i) => {
      const x = GOUT + c.off * sx, temps = c.L / c.num;
      const change = i === 0 || vue.cols[i - 1].bpm !== c.bpm || vue.cols[i - 1].num !== c.num;
      const txt = (vue.de ? `${vue.de + i} (orig ${c.b})` : `${c.b}`) + (c.retouchee ? " ✎" : "")
        + (change && i ? ` · ${virgule(c.bpm)} bpm ${c.num}/${c.den}` : "");
      g.fillStyle = c.retouchee ? "#ffffff" : "#d8d4ca";
      if (g.measureText(txt).width + 6 < c.L * sx) g.fillText(txt, x + 4, 12);
      for (let k = 1; k < c.num; k++) { g.fillStyle = "#2c3036"; g.fillRect(x + k * temps * sx, ENT, 1, H - ENT); }
      const raccord = i > 0 && vue.cols[i - 1].b + 1 !== c.b;
      g.fillStyle = raccord ? "#ffffff" : "#4a4e57"; g.fillRect(x - (raccord ? 1 : 0), 2, raccord ? 2 : 1, H - 2);
    });
    let y = ENT;
    for (const l of lignes) {
      const rvb = l.p.son.startsWith("sf:") ? "92,198,184" : "240,168,60";
      l.y = y;
      g.fillStyle = "#1b1d21"; g.fillRect(GOUT, y, W - GOUT, l.h);
      if (vue.edition) for (let q = l.lo; q <= l.hi; q++) if (q % 12 === 0) { g.fillStyle = "#24272d"; g.fillRect(GOUT, y + (l.hi - q + 1) * l.hn - 1, W - GOUT, 1); }
      g.textBaseline = "middle"; g.fillStyle = l.vide ? "#6b6f78" : "#c9ccd2"; g.font = "11px 'Segoe UI', sans-serif";
      let nom = l.p.nom; while (nom.length > 3 && g.measureText(nom).width > GOUT - 14) nom = nom.slice(0, -2) + "…";
      g.fillText(nom, 8, y + Math.min(l.h / 2, 10));
      g.fillStyle = "#7d828c"; g.font = "10px Consolas, monospace";
      if (!l.vide) g.fillText(l.bas === l.haut ? nomNote(l.bas, l.p.canal) : `${nomNote(l.bas, l.p.canal)}–${nomNote(l.haut, l.p.canal)}`,
                              8, y + Math.min(l.h / 2, 10) + 13);
      for (const n of l.ns) {
        const d = n._d ?? n.d, f = n._f ?? n.f, p = n._p ?? n.p;
        const fin = gesteD ? Math.min(f, vue.total) : finAffichee(n);
        const x = GOUT + d * sx, w = Math.max(3, (fin - d) * sx - 1), yy = y + (l.hi - p) * l.hn;
        const choisie = vue.choix.has(n);
        g.fillStyle = `rgba(${rvb},${(.35 + n.vel / 127 * .65).toFixed(2)})`;
        g.fillRect(x, yy, w, Math.max(2, l.hn - 1));
        if (choisie) { g.strokeStyle = "#ffffff"; g.lineWidth = 1.5; g.strokeRect(x - .5, yy - .5, w + 1, Math.max(2, l.hn - 1) + 1); }
        cibles.push({x, y: yy - 1, w: Math.max(w, 4), h: Math.max(4, l.hn + 1), n, l});
      }
      y += l.h + esp(l);
    }
    g.textBaseline = "alphabetic";
    if (gesteD && gesteD.type === "cadre" && gesteD.x1 !== undefined) {
      g.strokeStyle = "#ffae3c"; g.lineWidth = 1; g.setLineDash([4, 3]);
      g.strokeRect(Math.min(gesteD.x0, gesteD.x1), Math.min(gesteD.y0, gesteD.y1), Math.abs(gesteD.x1 - gesteD.x0), Math.abs(gesteD.y1 - gesteD.y0));
      g.setLineDash([]);
    }
    if (vue.de && ONGLET === "montage") {          // tête de lecture
      const m = TR.mesure() - (vue.de - 1), i = Math.floor(m);
      if (i >= 0 && i < vue.cols.length) { g.fillStyle = "#7dff9a"; g.fillRect(GOUT + (vue.cols[i].off + (m - i) * vue.cols[i].L) * sx - 1, 0, 2, H); }
    }
    const c0 = vue.cols[0];
    titre.innerHTML = `Détail : <b>${vue.titre}</b> · ${virgule(c0.bpm)} bpm · ${c0.num}/${c0.den}`
      + (vue.n > MAXD ? ` · ${MAXD} premières mesures affichées` : "")
      + (vue.edition ? " · <b>modifiable</b> : clic = choisir, glisser = déplacer, bord droit = durée, double-clic = ajouter"
                     : " · lecture seule (sélectionnez dans le montage pour modifier)");
    majEdition();
  }
  function majEdition() {
    if (!vue || !vue.edition) return;
    const ch = [...vue.choix], n = ch.length;
    $("#mt-notes-info").textContent = n ? `${n} note(s) sélectionnée(s)` + (n === 1 ? ` : ${nomNote(ch[0].p, ch[0].ch)}` : "") : "aucune note sélectionnée";
    for (const id of ["mt-vel", "mt-vel-moins", "mt-vel-plus", "mt-oct-bas", "mt-dt-bas", "mt-dt-haut", "mt-oct-haut", "mt-notes-suppr"]) $("#" + id).disabled = !n;
    if (n) { const m = Math.round(ch.reduce((t, x) => t + x.vel, 0) / n); $("#mt-vel").value = m; $("#mt-velv").textContent = m; }
    else $("#mt-velv").textContent = "—";
    $("#mt-notes-orig").disabled = !vue.cols.some(c => c.retouchee);
  }
  // actions sur les notes choisies
  function surChoix(f) { if (!vue || !vue.edition || !vue.choix.size) return; for (const n of vue.choix) f(n); valideNotes(); }
  const transpose = k => surChoix(n => { n.p = Math.max(0, Math.min(127, n.p + k)); });
  const nuance = k => surChoix(n => { n.vel = Math.max(1, Math.min(127, n.vel + k)); velNouvelle = n.vel; });
  function supprimeNotes() {
    if (!vue || !vue.edition || !vue.choix.size) return;
    vue.notes = vue.notes.filter(n => !vue.choix.has(n)); vue.choix.clear(); valideNotes();
  }

  // souris dans le détail
  function point(e) { const r = cD.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; }
  const touchee = (x, y) => [...cibles].reverse().find(c => x >= c.x - 1 && x <= c.x + c.w + 1 && y >= c.y && y <= c.y + c.h);
  const ligneA = y => vue.lignes.find(l => y >= l.y && y < l.y + l.h);
  cD.addEventListener("pointerdown", e => {
    if (!vue || !vue.edition) return;
    const {x, y} = point(e); if (x < GOUT) return;
    focus = "detail";
    const t = touchee(x, y);
    cD.setPointerCapture(e.pointerId);
    if (t) {
      if (e.ctrlKey || e.shiftKey) { vue.choix.has(t.n) ? vue.choix.delete(t.n) : vue.choix.add(t.n); }
      else if (!vue.choix.has(t.n)) { vue.choix.clear(); vue.choix.add(t.n); }
      const bord = x >= t.x + t.w - 5 && t.w >= 8;
      gesteD = {type: bord ? "duree" : "deplace", x0: x, y0: y, n: t.n, l: t.l, bouge: false};
    } else {
      if (!e.shiftKey && !e.ctrlKey) vue.choix.clear();
      gesteD = {type: "cadre", x0: x, y0: y, avant: new Set(vue.choix)};
    }
    bulle.hidden = true; dessineDetail();
  });
  cD.addEventListener("pointermove", e => {
    const {x, y} = point(e);
    if (!gesteD) return survol(e, x, y);
    const g = gesteD, dt = (x - g.x0) / vue.sx;
    if (Math.abs(x - g.x0) > 3 || Math.abs(y - g.y0) > 3) g.bouge = true;
    if (!g.bouge) return;
    if (g.type === "deplace") {
      const dec = cale(g.n.d + dt) - g.n.d, dp = Math.round((g.y0 - y) / g.l.hn);
      for (const n of vue.choix) {
        const l = vue.lignes.find(r => r.ns.includes(n));
        n._d = Math.max(0, Math.min(vue.total - 1, n.d + dec)); n._f = n._d + (n.f - n.d);
        n._p = Math.max(l ? l.lo : 0, Math.min(l ? l.hi : 127, n.p + dp));
      }
    } else if (g.type === "duree") {
      const fin = Math.max(g.n.d + pasT(g.n.d) / 2, cale(g.n.f + dt)), dec = fin - g.n.f;
      for (const n of vue.choix) n._f = Math.max(n.d + 10, n.f + dec);
    } else {
      g.x1 = x; g.y1 = y;
      const x0 = Math.min(g.x0, x), x1 = Math.max(g.x0, x), y0 = Math.min(g.y0, y), y1 = Math.max(g.y0, y);
      vue.choix = new Set(g.avant);
      for (const c of cibles) if (c.x < x1 && c.x + c.w > x0 && c.y < y1 && c.y + c.h > y0) vue.choix.add(c.n);
    }
    dessineDetail();
  });
  cD.addEventListener("pointerup", () => {
    const g = gesteD; gesteD = null;
    if (!g) return;
    if (g.bouge && (g.type === "deplace" || g.type === "duree")) {
      let change = false;
      for (const n of vue.choix) {
        if (n._d !== undefined && (n._d !== n.d || n._p !== n.p)) change = true;
        if (n._f !== undefined && n._f !== n.f) change = true;
        n.d = n._d ?? n.d; n.f = n._f ?? n.f; n.p = n._p ?? n.p; delete n._d; delete n._f; delete n._p;
      }
      if (change) return valideNotes();
    }
    dessineDetail();
  });
  cD.addEventListener("dblclick", e => {
    if (!vue || !vue.edition) return;
    const {x, y} = point(e); if (x < GOUT || touchee(x, y)) return;
    const l = ligneA(y); if (!l) return;
    const d = cale((x - GOUT) / vue.sx), p = Math.max(l.lo, Math.min(l.hi, Math.round(l.hi - (y - l.y) / l.hn + .5)));
    const n = {ch: l.p.canal, p, vel: velNouvelle, d, f: d + pasT(d)};
    vue.notes.push(n); vue.choix = new Set([n]); valideNotes();
  });
  function survol(e, x, y) {
    const t = vue && touchee(x, y);
    if (!t) { bulle.hidden = true; return; }
    const {n, l} = t, c = colDe(n.d), temps = c.L / c.num;
    bulle.innerHTML = `${l.p.nom} · <b>${nomNote(n.p, l.p.canal)}</b> (MIDI ${n.p}) · vélocité ${n.vel}<br>`
      + `${vue.de ? `mesure ${vue.de + vue.cols.indexOf(c)} du montage (orig ${c.b})` : `mesure ${c.b} de l'original`}`
      + `, temps ${virgule(1 + (n.d - c.off) / temps)} · durée ${virgule((n.f - n.d) / temps)} temps`;
    bulle.hidden = false;
    const zone = cD.parentElement.getBoundingClientRect();
    bulle.style.left = Math.min(e.clientX - zone.left + 12, zone.width - bulle.offsetWidth - 4) + "px";
    bulle.style.top = (e.clientY - zone.top + 14) + "px";
  }
  cD.addEventListener("mouseleave", () => bulle.hidden = true);
  $("#mt-vel").addEventListener("input", e => $("#mt-velv").textContent = e.target.value);
  $("#mt-vel").addEventListener("change", e => { const v = +e.target.value; velNouvelle = v; surChoix(n => { n.vel = v; }); });
  $("#mt-vel-moins").addEventListener("click", () => nuance(-10));
  $("#mt-vel-plus").addEventListener("click", () => nuance(10));
  $("#mt-oct-bas").addEventListener("click", () => transpose(-12));
  $("#mt-dt-bas").addEventListener("click", () => transpose(-1));
  $("#mt-dt-haut").addEventListener("click", () => transpose(1));
  $("#mt-oct-haut").addEventListener("click", () => transpose(12));
  $("#mt-notes-suppr").addEventListener("click", supprimeNotes);
  $("#mt-notes-orig").addEventListener("click", notesOrigine);

  function dessineTout() { dessineSource(); dessineMontage(); dessineGrille(); dessineDetail(); majInfo(); }

  // ───── souris sur les bandes : choisir, étendre (Maj), glisser une sélection pour la déplacer, double-clic pour s'y placer
  function ou(c, e, n) {
    const r = c.getBoundingClientRect(), w = echelle(r.width), x = (e.clientX - r.left - GOUT) / w;
    return {dedans: e.clientX - r.left >= GOUT, i: Math.min(n, Math.max(1, Math.floor(x) + 1)), k: Math.max(0, Math.min(n, Math.round(x)))};
  }
  cM.addEventListener("pointerdown", e => {
    if (!MORCEAU) return;
    const p = ou(cM, e, barres.length); if (!p.dedans) return;
    cM.setPointerCapture(e.pointerId); focus = "mt";
    if (sel && !e.shiftKey && p.i >= sel.de && p.i <= sel.a) geste = {type: "deplace", x0: e.clientX, k: null, i: p.i};
    else {
      const ancre = e.shiftKey && sel ? (p.i < sel.de ? sel.a : sel.de) : p.i;
      geste = {type: "choix", ancre}; sel = {de: Math.min(ancre, p.i), a: Math.max(ancre, p.i)};
    }
    dessineTout();
  });
  cM.addEventListener("pointermove", e => {
    if (!geste) return;
    const p = ou(cM, e, barres.length);
    if (geste.type === "choix") { sel = {de: Math.min(geste.ancre, p.i), a: Math.max(geste.ancre, p.i)}; majInfo(); }
    else if (Math.abs(e.clientX - geste.x0) > 4) geste.k = p.k;
    dessineMontage();
  });
  cM.addEventListener("pointerup", () => {
    if (geste && geste.type === "deplace") {
      const g = geste; geste = null;
      if (g.k !== null) return deplace(g.k);
      sel = {de: g.i, a: g.i};
    }
    geste = null; dessineTout();
  });
  cM.addEventListener("dblclick", e => {
    const p = ou(cM, e, barres.length);
    if (p.dedans && ONGLET === "montage") TR.vaMesure(p.i - 1);
  });
  let gesteSrc = null;
  cS.addEventListener("pointerdown", e => {
    if (!MORCEAU) return;
    const p = ou(cS, e, nbSrc()); if (!p.dedans) return;
    cS.setPointerCapture(e.pointerId); focus = "src";
    const ancre = e.shiftKey && selSrc ? (p.i < selSrc.de ? selSrc.a : selSrc.de) : p.i;
    gesteSrc = ancre; selSrc = {de: Math.min(ancre, p.i), a: Math.max(ancre, p.i)}; dessineTout();
  });
  cS.addEventListener("pointermove", e => {
    if (gesteSrc === null) return;
    const p = ou(cS, e, nbSrc());
    selSrc = {de: Math.min(gesteSrc, p.i), a: Math.max(gesteSrc, p.i)}; dessineSource(); majInfo();
  });
  cS.addEventListener("pointerup", () => { gesteSrc = null; dessineTout(); });

  // ───── boutons et raccourcis
  // (annuler / rétablir : boutons du haut de la page et Ctrl+Z / Ctrl+Y, voir app.js)
  const actions = {"mt-couper": couper, "mt-copier": copier,
    "mt-coller-avant": () => coller(false), "mt-coller-apres": () => coller(true), "mt-dupliquer": dupliquer,
    "mt-supprimer": supprimer, "mt-garder": garder, "mt-reinit": reinit};
  for (const [id, f] of Object.entries(actions)) $("#" + id).addEventListener("click", () => { if (MORCEAU) f(); });
  // fermer le détail (piano-roll) = ne plus rien sélectionner
  function fermeDetail() { sel = selSrc = null; focus = "mt"; dessineTout(); }
  $("#mt-detail-fermer").addEventListener("click", fermeDetail);

  // « Suivre la lecture » : pendant la lecture, quand la tête sort des mesures affichées, le détail tourne la page
  // (même nombre de mesures ; la sélection du montage suit). Choix gardé dans ce navigateur.
  let suivre = false;
  try { suivre = localStorage.getItem("mixeur.suivre") === "1"; } catch (e) {}
  $("#mt-suivre").setAttribute("aria-pressed", suivre);
  $("#mt-suivre").addEventListener("click", e => {
    suivre = !suivre; e.currentTarget.setAttribute("aria-pressed", suivre);
    try { localStorage.setItem("mixeur.suivre", suivre ? "1" : "0"); } catch (e) {}
    if (suivre) suitLecture();
  });
  // le bouton boucle du transport se pose sur les mesures sélectionnées du montage
  TR.boucleSur(() => ONGLET === "montage" && sel && focus !== "src" ? sel : null);
  function suitLecture() {
    if (!suivre || !sel || focus === "src" || !vue || !vue.edition) return;
    const m = Math.floor(TR.mesure() + 1e-6) + 1;          // mesure du montage sous la tête de lecture
    const n = Math.min(sel.a - sel.de + 1, MAXD);
    if (m < 1 || m > barres.length || (m >= sel.de && m < sel.de + n)) return;
    let de = sel.de + Math.floor((m - sel.de) / n) * n;
    const a = Math.min(barres.length, Math.max(1, de) + n - 1);
    de = Math.max(1, a - n + 1);
    sel = {de, a}; dessineTout();
  }
  document.addEventListener("keydown", e => {
    if (ONGLET !== "montage" || !MORCEAU || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey, notes = focus === "detail" && vue && vue.edition;
    let f = null;
    if (notes && c && k === "a") f = () => { vue.choix = new Set(vue.notes); dessineDetail(); };
    else if (notes && (e.key === "Delete" || e.key === "Backspace")) f = supprimeNotes;
    else if (notes && e.key === "ArrowUp" && !c) f = () => transpose(e.shiftKey ? 12 : 1);
    else if (notes && e.key === "ArrowDown" && !c) f = () => transpose(e.shiftKey ? -12 : -1);
    else if (notes && e.key === "Escape" && vue.choix.size) f = () => { vue.choix.clear(); dessineDetail(); };
    else if (c && k === "x") f = couper;
    else if (c && k === "c") f = copier;
    else if (c && k === "v") f = () => coller(e.shiftKey);
    else if (c && k === "d") f = dupliquer;
    else if (e.key === "Delete" || e.key === "Backspace") f = supprimer;
    else if (e.key === "Escape") f = fermeDetail;
    if (f) { e.preventDefault(); f(); }
  });

  // ───── montage en attente d'être appliqué au document (en quittant l'onglet, ou avec « Enregistrer »)
  function enAttente() {
    if (!MORCEAU) return false;
    const n = nbSrc();
    return barres.length !== n || barres.some((x, i) => retouchee(x) || x !== i + 1);
  }
  function oublie() { try { localStorage.removeItem(cle()); } catch (e) {} }

  // tête de lecture sur la bande du montage et dans le détail
  (function boucle() {
    if (ONGLET === "montage" && MORCEAU && !geste && !gesteD) {
      if (!$("#lecteur").paused) suitLecture();
      dessineMontage();
      if (!$("#lecteur").paused) dessineDetail();
    }
    requestAnimationFrame(boucle);
  })();
  window.addEventListener("resize", () => { if (ONGLET === "montage") dessineTout(); });

  return {plan, segments: () => segments(), nouveauMorceau, dessineTout, enAttente, oublie,
    annuler, retablir, peutAnnuler: () => hist.length > 0, peutRetablir: () => futur.length > 0};
})();
