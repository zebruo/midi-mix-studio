"""Mixeur MIDI — banc de montage : couper, copier, déplacer des mesures entières d'un fichier .mid.

Un montage est une liste de plages de mesures de l'original, dans l'ordre voulu :
    [{"a": 1, "b": 18}, {"a": 105, "b": 133}]   (mesures numérotées à partir de 1, bornes comprises)

assemble() produit le nouveau fichier MIDI avec des raccords propres :
- une note qui résonne au-delà de la fin d'une plage garde sa durée, au plus un temps ;
- une note humanisée qui attaque un peu avant le début d'une plage (1/8 de temps au plus) en fait partie
  et est recalée sur la barre de mesure ; celle qui attaque un peu avant la fin appartient à la suite et est écartée ;
- au début de chaque plage, instruments, contrôleurs, tempo, chiffrage et tonalité de l'original sont rétablis,
  la pédale de sustain est relâchée au raccord ;
- une note qui est encore en train de sonner quand la même note est rejouée sur le même canal est arrêtée.

Une mesure peut être retouchée (notes déplacées, ajoutées, supprimées, nuances…) : elle porte alors
sa propre liste de notes, sans toucher aux autres copies de la même mesure.

chaine_collage() sert à l'écoute rapide : chaque piste déjà rendue de l'original est recollée selon les
plages (fondu de 20 ms à l'entrée, résonance de 0,35 s à la sortie), puis le mixeur mixe le tout ; seules
les pistes dont des notes ont été retouchées sont rendues à nouveau, à partir du montage assemblé.
"""
import mido


def _absolus(piste):
    t = 0
    for m in piste:
        t += m.time
        yield t, m


def _tous(mid):
    for piste in mid.tracks:
        yield from _absolus(piste)


def notes(mid):
    """Toutes les notes du fichier, piste après piste : (début, fin, note_on, note_off), en ticks."""
    for piste in mid.tracks:
        yield from _notes(list(_absolus(piste)))[0]


def bornes_mesures(mid):
    """Ticks des barres de mesure : début de la mesure 1, 2, … et fin de la dernière (n + 1 valeurs)."""
    tpb = mid.ticks_per_beat
    chiffrages = sorted((t, m.numerator, m.denominator) for t, m in _tous(mid) if m.type == "time_signature")
    fin = max(sum(m.time for m in piste) for piste in mid.tracks)
    bornes, num, den, i = [0], 4, 4, 0
    while True:
        while i < len(chiffrages) and chiffrages[i][0] <= bornes[-1]:
            _, num, den = chiffrages[i]
            i += 1
        bornes.append(bornes[-1] + tpb * 4 * num // den)
        if bornes[-1] >= fin - tpb // 2:          # une fin de note qui déborde à peine ne crée pas de mesure vide
            return bornes


def secondes(mid, ticks):
    """Temps (s) de chaque tick de la liste, d'après les changements de tempo."""
    tempos = sorted((t, m.tempo) for t, m in _tous(mid) if m.type == "set_tempo")
    res = []
    for tick in ticks:
        sec, prec, tempo = 0.0, 0, 500000
        for t, tp in tempos:
            if t >= tick:
                break
            sec += (t - prec) / mid.ticks_per_beat * tempo / 1e6
            prec, tempo = t, tp
        res.append(sec + (tick - prec) / mid.ticks_per_beat * tempo / 1e6)
    return res


def programmes(mid):
    """Changements d'instrument par canal : {canal: [(tick, programme), …]} triés."""
    res = {}
    for t, m in _tous(mid):
        if m.type == "program_change":
            res.setdefault(m.channel, []).append((t, m.program))
    for v in res.values():
        v.sort(key=lambda x: x[0])
    return res


def programme_a(changements, t, avance):
    """Instrument d'une note qui attaque à t : celui en place à t + avance. Une note humanisée qui attaque
    un peu avant un changement d'instrument appartient donc au nouvel instrument."""
    p = 0
    for tt, prog in changements:
        if tt > t + avance:
            break
        p = prog
    return p


def instruments_par_canal(mid):
    """Canaux qui changent d'instrument en cours de morceau (batterie exclue) : {canal: [programmes réellement
    joués, dans l'ordre où ils apparaissent]}. Le mixeur en fait une ligne par instrument, rendue avec son
    instrument fixé dès le début : une note qui attaque un peu avant le changement ne sonne plus avec l'ancien."""
    chg, av, vus = programmes(mid), mid.ticks_per_beat // 8, {}
    for d, _, on, _ in notes(mid):
        if on.channel != 9:
            p = programme_a(chg.get(on.channel, []), d, av)
            vus.setdefault(on.channel, {}).setdefault(p, d)
            vus[on.channel][p] = min(vus[on.channel][p], d)
    return {c: sorted(v, key=v.get) for c, v in vus.items() if len(v) > 1 or len({p for _, p in chg.get(c, [])}) > 1}


def cle_ligne(canal, prog, partages):
    """Identifiant d'une ligne du mixeur : « 7 », ou « 7:71 » quand le canal 7 est partagé entre instruments."""
    return f"{canal}:{prog}" if canal in partages else str(canal)


def structure(mid):
    """Pour le banc de montage : temps de chaque barre de mesure et nombre de notes par mesure et par ligne."""
    bornes = bornes_mesures(mid)
    partages, chg, av = instruments_par_canal(mid), programmes(mid), mid.ticks_per_beat // 8
    activite, liste = {}, []                     # liste : pour le détail d'une mesure, [canal, note, vélocité, début, fin]
    for d, f, on, _ in notes(mid):
        cle = cle_ligne(on.channel, programme_a(chg.get(on.channel, []), d, av), partages)
        ligne = activite.setdefault(cle, [0] * (len(bornes) - 1))
        ligne[min(len(bornes) - 2, max(0, _mesure_de(bornes, d + av)))] += 1
        liste.append([on.channel, on.note, on.velocity, d, f])
    liste.sort(key=lambda x: x[3])
    return {"secondes": [round(s, 6) for s in secondes(mid, bornes)], "bornes": bornes, "tpb": mid.ticks_per_beat,
            "activite": activite, "notes": liste,
            "programmes": {str(c): v for c, v in chg.items() if c in partages}}


def _mesure_de(bornes, tick):
    lo, hi = 0, len(bornes) - 1
    while lo < hi:
        mi = (lo + hi + 1) // 2
        if bornes[mi] <= tick:
            lo = mi
        else:
            hi = mi - 1
    return lo


def normalise(segments, nb):
    """Plages valides, les plages qui se suivent dans l'original étant réunies.
    → [(a, b, notes)] ; notes = None (notes de l'original) ou, pour une mesure retouchée (a == b),
    la liste complète de ses notes [canal, note, vélocité, début, fin] en ticks depuis la barre de la mesure."""
    res = []
    for s in segments:
        a, b = max(1, int(s["a"])), min(nb, int(s["b"]))
        notes = s.get("notes")
        if notes is not None:
            b = a
            notes = [[int(c) & 15, max(0, min(127, int(n))), max(1, min(127, int(v))), int(d), int(f)] for c, n, v, d, f in notes]
        if a > b:
            continue
        if notes is None and res and res[-1][2] is None and res[-1][1] + 1 == a:
            res[-1] = (res[-1][0], b, None)
        else:
            res.append((a, b, notes))
    if not res:
        raise ValueError("Le montage est vide.")
    return res


def notes_de_mesure(mid, bornes=None):
    """Notes de l'original rangées par mesure (une attaque en avance de 1/8 de temps compte pour la mesure suivante) :
    {mesure: [[canal, note, vélocité, début, fin], …]} en ticks depuis la barre de la mesure (comme la page)."""
    bornes = bornes or bornes_mesures(mid)
    avance, res = mid.ticks_per_beat // 8, {}
    for d, f, on, _ in notes(mid):
        k = min(len(bornes) - 2, _mesure_de(bornes, d + avance)) + 1
        res.setdefault(k, []).append([on.channel, on.note, on.velocity, d - bornes[k - 1], f - bornes[k - 1]])
    return res


def canaux_modifies(mid, plages):
    """Canaux dont au moins une mesure retouchée a des notes différentes de l'original."""
    from collections import Counter
    orig, res = notes_de_mesure(mid), set()
    for a, _, notes in plages:
        if notes is None:
            continue
        avant, apres = Counter(map(tuple, orig.get(a, []))), Counter(map(tuple, notes))
        res |= {n[0] for n in (avant - apres) + (apres - avant)}
    return res


def _cle_etat(m):
    """Messages dont l'état doit être rétabli au début d'une plage."""
    if m.type in ("set_tempo", "time_signature", "key_signature"):
        return m.type
    if m.type == "program_change":
        return ("prog", m.channel)
    if m.type == "control_change":
        return ("cc", m.channel, m.control)
    if m.type == "pitchwheel":
        return ("pb", m.channel)
    return None


def _signature(m):
    return repr(m.copy(time=0))


def _notes(absolus):
    """Notes de la piste [(début, fin, note_on, note_off)] et autres événements [(t, message)]."""
    ouvertes, notes, autres = {}, [], []
    for t, m in absolus:
        if m.type == "note_on" and m.velocity > 0:
            ouvertes.setdefault((m.channel, m.note), []).append((t, m))
        elif m.type in ("note_off", "note_on"):
            pile = ouvertes.get((m.channel, m.note))
            if pile:
                d, on = pile.pop(0)
                notes.append((d, t, on, m))
        elif m.type != "end_of_track":
            autres.append((t, m))
    return notes, autres


def assemble(mid, segments):
    tpb = mid.ticks_per_beat
    bornes = bornes_mesures(mid)
    plages = normalise(segments, len(bornes) - 1)
    avance, resonance = tpb // 8, tpb
    sortie = mido.MidiFile(type=mid.type, ticks_per_beat=tpb)
    # piste qui porte chaque canal (pour y ranger les notes des mesures retouchées)
    porteur = {}
    for i, piste in enumerate(mid.tracks):
        for m in piste:
            if m.type == "note_on" and m.channel not in porteur:
                porteur[m.channel] = i
    for i, piste in enumerate(mid.tracks):
        notes, autres = _notes(list(_absolus(piste)))
        # ordre à un même tick : 0 fins de notes, 1 réglages, 2 débuts de notes
        ev = [(0, 1, m, None) for t, m in autres if t == 0 and m.is_meta and _cle_etat(m) is None]   # nom de piste…
        courant, pos, ident = {}, 0, 0
        for k, (a, b, remplace) in enumerate(plages):
            s, e = bornes[a - 1], bornes[b]
            derniere = b == len(bornes) - 1
            suite = derniere or (k + 1 < len(plages) and plages[k + 1][0] == b + 1)   # la mesure suivante de l'original suit
            dec = pos - s
            if k and plages[k - 1][1] + 1 != a:     # vrai raccord : on relâche la pédale (voir aussi « contigu » plus bas)
                for cle, m in list(courant.items()):
                    if cle[0] == "cc" and cle[2] == 64 and m.value >= 64:
                        courant[cle] = m.copy(value=0)
                        ev.append((pos, 1, courant[cle], None))
            etat = {}                               # état de l'original à la barre de début (événements à s compris)
            for t, m in autres:
                if t > s:
                    break
                cle = _cle_etat(m)
                if cle is not None:
                    etat[cle] = m
            for cle, m in etat.items():
                if cle not in courant or _signature(courant[cle]) != _signature(m):
                    ev.append((pos, 1, m, None))
                    courant[cle] = m
            for t, m in autres:
                if s <= t < e or (derniere and t >= e):
                    if t == 0 and m.is_meta and _cle_etat(m) is None:
                        continue
                    cle = _cle_etat(m)
                    if cle is not None:
                        if courant.get(cle) is m:
                            continue                # déjà rétabli au début de la plage
                        # un réglage identique à celui en place est inutile… sauf tempo, chiffrage et tonalité :
                        # répétés, ils marquent les parties du morceau (ex. une strophe de psaume toutes les 24 mesures)
                        if cle in courant and _signature(courant[cle]) == _signature(m) and not isinstance(cle, str):
                            continue
                        courant[cle] = m
                    ev.append((t + dec, 1, m, None))
            if remplace is None:
                choisies = [(d, f, on, off) for d, f, on, off in notes
                            if (s == 0 or d >= s - avance) and (derniere or d < e - avance)]
            else:                                   # mesure retouchée : ses propres notes
                choisies = [(s + d, s + f, mido.Message("note_on", channel=c, note=n, velocity=v),
                             mido.Message("note_off", channel=c, note=n, velocity=0))
                            for c, n, v, d, f in remplace if porteur.get(c, len(mid.tracks) - 1) == i]
            contigu = k > 0 and plages[k - 1][1] + 1 == a       # pas de vrai raccord avant : on garde l'attaque en avance
            for d, f, on, off in choisies:
                nd = d if contigu else max(d, s)
                nf = f if suite else min(f, e + resonance)
                nf = max(nf, nd + 1)
                ident += 1
                ev.append((nd + dec, 2, on, (k, ident)))
                ev.append((nf + dec, 0, off, (k, ident)))
            pos += e - s
        ev.sort(key=lambda x: (x[0], x[1]))
        tr, prec = mido.MidiTrack(), 0
        for t, _, m in _sans_chevauchement(ev):
            tr.append(m.copy(time=t - prec))
            prec = t
        tr.append(mido.MetaMessage("end_of_track", time=max(0, pos - prec)))
        sortie.tracks.append(tr)
    return sortie


def _sans_chevauchement(ev):
    """Si une note qui résonne au-delà d'un raccord est rejouée par la plage suivante sur le même canal,
    l'ancienne est arrêtée juste avant (sinon sa fin couperait la nouvelle). Les notes répétées en legato
    à l'intérieur d'une même plage ne sont pas touchées."""
    sonne, arretees, res = {}, set(), []
    for t, ordre, m, ident in ev:
        if ident is None:
            res.append((t, ordre, m))
            continue
        cle = (m.channel, m.note)
        if ordre == 2:
            for autre in [x for x in sonne.get(cle, []) if x[0] != ident[0]]:
                res.append((t, 0, mido.Message("note_off", channel=m.channel, note=m.note, velocity=0)))
                arretees.add(autre)
                sonne[cle].remove(autre)
            sonne.setdefault(cle, []).append(ident)
            res.append((t, ordre, m))
        else:
            if ident in arretees:
                continue
            if ident in sonne.get(cle, []):
                sonne[cle].remove(ident)
            res.append((t, ordre, m))
    return res


def chaine_collage(entree, plages_s, sortie, nom, fondu=0.02, resonance=0.35, queue=None):
    """Filtres ffmpeg qui recollent l'audio [entree] selon les plages [(début s, fin s)] de l'original → [sortie]
    (fondu de 20 ms à l'entrée d'une plage, résonance de 0,35 s à la sortie ; plages contiguës réunies ;
    queue : durée gardée après la dernière plage, ex. la résonance de fin du morceau)."""
    fusion = []
    for a, b in plages_s:
        if fusion and abs(fusion[-1][1] - a) < 1e-6:
            fusion[-1] = (fusion[-1][0], b)
        else:
            fusion.append((a, b))
    n, chaines, pos = len(fusion), [], 0.0
    for i, (a, b) in enumerate(fusion):
        pre = min(fondu, a) if pos > 0 else 0.0
        deb = a - pre
        apres = queue if (queue is not None and i + 1 == n) else resonance
        c = f"[{nom}s{i}]atrim=start={deb:.4f}:end={b + apres:.4f},asetpts=PTS-STARTPTS"
        if pre > 0:
            c += f",afade=t=in:st=0:d={pre:.4f}"
        if i + 1 < n:
            c += f",afade=t=out:st={b - deb:.4f}:d={resonance:.4f}"
        c += f",adelay={round((pos - pre) * 1000)}:all=1[{nom}p{i}]"
        chaines.append(c)
        pos += b - a
    return ([f"{entree}asplit={n}" + "".join(f"[{nom}s{i}]" for i in range(n))] + chaines
            + ["".join(f"[{nom}p{i}]" for i in range(n)) + f"amix=inputs={n}:normalize=0:duration=longest{sortie}"])
