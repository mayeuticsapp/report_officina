import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  Modal, TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  Cartellino, Giornata, Timbratura, cartellini, correggiTimbratura, eliminaTimbratura,
  fmtDurata, leggiPosizioneOfficina, impostaPosizioneOfficina, PosizioneOfficina,
  timbraturaManuale, giornataStandard, riscriviGiornata,
} from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { leggiPosizione } from "@/src/utils/posizione";
import { useAutoRefresh } from "@/src/hooks/use-auto-refresh";
import { colors, spacing } from "@/src/theme";

const GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

const fmtOra = (iso: string) =>
  new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

const fmtGiorno = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return `${GIORNI[d.getDay()]} ${d.getDate()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default function CartelliniAdmin() {
  const router = useRouter();
  const [dati, setDati] = useState<Cartellino[]>([]);
  const [posizione, setPosizione] = useState<PosizioneOfficina | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);
  const [fissando, setFissando] = useState(false);

  // correzione di una timbratura
  const [correggi, setCorreggi] = useState<Timbratura | null>(null);
  const [nuovaOra, setNuovaOra] = useState("");
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);

  // aggiunta di timbrature mai fatte (l'operaio non è riuscito a timbrare)
  const [aggiungi, setAggiungi] = useState<Cartellino | null>(null);
  const [aData, setAData] = useState("");
  const [aTipo, setATipo] = useState<"ENTRATA" | "USCITA">("ENTRATA");
  const [aOra, setAOra] = useState("");
  const [aMotivo, setAMotivo] = useState("");

  // Rifare la giornata intera
  const [rifai, setRifai] = useState<{ cartellino: Cartellino; giorno: string } | null>(null);
  const [rEntrata, setREntrata] = useState("");
  const [rUscita, setRUscita] = useState("");
  const [rPausaInizio, setRPausaInizio] = useState("");
  const [rPausaFine, setRPausaFine] = useState("");
  const [rMotivo, setRMotivo] = useState("");

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([cartellini(30), leggiPosizioneOfficina()]);
      setDati(c);
      setPosizione(p);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useAutoRefresh(load);

  const fissaOfficina = async () => {
    const ok = await confirmDialog(
      "Posizione officina",
      "Stai in officina adesso? Fisso qui il centro: le timbrate entro 500 metri risulteranno in sede.",
      "Sono in officina",
    );
    if (!ok) return;
    setFissando(true);
    try {
      const pos = await leggiPosizione();
      if (!pos) {
        showAlert("Posizione non disponibile", "Il telefono non mi dà la posizione. Controlla che il permesso sia attivo.");
        return;
      }
      setPosizione(await impostaPosizioneOfficina(pos.lat, pos.lon, 500));
      showAlert("Fatto", "Centro dell'officina impostato. Da adesso le timbrature vengono confrontate con questo punto.");
    } catch (e: any) {
      showAlert("Errore", e?.message || "Non riesco a salvare la posizione");
    } finally { setFissando(false); }
  };

  const apriCorrezione = (t: Timbratura) => {
    setCorreggi(t);
    setNuovaOra(fmtOra(t.timestamp));
    setMotivo("");
  };

  const salvaCorrezione = async () => {
    if (!correggi) return;
    if (!motivo.trim()) {
      showAlert("Serve il motivo", "Scrivi perché stai correggendo: resta scritto nel cartellino.");
      return;
    }
    const m = nuovaOra.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m) {
      showAlert("Ora non valida", "Scrivi l'ora come 18:30");
      return;
    }
    setSalvando(true);
    try {
      const d = new Date(correggi.timestamp);
      d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
      await correggiTimbratura(correggi.id, { timestamp: d.toISOString(), motivo: motivo.trim() });
      setCorreggi(null);
      await load();
    } catch (e: any) {
      showAlert("Errore", e?.message || "Correzione non salvata");
    } finally { setSalvando(false); }
  };

  // Rifare l'intera giornata: piu veloce che correggere una timbratura alla volta
  const apriRifai = (c: Cartellino, g: Giornata) => {
    const entrate = g.timbrature.filter((t) => t.tipo === "ENTRATA");
    const uscite = g.timbrature.filter((t) => t.tipo === "USCITA");
    setRifai({ cartellino: c, giorno: g.giorno });
    setREntrata(entrate[0] ? fmtOra(entrate[0].timestamp) : "08:30");
    setRUscita(uscite[uscite.length - 1] ? fmtOra(uscite[uscite.length - 1].timestamp) : "18:30");
    // la pausa la si compila solo se serve: molte giornate non ne hanno bisogno
    setRPausaInizio(uscite.length > 1 && uscite[0] ? fmtOra(uscite[0].timestamp) : "");
    setRPausaFine(entrate.length > 1 && entrate[1] ? fmtOra(entrate[1].timestamp) : "");
    setRMotivo("");
  };

  const salvaRifai = async () => {
    if (!rifai) return;
    if (!rMotivo.trim()) {
      showAlert("Serve il motivo", "Scrivi perché stai rifacendo la giornata: resta scritto nel cartellino.");
      return;
    }
    setSalvando(true);
    try {
      await riscriviGiornata({
        worker_id: rifai.cartellino.worker_id,
        giorno: rifai.giorno,
        entrata: rEntrata,
        uscita: rUscita,
        pausa_inizio: rPausaInizio.trim() || undefined,
        pausa_fine: rPausaFine.trim() || undefined,
        motivo: rMotivo.trim(),
      });
      setRifai(null);
      await load();
    } catch (e: any) {
      showAlert("Non salvata", e?.message || "Giornata non riscritta");
    } finally { setSalvando(false); }
  };

  const apriAggiunta = (c: Cartellino) => {
    setAggiungi(c);
    setAData(new Date().toLocaleDateString("sv-SE"));   // oggi, AAAA-MM-GG
    setATipo("ENTRATA");
    setAOra("");
    setAMotivo("");
  };

  const salvaAggiunta = async () => {
    if (!aggiungi) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(aData)) {
      showAlert("Data non valida", "Scrivi la data come 2026-08-01");
      return;
    }
    if (!aMotivo.trim()) {
      showAlert("Serve il motivo", "Scrivi perché la stai aggiungendo: resta scritto nel cartellino.");
      return;
    }
    const m = aOra.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m) {
      showAlert("Ora non valida", "Scrivi l'ora come 08:30");
      return;
    }
    setSalvando(true);
    try {
      const [aa, mm, gg] = aData.split("-").map(Number);
      const d = new Date(aa, mm - 1, gg, parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
      await timbraturaManuale({
        worker_id: aggiungi.worker_id, tipo: aTipo,
        timestamp: d.toISOString(), motivo: aMotivo.trim(),
      });
      setAggiungi(null);
      await load();
    } catch (e: any) {
      showAlert("Errore", e?.message || "Timbratura non aggiunta");
    } finally { setSalvando(false); }
  };

  const salvaGiornataIntera = async () => {
    if (!aggiungi) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(aData)) {
      showAlert("Data non valida", "Scrivi la data come 2026-08-01");
      return;
    }
    if (!aMotivo.trim()) {
      showAlert("Serve il motivo", "Scrivi perché la stai inserendo: es. non è riuscito a entrare nell'app.");
      return;
    }
    const ok = await confirmDialog(
      "Giornata intera",
      `Inserire a ${aggiungi.worker_name} la giornata del ${aData} sull'orario concordato?`,
      "Inserisci",
    );
    if (!ok) return;
    setSalvando(true);
    try {
      const creati = await giornataStandard(aggiungi.worker_id, aData, aMotivo.trim());
      setAggiungi(null);
      await load();
      showAlert("Fatto", `Inserite ${creati.length} timbrature sull'orario concordato.`);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Giornata non inserita");
    } finally { setSalvando(false); }
  };

  const elimina = async (t: Timbratura) => {
    const ok = await confirmDialog("Elimina timbratura",
      `Eliminare la ${t.tipo.toLowerCase()} delle ${fmtOra(t.timestamp)}?`, "Elimina");
    if (!ok) return;
    try { await eliminaTimbratura(t.id); await load(); }
    catch (e: any) { showAlert("Errore", e?.message || "Non eliminata"); }
  };

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;

  const dentroAdesso = dati.filter((c) => c.giornate[0]?.dentro_adesso);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>PRESENZE</Text>
          <Text style={styles.title}>CARTELLINI</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* Chi è in officina adesso */}
        <View style={styles.oraCard}>
          <Text style={styles.sectionLabel}>IN OFFICINA ADESSO</Text>
          {dentroAdesso.length === 0 ? (
            <Text style={styles.vuoto}>Nessuno ha timbrato l&apos;entrata.</Text>
          ) : dentroAdesso.map((c) => (
            <View key={c.worker_id} style={styles.dentroRow}>
              <View style={styles.dentroDot} />
              <Text style={styles.dentroNome}>{c.worker_name}</Text>
              <Text style={styles.dentroOre}>{fmtDurata(c.giornate[0].minuti_presenza)}</Text>
            </View>
          ))}
        </View>

        {/* Posizione officina */}
        {!posizione?.configurata ? (
          <TouchableOpacity testID="btn-fissa-officina" style={styles.posBox} onPress={fissaOfficina} disabled={fissando}>
            <Ionicons name="location-outline" size={20} color={colors.stopped} />
            <View style={{ flex: 1 }}>
              <Text style={styles.posTitolo}>Posizione officina non impostata</Text>
              <Text style={styles.posTesto}>
                Stando in officina, tocca qui: fisso il centro e le timbrature vengono confrontate con questo punto.
              </Text>
            </View>
            {fissando ? <ActivityIndicator size="small" color={colors.text} /> : null}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.posBoxOk} onPress={fissaOfficina} disabled={fissando}>
            <Ionicons name="location" size={16} color={colors.active} />
            <Text style={styles.posTestoOk}>
              Centro officina impostato ({posizione.raggio_m} m) — tocca per rifissarlo da qui
            </Text>
          </TouchableOpacity>
        )}

        {/* Un cartellino per meccanico */}
        {dati.map((c) => {
          const espanso = aperto === c.worker_id;
          return (
            <View key={c.worker_id} style={styles.card}>
              <TouchableOpacity
                testID={`cartellino-${c.worker_id}`}
                style={styles.cardTop}
                onPress={() => setAperto(espanso ? null : c.worker_id)}
                activeOpacity={0.85}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.nome}>{c.worker_name}</Text>
                  {c.giorni_incompleti > 0 ? (
                    <Text style={styles.incompleti}>
                      {c.giorni_incompleti} giorn{c.giorni_incompleti === 1 ? "o" : "i"} senza uscita — da correggere
                    </Text>
                  ) : null}
                </View>
                <View style={styles.saldoBox}>
                  <Text style={styles.saldoLabel}>{c.saldo_minuti >= 0 ? "A CREDITO" : "DA RECUPERARE"}</Text>
                  <Text style={[styles.saldoVal, c.saldo_minuti < 0 && { color: colors.stopped }]}>
                    {fmtDurata(Math.abs(c.saldo_minuti))}
                  </Text>
                </View>
                <Ionicons name={espanso ? "chevron-up" : "chevron-down"} size={20} color={colors.textSecondary} />
              </TouchableOpacity>

              {espanso && (
                <>
                  <TouchableOpacity
                    testID={`btn-aggiungi-${c.worker_id}`}
                    style={styles.aggiungiBtn}
                    onPress={() => apriAggiunta(c)}
                  >
                    <Ionicons name="add-circle-outline" size={18} color={colors.text} />
                    <Text style={styles.aggiungiText}>NON HA TIMBRATO? AGGIUNGI TU</Text>
                  </TouchableOpacity>
                  {c.giornate.length === 0 ? (
                    <Text style={styles.vuoto}>Nessuna timbratura negli ultimi 30 giorni.</Text>
                  ) : c.giornate.map((g) => (
                    <GiornataRiga
                      key={g.giorno}
                      g={g}
                      onCorreggi={apriCorrezione}
                      onElimina={elimina}
                      onRifai={(gg) => apriRifai(c, gg)}
                    />
                  ))}
                </>
              )}
            </View>
          );
        })}
      </ScrollView>

      {/* Aggiunta di timbrature mai fatte */}
      {/* Rifare l'intera giornata: si riscrivono entrata e uscita in un colpo solo */}
      <Modal visible={!!rifai} transparent animationType="slide" onRequestClose={() => setRifai(null)}>
        <View style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>RIFAI LA GIORNATA</Text>
              <TouchableOpacity onPress={() => setRifai(null)}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
              <Text style={styles.mSub}>
                {rifai?.cartellino.worker_name} · {rifai ? fmtGiorno(rifai.giorno) : ""}
              </Text>
              <Text style={styles.rifaiAvviso}>
                Le timbrature di questo giorno vengono sostituite da quelle che scrivi qui sotto.
              </Text>

              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>ENTRATA</Text>
                  <TextInput
                    testID="input-rifai-entrata"
                    style={styles.motivoInput}
                    value={rEntrata}
                    onChangeText={setREntrata}
                    placeholder="08:30"
                    placeholderTextColor={colors.textSecondary}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>USCITA</Text>
                  <TextInput
                    testID="input-rifai-uscita"
                    style={styles.motivoInput}
                    value={rUscita}
                    onChangeText={setRUscita}
                    placeholder="18:30"
                    placeholderTextColor={colors.textSecondary}
                  />
                </View>
              </View>

              <Text style={[styles.label, { marginTop: spacing.md }]}>PAUSA PRANZO (lascia vuoto se non l&apos;ha fatta)</Text>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <TextInput
                  testID="input-rifai-pausa-inizio"
                  style={[styles.motivoInput, { flex: 1 }]}
                  value={rPausaInizio}
                  onChangeText={setRPausaInizio}
                  placeholder="dalle 13:00"
                  placeholderTextColor={colors.textSecondary}
                />
                <TextInput
                  testID="input-rifai-pausa-fine"
                  style={[styles.motivoInput, { flex: 1 }]}
                  value={rPausaFine}
                  onChangeText={setRPausaFine}
                  placeholder="alle 14:30"
                  placeholderTextColor={colors.textSecondary}
                />
              </View>

              <Text style={[styles.label, { marginTop: spacing.md }]}>MOTIVO (obbligatorio)</Text>
              <TextInput
                testID="input-rifai-motivo"
                style={styles.motivoInput}
                value={rMotivo}
                onChangeText={setRMotivo}
                placeholder="es. aveva timbrato più volte per sbaglio"
                placeholderTextColor={colors.textSecondary}
              />

              <TouchableOpacity
                testID="btn-rifai-salva"
                style={[styles.giornataBtn, salvando && { opacity: 0.6 }]}
                disabled={salvando}
                onPress={salvaRifai}
              >
                <Ionicons name="checkmark" size={18} color={colors.textInverse} />
                <Text style={styles.giornataText}>{salvando ? "SALVO…" : "SALVA LA GIORNATA"}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={!!aggiungi} transparent animationType="slide" onRequestClose={() => setAggiungi(null)}>
        <View style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>AGGIUNGI TIMBRATURA</Text>
              <TouchableOpacity onPress={() => setAggiungi(null)}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
              <Text style={styles.mSub}>{aggiungi?.worker_name}</Text>

              <Text style={styles.label}>GIORNO</Text>
              <TextInput
                testID="input-data-aggiunta"
                style={styles.motivoInput}
                value={aData}
                onChangeText={setAData}
                placeholder="2026-08-01"
                placeholderTextColor={colors.textSecondary}
              />

              <Text style={[styles.label, { marginTop: spacing.md }]}>MOTIVO (obbligatorio)</Text>
              <TextInput
                testID="input-motivo-aggiunta"
                style={styles.motivoInput}
                value={aMotivo}
                onChangeText={setAMotivo}
                placeholder="es. non è riuscito a entrare nell'app"
                placeholderTextColor={colors.textSecondary}
              />

              {/* La scorciatoia per il caso più comune */}
              <TouchableOpacity
                testID="btn-giornata-intera"
                style={[styles.giornataBtn, salvando && { opacity: 0.6 }]}
                disabled={salvando}
                onPress={salvaGiornataIntera}
              >
                <Ionicons name="calendar" size={18} color={colors.textInverse} />
                <Text style={styles.giornataText}>INSERISCI LA GIORNATA INTERA</Text>
              </TouchableOpacity>
              <Text style={styles.giornataNota}>
                Mette l&apos;orario concordato: 8:30–13:00 e 14:30–18:30, il sabato 8:00–13:30.
              </Text>

              <View style={styles.separatore}>
                <View style={styles.linea} />
                <Text style={styles.separatoreText}>oppure una timbratura sola</Text>
                <View style={styles.linea} />
              </View>

              <View style={styles.tipoRow}>
                {(["ENTRATA", "USCITA"] as const).map((t) => (
                  <TouchableOpacity
                    key={t}
                    testID={`tipo-${t}`}
                    style={[styles.tipoChip, aTipo === t && styles.tipoChipOn]}
                    onPress={() => setATipo(t)}
                  >
                    <Text style={[styles.tipoChipText, aTipo === t && styles.tipoChipTextOn]}>{t}</Text>
                  </TouchableOpacity>
                ))}
                <TextInput
                  testID="input-ora-aggiunta"
                  style={styles.oraPiccola}
                  value={aOra}
                  onChangeText={setAOra}
                  placeholder="08:30"
                  placeholderTextColor={colors.textSecondary}
                />
              </View>
              <TouchableOpacity
                testID="btn-salva-aggiunta"
                style={[styles.salvaBtn, salvando && { opacity: 0.6 }]}
                disabled={salvando}
                onPress={salvaAggiunta}
              >
                {salvando ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.salvaText}>AGGIUNGI</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Correzione timbratura */}
      <Modal visible={!!correggi} transparent animationType="slide" onRequestClose={() => setCorreggi(null)}>
        <View style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>CORREGGI TIMBRATURA</Text>
              <TouchableOpacity onPress={() => setCorreggi(null)}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>
            <View style={{ padding: spacing.lg }}>
              <Text style={styles.mSub}>
                {correggi?.worker_name} · {correggi?.tipo === "ENTRATA" ? "Entrata" : "Uscita"} del{" "}
                {correggi ? fmtGiorno(correggi.giorno) : ""}
              </Text>
              <Text style={styles.label}>ORA CORRETTA</Text>
              <TextInput
                testID="input-ora-corretta"
                style={styles.oraInput}
                value={nuovaOra}
                onChangeText={setNuovaOra}
                placeholder="18:30"
                placeholderTextColor={colors.textSecondary}
              />
              <Text style={[styles.label, { marginTop: spacing.md }]}>MOTIVO (obbligatorio)</Text>
              <TextInput
                testID="input-motivo-correzione"
                style={styles.motivoInput}
                value={motivo}
                onChangeText={setMotivo}
                placeholder="es. si è dimenticato di timbrare l'uscita"
                placeholderTextColor={colors.textSecondary}
              />
              <TouchableOpacity
                testID="btn-salva-correzione"
                style={[styles.salvaBtn, salvando && { opacity: 0.6 }]}
                disabled={salvando}
                onPress={salvaCorrezione}
              >
                {salvando ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.salvaText}>SALVA</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function GiornataRiga({ g, onCorreggi, onElimina, onRifai }: {
  g: Giornata;
  onCorreggi: (t: Timbratura) => void;
  onElimina: (t: Timbratura) => void;
  onRifai: (g: Giornata) => void;
}) {
  return (
    <View style={styles.giornata}>
      <View style={styles.giornataTop}>
        <Text style={styles.giornataData}>{fmtGiorno(g.giorno)}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TouchableOpacity
            testID={`btn-rifai-${g.giorno}`}
            onPress={() => onRifai(g)}
            style={styles.rifaiBtn}
          >
            <Ionicons name="refresh" size={12} color={colors.text} />
            <Text style={styles.rifaiText}>RIFAI</Text>
          </TouchableOpacity>
          <Text style={styles.giornataOre}>{fmtDurata(g.minuti_presenza)}</Text>
          {g.incompleta ? (
            <View style={styles.badgeIncompleta}><Text style={styles.badgeText}>MANCA USCITA</Text></View>
          ) : (
            g.giorno === new Date().toLocaleDateString("sv-SE") ? (
              <Text style={styles.inCorso}>IN CORSO</Text>
            ) : (
              <Text style={[styles.giornataDiff, g.differenza < 0 && { color: colors.stopped }]}>
                {g.differenza >= 0 ? "+" : ""}{fmtDurata(g.differenza)}
              </Text>
            )
          )}
        </View>
      </View>
      {g.timbrature.map((t) => (
        <View key={t.id} style={styles.timbRow}>
          <Text style={styles.timbTipo}>{t.tipo === "ENTRATA" ? "▸ ENTRATA" : "◂ USCITA"}</Text>
          <Text style={styles.timbOra}>{fmtOra(t.timestamp)}</Text>
          {t.fuori_zona ? (
            <View style={styles.fuoriZona}>
              <Ionicons name="warning" size={11} color={colors.textInverse} />
              <Text style={styles.fuoriZonaText}>{t.distanza_m} m</Text>
            </View>
          ) : t.posizione_assente ? (
            <Text style={styles.senzaPos}>senza posizione</Text>
          ) : (
            <Ionicons name="location" size={12} color={colors.active} />
          )}
          {t.corretta_da_nome ? <Text style={styles.corretta}>corretta</Text> : null}
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={() => onCorreggi(t)} style={styles.miniBtn}>
            <Ionicons name="create-outline" size={16} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onElimina(t)} style={styles.miniBtn}>
            <Ionicons name="trash-outline" size={16} color={colors.stopped} />
          </TouchableOpacity>
        </View>
      ))}
      {g.timbrature.some((t) => t.motivo_correzione) ? (
        <Text style={styles.motivoNota}>
          {g.timbrature.filter((t) => t.motivo_correzione)
            .map((t) => `${t.corretta_da_nome}: ${t.motivo_correzione}`).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", alignItems: "center",
  },
  backBtn: { padding: 4 },
  headerLabel: { fontSize: 10, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  sectionLabel: { fontSize: 11, letterSpacing: 2, fontWeight: "900", color: colors.textSecondary, marginBottom: 8 },
  oraCard: {
    padding: spacing.lg, borderWidth: 2, borderColor: colors.text,
    backgroundColor: colors.bgMuted, marginBottom: spacing.md,
  },
  dentroRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  dentroDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.active },
  dentroNome: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
  dentroOre: { fontSize: 15, fontWeight: "900", color: colors.text },
  vuoto: { fontSize: 13, color: colors.textSecondary, fontStyle: "italic", padding: spacing.sm },
  posBox: {
    flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 2, borderColor: colors.stopped, backgroundColor: "#FEF2F2",
    padding: spacing.md, marginBottom: spacing.md,
  },
  posTitolo: { fontSize: 13, fontWeight: "900", color: colors.stopped },
  posTesto: { fontSize: 12, color: colors.text, marginTop: 2 },
  posBoxOk: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: colors.border, padding: spacing.sm, marginBottom: spacing.md,
  },
  posTestoOk: { fontSize: 12, color: colors.textSecondary, flex: 1 },
  card: { borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md },
  nome: { fontSize: 17, fontWeight: "900", color: colors.text },
  incompleti: { fontSize: 11, color: colors.stopped, fontWeight: "700", marginTop: 2 },
  saldoBox: { alignItems: "flex-end" },
  saldoLabel: { fontSize: 9, letterSpacing: 0.8, fontWeight: "800", color: colors.textSecondary },
  saldoVal: { fontSize: 18, fontWeight: "900", color: colors.text },
  giornata: { borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md, backgroundColor: colors.bgMuted },
  giornataTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  giornataData: { fontSize: 13, fontWeight: "800", color: colors.text },
  giornataOre: { fontSize: 14, fontWeight: "900", color: colors.text },
  giornataDiff: { fontSize: 12, fontWeight: "800", color: colors.active },
  inCorso: { fontSize: 10, fontWeight: "900", letterSpacing: 0.8, color: colors.textSecondary },
  badgeIncompleta: { backgroundColor: colors.stopped, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { color: colors.textInverse, fontSize: 8, fontWeight: "900", letterSpacing: 0.5 },
  timbRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  timbTipo: { fontSize: 11, fontWeight: "800", color: colors.textSecondary, width: 78 },
  timbOra: { fontSize: 14, fontWeight: "900", color: colors.text, width: 52 },
  fuoriZona: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: colors.stopped, paddingHorizontal: 5, paddingVertical: 2,
  },
  fuoriZonaText: { color: colors.textInverse, fontSize: 9, fontWeight: "900" },
  senzaPos: { fontSize: 10, color: colors.paused, fontWeight: "700" },
  corretta: { fontSize: 10, color: colors.textSecondary, fontStyle: "italic" },
  miniBtn: { padding: 4 },
  motivoNota: { fontSize: 11, color: colors.textSecondary, fontStyle: "italic", marginTop: 6 },
  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong },
  mHeader: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  mTitle: { fontSize: 15, fontWeight: "900", letterSpacing: 1.5, color: colors.text },
  mSub: { fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md },
  label: { fontSize: 11, letterSpacing: 2, color: colors.textSecondary, fontWeight: "700" },
  oraInput: {
    borderWidth: 2, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12,
    fontSize: 22, fontWeight: "900", color: colors.text, textAlign: "center", marginTop: 6, minHeight: 54,
  },
  motivoInput: {
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12,
    fontSize: 15, color: colors.text, marginTop: 6, minHeight: 48,
  },
  aggiungiBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12,
  },
  rifaiBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8, paddingVertical: 4,
  },
  rifaiText: { fontSize: 9, fontWeight: "900", letterSpacing: 1, color: colors.text },
  rifaiAvviso: {
    fontSize: 12, color: colors.textSecondary, lineHeight: 17,
    marginTop: 4, marginBottom: spacing.md,
  },
  aggiungiText: { fontSize: 11, fontWeight: "900", letterSpacing: 1, color: colors.text },
  giornataBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.active, paddingVertical: 16, marginTop: spacing.lg,
  },
  giornataText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 1.5, fontSize: 13 },
  giornataNota: { fontSize: 11, color: colors.textSecondary, marginTop: 6, textAlign: "center" },
  separatore: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: spacing.lg },
  linea: { flex: 1, height: 1, backgroundColor: colors.border },
  separatoreText: { fontSize: 11, color: colors.textSecondary },
  tipoRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  tipoChip: {
    paddingHorizontal: 12, paddingVertical: 12, borderWidth: 1, borderColor: colors.border,
  },
  tipoChipOn: { backgroundColor: colors.text, borderColor: colors.text },
  tipoChipText: { fontSize: 11, fontWeight: "900", letterSpacing: 1, color: colors.text },
  tipoChipTextOn: { color: colors.textInverse },
  oraPiccola: {
    flex: 1, borderWidth: 2, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 18, fontWeight: "900", color: colors.text, textAlign: "center", minHeight: 46,
  },
  salvaBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center", marginTop: spacing.lg },
  salvaText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
