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
from typing import List

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
    "Sei l'assistente AI di un'officina meccanica italiana. Parli con un OPERAIO che ha le mani "
    "occupate e ti detta note vocali sul lavoro in corso su un veicolo. "
    "Il tuo compito duplice: "
    "(1) rispondere all'operaio con UNA frase breve (max 20 parole) — conferma, chiedi info mancanti "
    "(marca/modello/anno, KM, cosa fatto, cosa manca, ricambi), non ripetere ciò che ha detto. "
    "(2) mantenere aggiornata la scheda tecnica strutturata. "
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
    "2. ONESTÀ TECNICA: se non sei CERTO che un dato valga per quel motore specifico, dillo: "
    "'da verificare sul manuale del [motore]' è una risposta migliore di un valore inventato. "
    "In officina un consiglio sbagliato costa ore di lavoro o danni al veicolo.\n"
    "3. INCONGRUENZE: se i dati della scheda non combaciano tra loro (es. modello di una casa "
    "e codice motore di un'altra), segnalalo all'operaio nella reply invece di proseguire come se nulla fosse."
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
    "spia leggibile. Niente ipotesi o diagnosi non visibili. Se non è chiara, dillo."
)


async def describe_image(data_url: str) -> str:
    """Vision: descrive in una frase cosa mostra una foto (per la memoria dell'officina)."""
    resp = await _client.chat.complete_async(
        model=VISION_MODEL,
        messages=[{"role": "user", "content": [
            {"type": "text", "text": SYSTEM_PHOTO_CAPTION},
            {"type": "image_url", "image_url": data_url},
        ]}],
        max_tokens=120,
    )
    return (resp.choices[0].message.content or "").strip()


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
