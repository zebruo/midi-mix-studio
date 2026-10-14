// Mixeur MIDI — tableau des pistes : son (et donc moteur), volume, pan, muet/solo, vumètres
// (le choix du son, avec sa recherche, est dans sons.js)
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

const panTxt = x => x > 0 ? "D" + x : x < 0 ? "G" + (-x) : "C";

function dessine() {
  NIVEAUX = null; CHOIX_SON.ferme();
  const tb = $("#pistes");
  tb.innerHTML = "";
  PISTES.forEach((p, i) => {
    const moteur = p.son.startsWith("sf:") ? "sf" : "gu";
    const tr = document.createElement("tr");
    tr.className = moteur;
    tr.innerHTML = `<td class="ch">${String(p.canal + 1).padStart(2, "0")}</td><td class="name">${p.nom}</td>
      <td><button type="button" class="son-choix" aria-haspopup="dialog" aria-label="Son de ${p.nom}"><span class="moteur"></span><span class="son-nom"></span><span class="fleche">▾</span></button></td>
      <td class="notes">${p.notes.toLocaleString("fr-FR")}</td>
      <td><div class="fader"><input id="vol${i}" type="range" min="0" max="100" value="${p.volume}" aria-label="Volume ${p.nom}"><span class="val">${p.volume}</span></div></td>
      <td><div class="fader"><input id="pan${i}" class="pan" type="range" min="-100" max="100" value="${p.pan}" aria-label="Pan ${p.nom}"><span class="val">${panTxt(p.pan)}</span></div></td>
      <td><div class="vum" title="Niveau de la piste pendant l'écoute (avec son volume)"><i></i><b></b></div></td>
      <td><div class="ms"><button class="m" type="button" aria-pressed="${p.muet}" aria-label="Muet ${p.nom}">M</button><button class="s" type="button" aria-pressed="${p.solo}" aria-label="Solo ${p.nom}">S</button></div></td>`;
    tb.appendChild(tr);
    // le son : un bouton qui ouvre le sélecteur (sons.js) ; choisir un son règle aussi le moteur
    const son = tr.querySelector(".son-choix");
    const afficheSon = () => {
      const m = p.son.startsWith("sf:") ? "sf" : "gu", nom = CHOIX_SON.nomDe(p.son, p);      tr.classList.remove("gu", "sf"); tr.classList.add(m);
      son.querySelector(".moteur").textContent = m === "sf" ? "sfizz" : "GU";
      son.querySelector(".son-nom").textContent = nom; son.title = nom;
    };
    afficheSon();
    son.addEventListener("click", () => CHOIX_SON.ouvre(son, p, id => {
      if (id === p.son) return;
      p.son = id; afficheSon(); aChange();
    }));
    // curseurs : l'affichage suit le geste, le mixage est mis à jour quand on relâche
    const vol = tr.querySelector(`#vol${i}`), pan = tr.querySelector(`#pan${i}`);
    vol.addEventListener("input", () => { p.volume = +vol.value; vol.nextElementSibling.textContent = p.volume; });
    pan.addEventListener("input", () => { p.pan = +pan.value; pan.nextElementSibling.textContent = panTxt(p.pan); });
    vol.addEventListener("change", aChange); pan.addEventListener("change", aChange);
    tr.querySelector(".m").addEventListener("click", e => { p.muet = !p.muet; e.target.setAttribute("aria-pressed", p.muet); grise(); aChange(); });
    tr.querySelector(".s").addEventListener("click", e => { p.solo = !p.solo; e.target.setAttribute("aria-pressed", p.solo); grise(); aChange(); });
  });
  grise();
}
function grise() {
  const solo = PISTES.some(p => p.solo);
  [...$("#pistes").rows].forEach((r, i) => { const p = PISTES[i]; if (p) r.classList.toggle("muted", p.muet || (solo && !p.solo)); });
}

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
