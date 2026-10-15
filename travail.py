"""Mixeur MIDI — documents de travail.

Quand un morceau est chargé, le mixeur travaille sur une copie (cache\\travail\\<doc>\\v1.mid) : les onglets Mixage,
Montage et Événements voient et modifient ce même document. Chaque modification appliquée (un montage, des
corrections d'événements) crée une nouvelle version (v2.mid, v3.mid…), ce qui permet d'annuler et de rétablir.
Rien n'est écrit à côté du morceau avant « Enregistrer » :
- si seuls les réglages de mixage ont changé, ils vont dans le .mix.json du fichier ouvert ;
- si les notes ou la structure ont changé, le fichier ouvert est remplacé ; son ancienne version est d'abord
  gardée dans un dossier « sauvegardes » à côté de lui (les 20 dernières de chaque fichier, 60 jours au plus) ;
- « Enregistrer une copie » écrit une nouvelle copie au premier numéro libre (morceau_v2.mid, _v3…) ; les
  « Enregistrer » suivants mettent à jour cette copie.
"""
import filecmp
import hashlib
import json
import os
import re
import shutil
import time

DOSSIER_SAUVEGARDES = "sauvegardes"      # à côté de chaque morceau remplacé ; ignoré par la liste des morceaux


def nom_auto(chemin):
    """Premier nom libre : musique_2008.mid → musique_2008_v2.mid ; Garmisch_2008_v2.mid → Garmisch_2008_v3.mid."""
    dossier, f = os.path.split(chemin)
    tige = os.path.splitext(f)[0]
    m = re.fullmatch(r"(.*)_v(\d+)", tige)
    base, k = (m.group(1), int(m.group(2)) + 1) if m else (tige, 2)
    while os.path.exists(os.path.join(dossier, f"{base}_v{k}.mid")):
        k += 1
    return os.path.join(dossier, f"{base}_v{k}.mid")


class Travail:
    def __init__(self, dossier):
        self.dossier = dossier
        os.makedirs(dossier, exist_ok=True)

    def _meta(self, doc):
        return os.path.join(self.dossier, doc, "doc.json")

    def charge(self, doc):
        if not re.fullmatch(r"[0-9a-f]{12}", str(doc or "")) or not os.path.exists(self._meta(doc)):
            raise ValueError("Ce travail n'existe plus (cache vidé ?) : rechargez le morceau.")
        return json.load(open(self._meta(doc), encoding="utf-8"))

    def sauve(self, d):
        with open(self._meta(d["id"]), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)

    def chemin(self, d, k=None):
        return os.path.join(self.dossier, d["id"], f"v{d['courante'] if k is None else k}.mid")

    def ouvre(self, original):
        doc = hashlib.sha1(f"{os.path.abspath(original)}|{time.time()}".encode()).hexdigest()[:12]
        os.makedirs(os.path.join(self.dossier, doc))
        d = {"id": doc, "original": original, "copie": None, "versions": [1], "courante": 1, "enregistree": 1}
        shutil.copy(original, self.chemin(d, 1))
        self.sauve(d)
        return d

    def nouvelle_version(self, d, midifile):
        """Le document modifié devient la version courante (les versions « rétablissables » sont abandonnées)."""
        k = max(d["versions"]) + 1
        d["versions"] = d["versions"][:d["versions"].index(d["courante"]) + 1] + [k]
        midifile.save(self.chemin(d, k))
        d["courante"] = k
        self.sauve(d)
        return d

    def va(self, d, k):
        if k not in d["versions"]:
            raise ValueError("Version inconnue.")
        d["courante"] = k
        self.sauve(d)
        return d

    def modifie(self, d):
        """Le contenu de la version courante diffère-t-il de ce qui a été enregistré (ou chargé) ?"""
        return not filecmp.cmp(self.chemin(d), self.chemin(d, d["enregistree"]), shallow=False)

    def enregistre(self, d, nouvelle, ecrit_reglages):
        """→ (fichier écrit, « reglages », « mid » ou « copie »). ecrit_reglages(chemin_du_mid) écrit le .mix.json.
        « mid » : le fichier ouvert (ou la copie faite pendant ce travail) est remplacé, après sauvegarde."""
        ouvert = d["copie"] or d["original"]
        if nouvelle:                                   # « Enregistrer une copie » : toujours un nouveau fichier
            cible = nom_auto(ouvert)
            shutil.copy(self.chemin(d), cible)
            ecrit_reglages(cible)
            d["copie"], d["enregistree"] = cible, d["courante"]
            self.sauve(d)
            return cible, "copie"
        if not self.modifie(d):                        # réglages seuls
            ecrit_reglages(ouvert)
            return ouvert, "reglages"
        self.sauvegarde(ouvert)                        # notes changées : le fichier ouvert est remplacé
        shutil.copy(self.chemin(d), ouvert)
        ecrit_reglages(ouvert)
        d["enregistree"] = d["courante"]
        self.sauve(d)
        return ouvert, "mid"

    def sauvegarde(self, fichier, garder=20, jours=60):
        """Copie de l'ancienne version d'un fichier avant de le remplacer, dans un dossier « sauvegardes » à côté
        de lui (là où l'utilisateur travaille) : <dossier>\\sauvegardes\\<nom>_<date>.mid. Pour ce fichier, les
        `garder` plus récentes sont conservées, et aucune de plus de `jours` jours. La liste des morceaux du
        mixeur ignore les dossiers « sauvegardes »."""
        if not os.path.exists(fichier):
            return None
        dossier = os.path.join(os.path.dirname(fichier), DOSSIER_SAUVEGARDES)
        os.makedirs(dossier, exist_ok=True)
        tige = os.path.splitext(os.path.basename(fichier))[0]
        cible = os.path.join(dossier, f"{tige}_{time.strftime('%Y-%m-%d_%H-%M-%S')}.mid")
        shutil.copy(fichier, cible)                    # (pas copy2 : la date doit être celle de la sauvegarde)
        motif = re.escape(tige) + r"_\d{4}(-\d\d){2}_\d\d(-\d\d){2}\.mid"
        anciennes = sorted(f for f in os.listdir(dossier) if re.fullmatch(motif, f))
        limite = time.time() - jours * 86400
        for i, f in enumerate(anciennes):
            p = os.path.join(dossier, f)
            if i < len(anciennes) - garder or (p != cible and os.path.getmtime(p) < limite):
                os.remove(p)
        return cible

    def menage(self, jours=7):
        """Les travaux de plus de `jours` jours sont effacés (au démarrage du mixeur)."""
        limite = time.time() - jours * 86400
        for doc in os.listdir(self.dossier):
            meta = self._meta(doc)
            if os.path.isdir(os.path.join(self.dossier, doc)) and (not os.path.exists(meta) or os.path.getmtime(meta) < limite):
                shutil.rmtree(os.path.join(self.dossier, doc), ignore_errors=True)
