// Mixeur MIDI — tableau des pistes : moteur, son, volume, pan, muet/solo, recherche de sons
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

function optionsSons(moteur, choisi, nomOrigine) {
  const liste = moteur === "gu" ? SONS.gu : SONS.sf;
  let html = moteur === "gu" ? `<option value="gu:orig"${choisi === "gu:orig" ? " selected" : ""}>Son d'origine — ${nomOrigine}</option>` : "";
  let groupe = null;
  for (const s of liste) {
    if (s.groupe !== groupe) { if (groupe !== null) html += "</optgroup>"; html += `<optgroup label="${s.groupe}">`; groupe = s.groupe; }
    html += `<option value="${s.id}"${s.id === choisi ? " selected" : ""}>${s.nom}</option>`;
  }
  return html + (groupe !== null ? "</optgroup>" : "");
}
const panTxt = x => x > 0 ? "D" + x : x < 0 ? "G" + (-x) : "C";

function dessine() {
  NIVEAUX = null;
  const tb = $("#pistes");
  tb.innerHTML = "";
  PISTES.forEach((p, i) => {
    const moteur = p.son.startsWith("sf:") ? "sf" : "gu";
    const tr = document.createElement("tr");
    tr.className = moteur;
    tr.innerHTML = `<td class="ch">${String(p.canal + 1).padStart(2, "0")}</td><td class="name">${p.nom}</td>
      <td><select class="eng" id="eng${i}" aria-label="Moteur ${p.nom}"><option value="gu"${moteur === "gu" ? " selected" : ""}>FluidSynth</option><option value="sf"${moteur === "sf" ? " selected" : ""}>sfizz</option></select></td>
      <td><select class="son" id="son${i}" aria-label="Son ${p.nom}">${optionsSons(moteur, p.son, p.nom)}</select></td>
      <td class="notes">${p.notes.toLocaleString("fr-FR")}</td>
      <td><div class="fader"><input id="vol${i}" type="range" min="0" max="100" value="${p.volume}" aria-label="Volume ${p.nom}"><span class="val">${p.volume}</span></div></td>
      <td><div class="fader"><input id="pan${i}" class="pan" type="range" min="-100" max="100" value="${p.pan}" aria-label="Pan ${p.nom}"><span class="val">${panTxt(p.pan)}</span></div></td>
      <td><div class="vum" title="Niveau de la piste pendant l'écoute (avec son volume)"><i></i><b></b></div></td>
      <td><div class="ms"><button class="m" type="button" aria-pressed="${p.muet}" aria-label="Muet ${p.nom}">M</button><button class="s" type="button" aria-pressed="${p.solo}" aria-label="Solo ${p.nom}">S</button></div></td>`;
    tb.appendChild(tr);
    const eng = tr.querySelector(".eng"), son = tr.querySelector(".son");
    eng.addEventListener("change", () => {
      tr.className = eng.value;
      son.innerHTML = optionsSons(eng.value, eng.value === "gu" ? "gu:orig" : SONS.sf[0].id, p.nom);
      p.son = son.value; filtre(); aChange();
    });
    son.addEventListener("change", () => { p.son = son.value; aChange(); });
    // curseurs : l'affichage suit le geste, le mixage est mis à jour quand on relâche
    const vol = tr.querySelector(`#vol${i}`), pan = tr.querySelector(`#pan${i}`);
    vol.addEventListener("input", () => { p.volume = +vol.value; vol.nextElementSibling.textContent = p.volume; });
    pan.addEventListener("input", () => { p.pan = +pan.value; pan.nextElementSibling.textContent = panTxt(p.pan); });
    vol.addEventListener("change", aChange); pan.addEventListener("change", aChange);
    tr.querySelector(".m").addEventListener("click", e => { p.muet = !p.muet; e.target.setAttribute("aria-pressed", p.muet); grise(); aChange(); });
    tr.querySelector(".s").addEventListener("click", e => { p.solo = !p.solo; e.target.setAttribute("aria-pressed", p.solo); grise(); aChange(); });
  });
  grise(); filtre();
}
function grise() {
  const solo = PISTES.some(p => p.solo);
  [...$("#pistes").rows].forEach((r, i) => { const p = PISTES[i]; if (p) r.classList.toggle("muted", p.muet || (solo && !p.solo)); });
}
function filtre() {
  const q = $("#filtre").value.trim().toLowerCase();
  document.querySelectorAll("select.son").forEach(sel => {
    sel.querySelectorAll("option").forEach(o => { o.hidden = q && !o.selected && !o.textContent.toLowerCase().includes(q) && o.value !== "gu:orig"; });
    sel.querySelectorAll("optgroup").forEach(g => { g.hidden = q && ![...g.children].some(o => !o.hidden); });
  });
}
$("#filtre").addEventListener("input", filtre);

// ───── vumètres des pistes
// Le serveur donne le niveau de chaque piste rendue (toutes les 50 ms) et le gain général du mixage ;
// la page y ajoute le volume de la piste et suit la position de lecture : réaction immédiate aux curseurs, muet, solo.
let NIVEAUX = null;
const clePiste = p => p.prog == null ? String(p.canal) : `${p.canal}:${p.prog}`;
async function chargeNiveaux() {
  if (!MORCEAU || ONGLET !== "mixage") return;
  const m = MORCEAU;
  try { const r = await api("/api/niveaux", {fichier: m.chemin, ...reglages()}); if (MORCEAU === m) NIVEAUX = r; } catch (e) {}
}
(function vumetres() {
  requestAnimationFrame(vumetres);
  if (ONGLET !== "mixage" || !MORCEAU) return;
  const a = $("#lecteur"), joue = NIVEAUX && a.src && !a.paused, t = a.currentTime, now = performance.now();
  const solo = PISTES.some(p => p.solo);
  [...$("#pistes").rows].forEach((r, i) => {
    const p = PISTES[i], el = r.querySelector(".vum"); if (!p || !el) return;
    let db = -100;
    const n = joue && NIVEAUX.pistes[clePiste(p)];
    if (n && !p.muet && !(solo && !p.solo) && p.volume > 0) {
      const v = n.niv[Math.floor(t / NIVEAUX.pas)];
      if (v !== undefined && v > -100) db = v + n.base + 40 * Math.log10(p.volume / 70) + NIVEAUX.gain;
    }
    const cible = Math.max(0, Math.min(100, (db + 48) / 48 * 100));
    const w = Math.max(cible, (+el.dataset.w || 0) - 2.5);         // retombée douce
    el.dataset.w = w; el.firstElementChild.style.width = w + "%";
    if (cible >= (+el.dataset.pic || 0) || now - (+el.dataset.picT || 0) > 1500) { el.dataset.pic = cible; el.dataset.picT = now; }
    el.lastElementChild.style.left = `calc(${el.dataset.pic}% - 2px)`;
    el.lastElementChild.style.opacity = +el.dataset.pic > 0 ? .85 : 0;
  });
})();
