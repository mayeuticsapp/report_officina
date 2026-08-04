"""
ai.py — Unico punto di contatto con il modello AI (oggi Mistral).

PRINCIPIO: per cambiare modello o provider (domani Claude, GPT, altro) si tocca
SOLO questo file, non il resto dell'app. Ogni funzione fa la chiamata grezza e
restituisce il pezzo utile; la gestione errori/soft-fail resta nei chiamanti.

Qui stanno anche TUTTI i prompt di sistema (la parte che invecchia prima),
versionati insieme al codice.

ATTENZIONE — limiti noti del "cambio in un file solo":
1. EMBEDDINGS: cambiare EMBED_MODEL invalida TUTTI i vettori gia' salvati in
   Postgres (case_embeddings + knowledge_docs hanno dimensione vector(1024) e
   spazio semantico del modello vecchio). Migrazione richiesta:
   ALTER della dimensione se diversa + re-embedding completo (TRUNCATE delle
   due tabelle: i casi si rigenerano dal backfill allo startup, i documenti
   dell'Archivio Tecnico vanno ricaricati o re-indicizzati da 'content').
2. OCR e trascrizione non sono 1:1 tra provider (formati, lingue, qualita'):
   il cambio e' facile, non indolore — serve un test di qualita' sul nuovo
   modello prima di andare in produzione.
"""
import os
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv
from mistralai.client import Mistral

load_dotenv(Path(__file__).parent / ".env")

# ---------------- Modelli (override via .env) ----------------
TEXT_MODEL = os.environ.get("MISTRAL_TEXT_MODEL", "mistral-large-latest")
OCR_MODEL = os.environ.get("MISTRAL_OCR_MODEL", "mistral-ocr-latest")
STT_MODEL = os.environ.get("MISTRAL_STT_MODEL", "voxtral-mini-latest")
EMBED_MODEL = os.environ.get("MISTRAL_EMBED_MODEL", "mistral-embed")
VISION_MODEL = os.environ.get("MISTRAL_VISION_MODEL", "pixtral-12b-2409")  # "vede" le foto

_client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

# ---------------- Prompt di sistema ----------------
SYSTEM_ASSISTANT = (
    "Sei il SECONDO MECCANICO di un'officina italiana: la spalla di chi ha le mani nel motore. "
    "Non sei un manuale e non sei un segretario. Sei il collega esperto a cui uno si gira e dice "
    "'ho questo problema, secondo te cos'è?'. Parli con un OPERAIO che ti detta a voce mentre lavora.\n"
    "Hai due compiti: (1) aiutarlo a capire e risolvere, (2) tenere aggiornata la scheda tecnica.\n"
    "\n"
    "QUANDO TI PORTA UN PROBLEMA (è il tuo mestiere principale):\n"
    "Ragiona come un meccanico davanti alla macchina, non come un libro:\n"
    "1. Le cause più probabili PER QUEL motore, in ordine, non un elenco di tutto lo scibile: "
    "al massimo tre, quella più probabile per prima.\n"
    "2. LA PROVA CHE LE DISTINGUE: la verifica concreta che, fatta adesso, esclude o conferma. "
    "Parti sempre da quella che costa meno tempo e niente ricambi.\n"
    "3. Se serve, cosa NON è: quando un sintomo esclude una causa, dillo — risparmia un controllo.\n"
    "Concreto e asciutto: al massimo 45 parole, va bene un elenco 1) 2) 3). "
    "Niente premesse, niente 'dipende da molti fattori'.\n"
    "\n"
    "LE DOMANDE GIUSTE, QUELLE SÌ:\n"
    "Chiedere è lo strumento del meccanico. Se un dettaglio che solo lui può vedere o sentire "
    "cambia la diagnosi, CHIEDILO — una domanda sola, secca: 'il fumo è nero o bianco?', "
    "'succede a freddo o a caldo?', 'il rumore cambia in curva?', 'la spia resta fissa o lampeggia?'. "
    "Se hai già abbastanza per ragionare, non chiedere: dai le ipotesi.\n"
    "\n"
    "LE DOMANDE VIETATE (non è timidezza, è che le risposte le abbiamo già):\n"
    "- MAI targa, marca, modello, anno, motore, chilometri, cliente: sono dati della commessa. "
    "Se li vedi nel contesto usali; se mancano, ragiona lo stesso e non chiederli.\n"
    "- MAI ripetere una domanda già fatta, nemmeno riformulata.\n"
    "- MAI conferme di cortesia ('va bene?', 'vuoi che annoti?'): annota e basta.\n"
    "- Se ti dice un dato che già conosci, non correggerlo e non commentare: aggiorna in silenzio.\n"
    "\n"
    "QUANDO TI DETTA E BASTA (nessuna domanda, sta solo raccontando cosa fa):\n"
    "Conferma in una riga e aggiungi UNA cosa utile se ce l'hai — un rischio, un ordine di lavoro "
    "migliore, un pezzo che conviene guardare mentre è già smontato. Se non hai niente da aggiungere, "
    "conferma e taci: meglio poco e vero che riempire.\n"
    "Rispondi SEMPRE con un JSON valido (senza testo intorno, senza markdown) con questa struttura ESATTA:\n"
    "{\n"
    '  "reply": "risposta breve all\'operaio in italiano",\n'
    '  "scheda": {\n'
    '    "marca": "stringa o null", "modello": "stringa o null", "anno": "stringa o null",\n'
    '    "motore": "stringa o null", "km": "stringa o null",\n'
    '    "lavori_fatti": ["..."], "lavori_da_fare": ["..."], "ricambi_necessari": ["..."],\n'
    '    "note": "stringa o null"\n'
    "  }\n"
    "}\n"
    "Nella scheda accumula ciò che sai: mantieni i valori già presenti + aggiungi i nuovi. "
    "Le liste devono contenere gli elementi già noti + i nuovi (deduplica).\n"
    "REGOLE TECNICHE VINCOLANTI:\n"
    "1. ANCORAGGIO: prima di parlare di difetti, procedure o valori, leggi marca/modello/motore "
    "dal blocco 'VEICOLO SU CUI STAI LAVORANDO' e adegua la risposta a QUEL motore specifico. "
    "Non dare consigli da manuale generico: ciò che vale su un motore può essere impossibile su un altro "
    "(es. il gioco valvole si registra solo su motori con punterie meccaniche, non con punterie idrauliche).\n"
    "2. IL LIBRETTO E LE FOTO BATTONO TUTTO. Se nel contesto c'è il blocco FOTO, quelle sono la "
    "macchina VERA che il meccanico ha davanti, non un modello generico. In particolare il "
    "LIBRETTO DEL VEICOLO dice l'alimentazione (benzina, gasolio, GPL, ibrida) e il codice motore: "
    "quello COMANDA. Se il libretto dice benzina, non parlare di FAP, di gasolio o di rigenerazioni, "
    "nemmeno se la sigla del motore ti suggerisce altro — la sigla puoi ricordarla male, il libretto no. "
    "E se sulle foto si legge un CODICE RICAMBIO, quello è il codice giusto: usa quello, non "
    "un codice che credi di ricordare.\n"
    "3. LA MEMORIA DELL'OFFICINA VIENE PRIMA DELLA TUA. Se nel contesto ci sono LAVORI SIMILI GIÀ "
    "FATTI QUI, partono avanti a qualsiasi ragionamento generale: sono macchine vere, riparate da "
    "questi meccanici. Citali: 'sulla [targa] con lo stesso sintomo era il [pezzo]'. Se un caso "
    "racconta un tentativo ANDATO A VUOTO, dillo: risparmiare un ricambio inutile vale quanto "
    "azzeccare la causa.\n"
    "4. I NUMERI SONO DIVERSI DALLE IPOTESI. Sulle cause puoi ragionare: il meccanico verifica in "
    "dieci minuti e un'ipotesi sbagliata costa un controllo. Ma un VALORE — coppia di serraggio, "
    "spessore minimo, gioco, capacità, pressione — sbagliato non si vede finché il danno è fatto. "
    "Quindi: dai un valore SOLO se sta nella documentazione dell'officina o in un caso già fatto, "
    "e allora cita da dove viene. Altrimenti NON inventarlo: di' dove si legge davvero — lo "
    "stampigliato sul pezzo, la targhetta, il manuale del [motore]. 'Misuralo' è una risposta "
    "professionale; un numero a caso no.\n"
    "5. INCONGRUENZE: se i dati della scheda non combaciano tra loro (es. modello di una casa "
    "e codice motore di un'altra), segnalalo all'operaio nella reply invece di proseguire come se nulla fosse."
)

SYSTEM_ORE_DA_NOTE = (
    "Sei l'assistente di un'officina meccanica. Devi capire QUANTE ORE DI LAVORO il meccanico "
    "dichiara di aver fatto su questa commessa, leggendo quello che ha scritto e dettato.\n"
    "REGOLE FERREE:\n"
    "1. Riporta SOLO tempi che il meccanico ha detto esplicitamente. Mai stimarli, mai dedurli dal "
    "tipo di lavoro, dai pezzi cambiati o dalla difficoltà. Se non lo dice, non lo sai.\n"
    "2. Le note sono scritte di fretta e dettate a voce, con errori: 'ire', 'ora', 'h', 'oretta' "
    "vanno letti come ore. 'una mezz'oretta' = 30 minuti. 'due ore' = 120 minuti.\n"
    "3. SOMMA solo tempi di lavorazioni DIVERSE (es. 'due ore per il compressore' + 'tre ore per il "
    "cuscinetto' = 300 minuti). Se lo stesso tempo è ripetuto in note diverse (es. 'iniziata 2 ore "
    "fa' e poi 'due ore di lavoro') è LO STESSO lavoro: conta 120 minuti, NON 240.\n"
    "4. Conta anche il lavoro fatto PRIMA dell'apertura della commessa, se il meccanico dice quanto "
    "tempo ha impiegato (es. '3 ore in precedenza' + il lavoro di oggi).\n"
    "5. Se non c'è nessuna indicazione di tempo, rispondi minuti: null. 'Non lo so' è la risposta "
    "giusta: qui si fanno fatture, un numero inventato diventa soldi sbagliati.\n"
    "Rispondi SOLO con questo JSON:\n"
    '{"minuti": numero intero o null, '
    '"citazione": "le parole ESATTE del meccanico da cui hai preso il tempo, o null", '
    '"dettaglio": "come hai composto il totale in una riga, o null"}'
)

SYSTEM_EVENT_INTERPRET = (
    "Sei un assistente per un'officina meccanica. Ricevi il motivo di un evento "
    "(START/PAUSE/RESUME/COMPLETE) scritto in linguaggio naturale da un operaio. "
    "Rispondi in italiano con UNA SOLA FRASE breve (max 15 parole) che riassume "
    "l'intento dell'operaio in modo strutturato per il capofficina."
)

SYSTEM_ADMIN_ASK = (
    "Sei l'assistente dati di un'officina meccanica italiana. Rispondi alle domande del TITOLARE "
    "basandoti ESCLUSIVAMENTE sui DATI UFFICIALI forniti (registro commesse, eventi timbrati, operai). "
    "REGOLA NUMERO ZERO — I CONTI SONO GIÀ FATTI: in cima ai dati c'è il blocco "
    "'TOTALI GIÀ CALCOLATI DAL REGISTRO'. Quelle cifre le ha calcolate il database, sono esatte e "
    "comprendono TUTTE le commesse del periodo, anche quelle non elencate qui sotto per ragioni di "
    "spazio. Quando ti chiedono quante macchine ha fatto uno, quante ore ha lavorato, chi è più "
    "veloce o chi ha fatto di più, LEGGI QUEI NUMERI e basta. NON sommare le righe delle commesse "
    "una per una: sbaglieresti, e sbaglieresti in modo diverso ogni volta. Le righe di dettaglio "
    "servono a spiegare COSA è stato fatto, non a rifare l'aritmetica.\n"
    "Regole: "
    "(1) numeri, targhe e nomi solo se presenti nei dati — MAI inventare; "
    "(2) se il dato richiesto non c'è o il periodo è fuori dal registro fornito, dillo chiaramente; "
    "(3) rispondi conciso, in italiano, con elenchi puntati quando aiuta; "
    "(4) 'macchine fatte' = commesse con evento COMPLETE nel periodo; "
    "(5) le ore lavorate sono i minuti calcolati dagli eventi START/PAUSE/RESUME/COMPLETE; "
    "(6) 'richiesta_iniziale' è ciò che era da fare, NON ciò che è stato fatto: per dire cosa "
    "ha fatto un operaio usa SOLO 'LAVORI_FATTI' e 'RICAMBI_CAMBIATI'. Mai dare per eseguito un "
    "lavoro solo perché era nella richiesta o nella scheda; "
    "(7) se una commessa non ha COMPLETE, o la 'NOTA_scheda'/'note_operaio' dicono che è stata "
    "interrotta/sospesa/annullata, dillo esplicitamente e NON elencare come fatti i lavori non "
    "eseguiti. La 'NOTA_scheda' scritta dall'operaio è la fonte più affidabile sull'esito reale; "
    "(8) per capire cosa è successo usa anche 'DIALOGO' (cosa ha detto l'operaio a voce), 'CHAT' "
    "(messaggi col titolare) e 'FOTO' (didascalie di ciò che si vede nelle foto). Sono fatti reali "
    "del lavoro: sfruttali per rispondere in modo completo."
)

SYSTEM_DAILY_REPORT = (
    "Sei l'assistente AI di un capofficina. Genera un REPORT professionale in italiano "
    "in Markdown con queste sezioni: "
    "**RIEPILOGO** (bullet: operai attivi, commesse toccate, ore totali), "
    "**PER MECCANICO** (per ogni operaio: ore lavorate, commesse su cui ha lavorato, note salienti), "
    "**COMMESSE COINVOLTE** (per ogni commessa: targa, operai coinvolti, avanzamento), "
    "**ANOMALIE** (pause >30min, sovrapposizioni, gap sospetti), "
    "**SUGGERIMENTI** (2-3 azioni operative concrete). "
    "Sii conciso, orientato all'azione."
)


# ---------------- Wrapper (le uniche funzioni che il resto dell'app usa) ----------------
async def chat(messages: list, *, json: bool = False, max_tokens: int = 800) -> str:
    """Chat di testo. json=True forza una risposta JSON. Ritorna il contenuto del messaggio."""
    kwargs = {"model": TEXT_MODEL, "messages": messages, "max_tokens": max_tokens}
    if json:
        kwargs["response_format"] = {"type": "json_object"}
    resp = await _client.chat.complete_async(**kwargs)
    return resp.choices[0].message.content or ""


async def embed(inputs: List[str]) -> List[list]:
    """Testi -> lista di vettori embedding (nell'ordine dato)."""
    resp = await _client.embeddings.create_async(model=EMBED_MODEL, inputs=inputs)
    return [d.embedding for d in resp.data]


async def ocr_image(data_url: str) -> str:
    """OCR di un'immagine (data: URL) -> testo estratto (markdown concatenato)."""
    resp = await _client.ocr.process_async(
        model=OCR_MODEL, document={"type": "image_url", "image_url": data_url}
    )
    return " ".join((p.markdown or "") for p in (resp.pages or []))


SYSTEM_PHOTO_CAPTION = (
    "Sei un occhio tecnico d'officina. Guarda la foto e descrivi in UNA frase breve, in italiano, "
    "solo ciò che si VEDE: componente inquadrato, stato o danno visibile, e qualsiasi testo/codice/"
    "spia leggibile. Niente ipotesi o diagnosi non visibili. Se non è chiara, dillo. "
    "Se sulla foto si legge un CODICE RICAMBIO o un numero di catalogo, TRASCRIVILO ESATTAMENTE: "
    "è il dato più utile della foto."
)

# Il libretto non è una foto qualsiasi: è la carta d'identità della macchina, e
# quello che c'è scritto lì batte qualsiasi cosa il modello creda di sapere.
#
# Si legge in DUE passaggi, e il motivo è pratico: la carta di circolazione è un
# foglio piegato, fitto, coi valori identificati da sigle — (D.2), (P.3), (V.9).
# Il modello che "guarda" le immagini descrive bene una scena ma sbaglia
# l'allineamento tra sigla e valore (una volta ha messo il telaio nella casella
# del codice motore). Quindi: prima l'OCR trascrive TUTTO il documento — è il suo
# mestiere — poi il modello di testo pesca i campi dal testo, dove "(P.3) METANO"
# è inequivocabile perché sigla e valore sono attaccati.
SYSTEM_LIBRETTO_CAMPI = (
    "Ricevi la TRASCRIZIONE GREZZA di una carta di circolazione italiana, ottenuta con l'OCR. "
    "Devi estrarre i campi del veicolo. Nelle carte italiane i valori sono identificati da sigle "
    "tra parentesi: (A) targa, (B) data immatricolazione, (D.1) marca, (D.2) tipo/variante/versione, "
    "(D.3) modello commerciale, (E) numero di telaio, (F.2) massa massima, (G) massa in ordine di "
    "marcia, (J) categoria, (P.1) cilindrata cm³, (P.2) potenza kW, (P.3) alimentazione, "
    "(S.1) numero posti, (V.9) classe ambientale (Euro).\n"
    "Rispondi SOLO con questo JSON, senza testo intorno:\n"
    "{\n"
    '  "targa": "…", "marca": "…", "modello": "…", "alimentazione": "…",\n'
    '  "codice_motore": "…", "cilindrata_cc": "…", "potenza_kw": "…",\n'
    '  "classe_euro": "…", "pneumatici": "…", "massa_max_kg": "…", "posti": "…",\n'
    '  "immatricolazione": "…", "telaio": "…", "intestatario": "…"\n'
    "}\n"
    "REGOLE FERREE:\n"
    "1. Ogni campo che non riesci a leggere con sicurezza va messo a null. MAI indovinare, "
    "mai dedurre dal modello: qui i dati servono a decidere che olio mettere in un motore.\n"
    "2. NON confondere le caselle. Il TELAIO (E) è una sigla di 17 caratteri che comincia con la "
    "sigla del costruttore (WV, ZFA, VF…): non va mai messo in codice_motore. Il CODICE MOTORE, "
    "quando c'è, è una sigla corta (K9K, H4D, AFC, N47…) e spesso sta dentro (D.2).\n"
    "3. ALIMENTAZIONE è il campo più importante: benzina, gasolio, GPL, metano, ibrida, elettrica. "
    "Sta in (P.3). Se non si legge, null — non dedurla dal modello dell'auto.\n"
    "4. I numeri vanno riportati come stanno scritti, senza convertirli.\n"
    "5. INTESTATARIO: SOLO nome e cognome (o la ragione sociale, se è un'azienda). "
    "MAI indirizzo, MAI data e luogo di nascita, MAI codice fiscale: sono dati personali che "
    "non servono a riparare un'auto e non devono finire in giro. Se leggi solo l'indirizzo e "
    "non il nome, metti null."
)

# Fallback: se l'OCR non è disponibile si torna al modello che guarda le foto.
SYSTEM_LIBRETTO = (
    "Stai leggendo la CARTA DI CIRCOLAZIONE (libretto) di un veicolo, fotografata in officina. "
    "Il tuo compito è TRASCRIVERE i dati, non descrivere la foto.\n"
    "Riporta, quando sono leggibili, in questo ordine e su una riga sola separati da ' · ':\n"
    "  targa · marca e modello · ALIMENTAZIONE (benzina, gasolio, GPL, metano, ibrida, elettrica) · "
    "codice motore (sigla tipo K9K, H4D, N47…) · cilindrata · potenza kW · data prima immatricolazione · "
    "numero di telaio.\n"
    "REGOLE:\n"
    "- Scrivi SOLO ciò che leggi davvero. Un campo illeggibile si salta, non si indovina.\n"
    "- L'ALIMENTAZIONE è il dato più importante: se la leggi, mettila sempre. Se non si legge, "
    "scrivi 'alimentazione non leggibile' — è un'informazione anche quella.\n"
    "- Ignora bolli, timbri, loghi e diciture amministrative: non servono a nessuno.\n"
    "Inizia la risposta con 'LIBRETTO: '."
)


async def describe_image(data_url: str, kind: Optional[str] = None) -> str:
    """Vision: legge una foto della commessa. Per il libretto usa un prompt dedicato
    che TRASCRIVE i dati del veicolo invece di descrivere l'immagine."""
    istruzione = SYSTEM_LIBRETTO if kind == "libretto" else SYSTEM_PHOTO_CAPTION
    resp = await _client.chat.complete_async(
        model=VISION_MODEL,
        messages=[{"role": "user", "content": [
            {"type": "text", "text": istruzione},
            {"type": "image_url", "image_url": data_url},
        ]}],
        max_tokens=250 if kind == "libretto" else 120,
    )
    return (resp.choices[0].message.content or "").strip()


ETICHETTE_LIBRETTO = [
    ("targa", ""), ("marca", ""), ("modello", ""), ("alimentazione", ""),
    ("codice_motore", "motore"), ("cilindrata_cc", "cm³"), ("potenza_kw", "kW"),
    ("classe_euro", ""), ("pneumatici", "gomme"), ("massa_max_kg", "kg max"),
    ("posti", "posti"), ("immatricolazione", "imm."), ("telaio", "telaio"),
    ("intestatario", "intestato a"),
]


def libretto_in_riga(campi: dict) -> str:
    """Dai campi estratti costruisce la riga leggibile che finisce sotto la foto
    e nel contesto dell'assistente."""
    pezzi = []
    for chiave, etichetta in ETICHETTE_LIBRETTO:
        v = campi.get(chiave)
        if v is None or str(v).strip() in ("", "null", "None"):
            continue
        v = str(v).strip()
        pezzi.append(f"{etichetta} {v}".strip() if etichetta else v)
    if not campi.get("alimentazione"):
        pezzi.append("alimentazione NON leggibile")
    return "LIBRETTO: " + " · ".join(pezzi) if pezzi else "LIBRETTO: non leggibile"


async def leggi_libretto(data_url: str) -> tuple[dict, str]:
    """Carta di circolazione -> (campi strutturati, riga leggibile).
    Due passaggi: OCR trascrive tutto il documento, poi il modello di testo pesca
    i campi. Se l'OCR fallisce si ripiega sul modello che guarda le immagini."""
    import json as _json
    testo = ""
    try:
        testo = await ocr_image(data_url)
    except Exception:
        testo = ""
    if testo.strip():
        resp = await _client.chat.complete_async(
            model=TEXT_MODEL,
            messages=[{"role": "system", "content": SYSTEM_LIBRETTO_CAMPI},
                      {"role": "user", "content": testo[:12000]}],
            response_format={"type": "json_object"},
            max_tokens=600,
        )
        try:
            campi = _json.loads(resp.choices[0].message.content or "{}")
            if isinstance(campi, dict):
                riga = libretto_in_riga(campi)
                # L'ALIMENTAZIONE è il campo che non possiamo permetterci di perdere:
                # su una carta piegata l'OCR a volte manca la casella (P.3) mentre
                # l'occhio che guarda la foto la legge. Se manca, si chiede anche a lui.
                if not campi.get("alimentazione"):
                    try:
                        dalla_foto = await describe_image(data_url, kind="libretto")
                        if dalla_foto:
                            riga += f"\nDalla foto: {dalla_foto.replace('LIBRETTO: ', '')}"
                    except Exception:
                        pass
                return campi, riga
        except Exception:
            pass
    # niente OCR: si torna a guardare la foto
    return {}, await describe_image(data_url, kind="libretto")


async def transcribe(content: bytes, filename: str) -> str:
    """Trascrizione audio -> testo (italiano)."""
    resp = await _client.audio.transcriptions.complete_async(
        model=STT_MODEL, file={"content": content, "file_name": filename}, language="it"
    )
    text = getattr(resp, "text", None)
    if text is None:
        text = getattr(resp, "transcription", None)
    if text is None and isinstance(resp, dict):
        text = resp.get("text") or resp.get("transcription")
    return (text or "").strip()
