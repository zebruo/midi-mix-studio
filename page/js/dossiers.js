// Mixeur MIDI — panneau « Dossiers de morceaux » : les dossiers où chercher les .mid (« racines » de config.json).
// Ajouter ouvre la fenêtre Windows de choix de dossier (côté serveur) ; retirer ne touche à aucun fichier.
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

(() => {
  const bouton = $("#dossiers"), fen = document.createElement("div"), liste = document.createElement("div");
  const titre = document.createElement("div"), ajouter = document.createElement("button");
  fen.className = "dossiers"; fen.hidden = true;
  titre.className = "dossiers-titre"; titre.textContent = "Dossiers de morceaux";
  ajouter.type = "button"; ajouter.className = "dossiers-ajouter"; ajouter.textContent = "+ Ajouter un dossier…";
  fen.append(titre, liste, ajouter); document.body.append(fen);
  const morceaux = n => n === 0 ? "aucun morceau pour l'instant" : n === 1 ? "1 morceau" : `${n} morceaux`;

  async function dessine() {
    const dossiers = await api("/api/dossiers");
    liste.replaceChildren(...dossiers.map(d => {
      const ligne = document.createElement("div"), nom = document.createElement("span");
      ligne.className = "dossiers-ligne";
      nom.className = "dossiers-nom"; nom.textContent = d.affiche; nom.title = d.chemin;
      ligne.append(nom);
      if (dossiers.length > 1) {                   // il reste toujours au moins un dossier
        const x = document.createElement("button");
        x.type = "button"; x.className = "dossiers-retirer"; x.textContent = "×";
        x.title = "Retirer de la liste (rien n'est supprimé)"; x.setAttribute("aria-label", `Retirer ${d.affiche} de la liste`);
        x.addEventListener("click", () => retire(d.chemin));
        ligne.append(x);
      }
      return ligne;
    }));
  }
  function place() {
    const r = bouton.getBoundingClientRect(), L = fen.offsetWidth;
    fen.style.left = Math.max(8, Math.min(r.right - L, innerWidth - L - 8)) + "px";
    fen.style.top = r.bottom + 4 + "px";
  }
  function ferme() { fen.hidden = true; bouton.setAttribute("aria-expanded", "false"); }
  async function retire(chemin) {
    try {
      const r = await api("/api/dossiers/retirer", {chemin});
      await dessine(); await listeFichiers();
      statut(`Dossier retiré de la liste : ${r.nom}.`, "ok");
    } catch (e) { statut(e.message, "err"); }
  }
  ajouter.addEventListener("click", async () => {
    ajouter.disabled = true;
    statut("Choisissez le dossier dans la fenêtre Windows…");
    try {
      const r = await api("/api/dossiers/ajouter", {});
      if (r.etat === "annule") statut("");
      else if (r.etat === "deja") statut("Ce dossier est déjà dans la liste.");
      else {
        await dessine(); await listeFichiers();
        statut(`Dossier ajouté : ${r.nom} (${morceaux(r.morceaux)}).`, "ok");
      }
    } catch (e) { statut(e.message, "err"); }
    ajouter.disabled = false;
  });
  bouton.addEventListener("click", async () => {
    if (!fen.hidden) return ferme();
    try {
      await dessine();
      fen.hidden = false; bouton.setAttribute("aria-expanded", "true"); place();
    } catch (e) { statut(e.message, "err"); }
  });
  document.addEventListener("pointerdown", e => { if (!fen.hidden && !fen.contains(e.target) && !bouton.contains(e.target)) ferme(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !fen.hidden) { ferme(); bouton.focus(); } });
  addEventListener("resize", () => { if (!fen.hidden) place(); });
})();
