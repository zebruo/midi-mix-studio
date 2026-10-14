# Mixeur MIDI

Console de mixage **locale** pour fichiers `.mid` : on choisit le son de chaque piste parmi deux moteurs, on règle le mixage en écoutant, on remonte les mesures, on corrige les notes, puis on exporte en MP3 ou WAV.

- **FluidSynth + GeneralUser GS** : rendu « intimiste », sons General MIDI (piano, guitares, batteries…)
- **sfizz + Salamander Grand Piano + Virtual Playing Orchestra** : rendu « lyrique », vrai piano et orchestre

L'application tourne sur le PC (`http://localhost:8765`, accessible seulement depuis cette machine) et s'utilise dans le navigateur. Rien n'est envoyé sur Internet, et le serveur n'obéit qu'à sa propre console : les requêtes venant d'un autre site ouvert dans le navigateur sont refusées.

## Fonctions

**Mixage**
- Par piste : son (recherche dans les deux moteurs, en français ou en anglais), volume, panoramique, muet / solo, vumètre
- Écho de salle, volume général en LUFS, fondu de fin
- Mixage mis à jour pendant l'écoute ; chaque piste rendue est gardée en cache
- Export MP3 / WAV normalisé, à côté du morceau

**Montage**
- Mesures entières : couper, copier, coller, dupliquer, déplacer, avec des raccords propres
- Piano-roll des mesures sélectionnées : déplacer, allonger, ajouter, supprimer, transposer des notes
- Boucle sur les mesures sélectionnées, détail qui suit la lecture

**Événements**
- Tous les événements MIDI en tableau filtrable et modifiable, ou en texte commenté
- Actions groupées : vélocité, transposition, décalage, durée, notes liées, calage sur le temps

**Document de travail**
- Les trois onglets travaillent sur le même document, avec Annuler / Rétablir et des versions
- L'original n'est jamais remplacé : les notes modifiées sont enregistrées dans une copie `_v2`, `_v3`… ; les réglages seuls dans un `.mix.json`

## Installation (Windows)

1. **Python 3.12** ou plus récent, puis la bibliothèque MIDI et le calcul des vumètres :
   ```
   pip install mido numpy
   ```
2. **Moteurs et outils** :
   - [FluidSynth](https://www.fluidsynth.org) (`fluidsynth.exe`)
   - [sfizz](https://sfz.tools/sfizz/) (`sfizz_render.exe`)
   - [ffmpeg](https://ffmpeg.org) (dans le PATH, ou chemin complet dans la configuration)
3. **Banques de sons** :
   - [GeneralUser GS](https://www.schristiancollins.com/generaluser.php) (`GeneralUser-GS.sf2`)
   - un dossier de banques SFZ contenant [Salamander Grand Piano](https://github.com/sfzinstruments/SalamanderGrandPiano) (`SalamanderGrandPiano-master`) et [Virtual Playing Orchestra 3](http://virtualplaying.com/virtual-playing-orchestra/) (`VPO/Virtual-Playing-Orchestra3`)
4. **Configuration** : copier `config.exemple.json` en `config.json`, puis y indiquer :
   - `racines` : les dossiers où chercher les morceaux `.mid`
   - `fluidsynth`, `generaluser`, `sfizz_render`, `dossier_sfz`, `ffmpeg` : les chemins des outils et des banques

   `config.json` est propre à chaque PC et n'est pas versionné.

## Lancement

```
pythonw -I mixeur.py
```

La console s'ouvre dans le navigateur. Pour un raccourci sur le bureau, viser `pythonw.exe` avec les arguments `-I "<dossier>\mixeur.py"` et l'icône `page\favicon.ico`.

**Pour arrêter**, fermer l'onglet : le mixeur s'arrête tout seul une dizaine de secondes après la fermeture du dernier onglet.

## Outil en ligne de commande

`midi_texte.py` s'utilise aussi seul pour lire et modifier un `.mid` dans un éditeur de texte :

```
python midi_texte.py morceau.mid          → morceau.mid.txt
python midi_texte.py morceau.mid.txt      → morceau_texte.mid
```

L'aller-retour est exact, et aucun fichier n'est jamais écrasé.

## Fichiers

| Fichier | Rôle |
|---|---|
| `mixeur.py` | serveur, rendu des pistes, mixage, export |
| `montage.py` | découpe en mesures, assemblage du montage, raccords |
| `travail.py` | documents de travail : versions, enregistrement, noms automatiques |
| `midi_texte.py` | conversion `.mid` ⇄ texte commenté |
| `page/` | la console (HTML, CSS, JavaScript, icônes) |
| `config.exemple.json` | modèle de `config.json` |
| `VERSION.txt` | numéro de version de l'application |
| `LISEZMOI.txt` | mode d'emploi détaillé, onglet par onglet |
| `cache/` | pistes rendues et travaux en cours (créé au lancement, plafonné à 2 Go, non versionné) |

## Versions

Numérotation `MAJEUR.MINEUR.CORRECTIF` dans `VERSION.txt`, affichée en haut de la console. Chaque version est marquée par une étiquette Git (`v1.0.0`, `v1.1.0`…). Si le mixeur qui tourne a été lancé avant une mise à jour, la console demande de le relancer.

## À venir

Automation du volume, pré-écoute d'un son, transposition et tempo, remplacement de la musique d'un film ; plus tard, une version `.exe` portable.
