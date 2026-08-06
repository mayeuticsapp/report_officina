import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Modal,
  TextInput, KeyboardAvoidingView, Platform, Image, Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api, WorkEvent, WorkOrder, EventType, setEffectiveHours, oreProposte, OreProposte } from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { useAuth } from "@/src/auth/AuthContext";
import { VoiceChat } from "@/src/components/VoiceChat";
import { VehicleHistory } from "@/src/components/VehicleHistory";
import { PhotoArchive } from "@/src/components/PhotoArchive";
import { OrderMessages } from "@/src/components/OrderMessages";
import { TimerDisplay } from "@/src/components/TimerDisplay";
import { colors, spacing } from "@/src/theme";

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState<null | EventType>(null);
  const [reason, setReason] = useState("");
  const [km, setKm] = useState("");
  // "li metto alla fine": il contachilometri non è leggibile adesso
  const [kmDefer, setKmDefer] = useState(false);
  const [kmDeferReason, setKmDeferReason] = useState("");
  // correzione di un chilometraggio sbagliato
  const [kmFixing, setKmFixing] = useState(false);
  const [kmFixValue, setKmFixValue] = useState("");
  const [kmFixReason, setKmFixReason] = useState("");
  const [savingKmFix, setSavingKmFix] = useState(false);
  // foto del libretto: obbligatoria su INIZIA, subito dopo i km
  const [libretto, setLibretto] = useState<string | null>(null);
  // ore da fatturare, confermate alla chiusura
  const [oreProp, setOreProp] = useState<OreProposte | null>(null);
  const [oreCaricando, setOreCaricando] = useState(false);
  const [cOre, setCOre] = useState("");
  const [cMin, setCMin] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [hoursEditing, setHoursEditing] = useState(false);
  const [hOre, setHOre] = useState("");
  const [hMin, setHMin] = useState("");
  const [hReason, setHReason] = useState("");
  const [savingHours, setSavingHours] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [o, evs] = await Promise.all([
        api<WorkOrder>(`/work-orders/${id}`),
        api<WorkEvent[]>(`/work-orders/${id}/events`),
      ]);
      setOrder(o);
      setEvents(evs);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile caricare la commessa");
    } finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const fmtMin = (m: number) => {
    const h = Math.floor(m / 60), mm = m % 60;
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
  };

  const openHoursEdit = () => {
    const base = order?.minutes_effective ?? order?.minutes_calculated ?? 0;
    setHOre(String(Math.floor(base / 60)));
    setHMin(String(base % 60));
    setHReason(order?.minutes_effective_reason || "");
    setHoursEditing(true);
  };

  const saveHours = async () => {
    if (!order) return;
    const total = (parseInt(hOre || "0", 10) || 0) * 60 + (parseInt(hMin || "0", 10) || 0);
    setSavingHours(true);
    try {
      const updated = await setEffectiveHours(order.id, total, hReason.trim() || null);
      setOrder(updated);
      setHoursEditing(false);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Ore non salvate");
    } finally { setSavingHours(false); }
  };

  const resetHours = async () => {
    if (!order) return;
    setSavingHours(true);
    try {
      const updated = await setEffectiveHours(order.id, null, null);
      setOrder(updated);
      setHoursEditing(false);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Non riesco ad azzerare");
    } finally { setSavingHours(false); }
  };

  // le correzioni dei km non sono passaggi di lavoro: non contano per capire
  // se il lavoro è in corso, in pausa o finito
  const workEvents = events.filter((e) => e.type !== "KM");
  const lastEvent = workEvents[workEvents.length - 1];
  // L'approvazione del titolare non blocca piu il lavoro: si parte e basta,
  // e lui la riconosce quando la vede. Prima una commessa aperta dal meccanico
  // aspettava in media 2h40 prima di poter partire, e quelle ore sparivano.
  const canStart = !lastEvent;
  const canReopen = !!lastEvent && lastEvent.type === "COMPLETE";
  const canPause = lastEvent && (lastEvent.type === "START" || lastEvent.type === "RESUME");
  const canResume = lastEvent && lastEvent.type === "PAUSE";
  const canComplete = lastEvent && lastEvent.type !== "COMPLETE";

  // i km si danno una volta sola: se ci sono già, alla chiusura non si richiedono
  const kmRegistrati = (order?.scheda_tecnica?.km || "").trim();
  const kmDaChiedereAllaFine = !kmRegistrati;

  const openAction = (t: EventType) => {
    setReason("");
    setKm("");
    setKmDefer(false);
    setKmDeferReason("");
    setLibretto(null);
    setPhotos([]);
    setModalOpen(t);
    if (t === "COMPLETE" && order) {
      // l'AI legge quello che il meccanico ha scritto durante il lavoro e propone le ore
      setOreProp(null);
      setCOre("");
      setCMin("");
      setOreCaricando(true);
      oreProposte(order.id)
        .then((p) => {
          setOreProp(p);
          setCOre(String(Math.floor(p.minuti_proposti / 60)));
          setCMin(String(p.minuti_proposti % 60));
        })
        .catch(() => setOreProp(null))
        .finally(() => setOreCaricando(false));
    }
  };

  // Foto del libretto: obbligatoria per far partire il lavoro.
  const scattaLibretto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (perm.status !== "granted") {
      if (!perm.canAskAgain) {
        const goSettings = await confirmDialog("Permesso fotocamera", "Serve la fotocamera per la foto del libretto. Apri le Impostazioni per attivarla.", "Impostazioni");
        if (goSettings) Linking.openSettings();
      } else {
        showAlert("Permesso negato", "Non posso accedere alla fotocamera senza permesso.");
      }
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.6, base64: true, allowsEditing: false });
    if (!res.canceled && res.assets[0]?.base64) {
      setLibretto(`data:image/jpeg;base64,${res.assets[0].base64}`);
    }
  };

  const libarettoDaGalleria = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== "granted") {
      showAlert("Permesso galleria", "Serve accesso alla galleria per la foto del libretto.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, base64: true, mediaTypes: ["images"] });
    if (!res.canceled && res.assets[0]?.base64) {
      setLibretto(`data:image/jpeg;base64,${res.assets[0].base64}`);
    }
  };

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (perm.status !== "granted") {
      if (!perm.canAskAgain) {
        const goSettings = await confirmDialog("Permesso fotocamera", "Serve accesso alla fotocamera per allegare foto. Apri le Impostazioni per attivarlo.", "Impostazioni");
        if (goSettings) Linking.openSettings();
      } else {
        showAlert("Permesso negato", "Non posso accedere alla fotocamera senza permesso.");
      }
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      quality: 0.6, base64: true, allowsEditing: false,
    });
    if (!res.canceled && res.assets[0]?.base64) {
      const uri = `data:image/jpeg;base64,${res.assets[0].base64}`;
      setPhotos((p) => [...p, uri]);
    }
  };

  const pickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== "granted") {
      showAlert("Permesso galleria", "Serve accesso alla galleria per allegare foto.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: 0.6, base64: true, mediaTypes: ["images"],
    });
    if (!res.canceled && res.assets[0]?.base64) {
      const uri = `data:image/jpeg;base64,${res.assets[0].base64}`;
      setPhotos((p) => [...p, uri]);
    }
  };

  const submitAction = async () => {
    if (!modalOpen || !order) return;
    const kmPulito = km.replace(/[^0-9]/g, "");

    if (modalOpen === "START" && !kmRegistrati) {
      if (!kmDefer && !kmPulito) {
        showAlert("KM DEL VEICOLO", "Scrivi i chilometri. Se non riesci a leggerli adesso, premi «Non riesco a leggerli ora».");
        return;
      }
      if (kmDefer && !kmDeferReason.trim()) {
        showAlert("Serve il motivo", "Scrivi perché non puoi leggere i km adesso: es. auto già sul ponte.");
        return;
      }
    }
    if (modalOpen === "START" && !libretto) {
      showAlert("FOTO DEL LIBRETTO", "Scatta la foto del libretto: senza quella il lavoro non parte.");
      return;
    }
    if (modalOpen === "COMPLETE" && kmDaChiedereAllaFine && !kmPulito) {
      showAlert("KM OBBLIGATORI", "Inserisci i chilometri del veicolo: senza km non puoi completare il lavoro.");
      return;
    }
    const minutiConfermati = modalOpen === "COMPLETE"
      ? (parseInt(cOre || "0", 10) || 0) * 60 + (parseInt(cMin || "0", 10) || 0)
      : null;
    if (modalOpen === "COMPLETE") {
      if (oreCaricando) {
        showAlert("Un attimo", "Sto ancora leggendo le ore dalle tue note.");
        return;
      }
      if (!cOre.trim() && !cMin.trim()) {
        showAlert("ORE OBBLIGATORIE", "Conferma le ore lavorate: sono quelle che finiscono in fattura.");
        return;
      }
      if (minutiConfermati === 0) {
        showAlert("Ore a zero", "Hai messo zero ore. Se è giusto scrivi almeno 1 minuto, altrimenti correggi.");
        return;
      }
    }
    if ((modalOpen === "PAUSE" || modalOpen === "COMPLETE") && !reason.trim()) {
      showAlert("Motivo richiesto", `Inserisci un motivo per ${modalOpen === "PAUSE" ? "la sospensione" : "il completamento"}.`);
      return;
    }
    setSubmitting(true);
    try {
      const inviaKm =
        (modalOpen === "START" && !kmDefer && !!kmPulito) ||
        (modalOpen === "COMPLETE" && kmDaChiedereAllaFine);
      await api<WorkEvent>(`/work-orders/${order.id}/events`, {
        method: "POST",
        body: {
          type: modalOpen,
          reason: reason.trim() || null,
          photos_base64: photos,
          km: inviaKm ? kmPulito : null,
          km_deferred_reason: modalOpen === "START" && kmDefer ? kmDeferReason.trim() : null,
          minutes_effective: minutiConfermati,
          libretto_base64: modalOpen === "START" ? libretto : null,
        },
      });
      setModalOpen(null);
      await load();
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile salvare");
    } finally { setSubmitting(false); }
  };

  const saveKmFix = async () => {
    if (!order) return;
    const pulito = kmFixValue.replace(/[^0-9]/g, "");
    if (!pulito) {
      showAlert("KM mancanti", "Scrivi il chilometraggio corretto.");
      return;
    }
    if (!kmFixReason.trim()) {
      showAlert("Serve l'osservazione", "Scrivi perché stai correggendo i km: es. avevo letto male il contachilometri.");
      return;
    }
    setSavingKmFix(true);
    try {
      await api<WorkEvent>(`/work-orders/${order.id}/events`, {
        method: "POST",
        body: { type: "KM", reason: kmFixReason.trim(), photos_base64: [], km: pulito },
      });
      setKmFixing(false);
      setKmFixValue("");
      setKmFixReason("");
      await load();
    } catch (e: any) {
      showAlert("Errore", e?.message || "Km non corretti");
    } finally { setSavingKmFix(false); }
  };

  if (loading || !order) {
    return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;
  }

  const statusColorMap: Record<string, string> = {
    pending: colors.paused, open: colors.idle, in_progress: colors.active, paused: colors.paused, completed: colors.textSecondary,
  };
  const statusLabelMap: Record<string, string> = {
    pending: "IN ATTESA", open: "APERTA", in_progress: "IN CORSO", paused: "IN PAUSA", completed: "COMPLETATA",
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Sticky header */}
      <View style={styles.header}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>COMMESSA</Text>
          <Text style={styles.headerTitle}>{order.plate}</Text>
        </View>
        <View style={[styles.pill, { backgroundColor: statusColorMap[order.status] }]}>
          <Text style={styles.pillText}>{statusLabelMap[order.status]}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Timer: sempre visibile, grande */}
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg }}>
          <TimerDisplay events={events} status={order.status} />
        </View>

        {/* Details */}
        <View style={styles.detailsCard}>
          <Row label="VEICOLO" value={order.vehicle} />
          <Row label="CLIENTE" value={order.customer} />
          {order.vin ? <Row label="VIN" value={order.vin} /> : null}
          <View style={{ marginTop: spacing.md }}>
            <Text style={styles.label}>LAVORAZIONE</Text>
            <Text style={styles.desc}>{order.description}</Text>
          </View>
        </View>

        {/* Chilometraggio: si registra su INIZIA, si corregge da qui */}
        {(
          <View style={styles.kmCard}>
            <Text style={styles.sectionLabel}>CHILOMETRAGGIO</Text>
            {kmRegistrati ? (
              <View style={styles.kmCardRow}>
                <Text style={styles.kmCardValue}>{Number(kmRegistrati).toLocaleString("it-IT")} km</Text>
              </View>
            ) : (
              <Text style={styles.kmCardMissing}>
                Non ancora registrati — te li chiede l&apos;app quando completi il lavoro.
              </Text>
            )}
            {kmRegistrati && !kmFixing ? (
              <TouchableOpacity
                testID="btn-fix-km"
                style={styles.hoursBtn}
                onPress={() => { setKmFixValue(kmRegistrati); setKmFixReason(""); setKmFixing(true); }}
              >
                <Ionicons name="create-outline" size={16} color={colors.text} />
                <Text style={styles.hoursBtnText}>I km sono sbagliati? Correggi</Text>
              </TouchableOpacity>
            ) : null}
            {kmFixing && (
              <View style={styles.hoursEditBox}>
                <TextInput
                  testID="km-fix-value"
                  style={styles.kmFixInput}
                  value={kmFixValue}
                  onChangeText={(v) => setKmFixValue(v.replace(/[^0-9]/g, ""))}
                  keyboardType="number-pad"
                  maxLength={7}
                  placeholder="es. 154000"
                  placeholderTextColor={colors.textSecondary}
                />
                <TextInput
                  testID="km-fix-reason"
                  style={styles.hoursReasonInput}
                  value={kmFixReason}
                  onChangeText={setKmFixReason}
                  placeholder="Perché li correggi (es. avevo letto male il contachilometri)"
                  placeholderTextColor={colors.textSecondary}
                />
                <View style={styles.hoursActions}>
                  <TouchableOpacity
                    testID="btn-save-km-fix"
                    style={[styles.hoursSaveBtn, savingKmFix && { opacity: 0.5 }]}
                    disabled={savingKmFix}
                    onPress={saveKmFix}
                  >
                    {savingKmFix ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.hoursSaveText}>SALVA KM</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.hoursMiniBtn} disabled={savingKmFix} onPress={() => setKmFixing(false)}>
                    <Text style={styles.hoursMiniText}>Annulla</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {/* AI Voice Chat + Scheda Tecnica */}
        <VehicleHistory orderId={order.id} />

        <VoiceChat orderId={order.id} />

        {events.length > 0 && (() => {
          const calc = order.minutes_calculated ?? 0;
          const hasEff = order.minutes_effective != null && order.minutes_effective !== calc;
          const eff = order.minutes_effective ?? calc;
          return (
            <View style={styles.hoursCard}>
              <Text style={styles.sectionLabel}>ORE LAVORATE</Text>
              <View style={styles.hoursRow}>
                <Text style={styles.hoursLabel}>Dai timbri (calcolate)</Text>
                <Text style={[styles.hoursVal, hasEff && styles.hoursStrike]}>{fmtMin(calc)}</Text>
              </View>
              {hasEff && (
                <View style={styles.hoursRow}>
                  <Text style={[styles.hoursLabel, { color: colors.active }]}>Da fatturare (corrette)</Text>
                  <Text style={[styles.hoursVal, { color: colors.active }]}>{fmtMin(eff)}</Text>
                </View>
              )}
              {hasEff && order.minutes_effective_reason ? (
                <Text style={styles.hoursReason}>Motivo: {order.minutes_effective_reason}</Text>
              ) : null}
              {!hoursEditing ? (
                <TouchableOpacity testID="btn-edit-hours" style={styles.hoursBtn} onPress={openHoursEdit}>
                  <Ionicons name="create-outline" size={16} color={colors.text} />
                  <Text style={styles.hoursBtnText}>Le ore non tornano? Correggi</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.hoursEditBox}>
                  <View style={styles.hoursInputsRow}>
                    <TextInput testID="hours-ore" style={styles.hoursInput} value={hOre} onChangeText={setHOre} keyboardType="number-pad" placeholder="0" placeholderTextColor={colors.textSecondary} />
                    <Text style={styles.hoursUnit}>h</Text>
                    <TextInput testID="hours-min" style={styles.hoursInput} value={hMin} onChangeText={setHMin} keyboardType="number-pad" placeholder="0" placeholderTextColor={colors.textSecondary} />
                    <Text style={styles.hoursUnit}>m</Text>
                  </View>
                  <TextInput testID="hours-reason" style={styles.hoursReasonInput} value={hReason} onChangeText={setHReason} placeholder="Motivo (es. pausa pranzo dimenticata)" placeholderTextColor={colors.textSecondary} />
                  <View style={styles.hoursActions}>
                    <TouchableOpacity testID="btn-save-hours" style={[styles.hoursSaveBtn, savingHours && { opacity: 0.5 }]} disabled={savingHours} onPress={saveHours}>
                      <Text style={styles.hoursSaveText}>SALVA ORE</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.hoursMiniBtn} disabled={savingHours} onPress={resetHours}>
                      <Text style={styles.hoursMiniText}>Usa calcolate</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.hoursMiniBtn} disabled={savingHours} onPress={() => setHoursEditing(false)}>
                      <Text style={styles.hoursMiniText}>Annulla</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          );
        })()}

        <PhotoArchive orderId={order.id} canUpload currentUserId={user?.id} />

        <OrderMessages orderId={order.id} />

        {/* Timeline */}
        <Text style={styles.sectionLabel}>TIMELINE</Text>
        {events.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>Nessun evento. Inizia il lavoro qui sotto.</Text></View>
        ) : (
          events.map((e) => <TimelineItem key={e.id} ev={e} />)
        )}
      </ScrollView>

      {/* Action buttons - sticky bottom */}
      <View style={styles.actionBar}>
        {canStart && (
          <ActionBtn testID="btn-start" label="INIZIA" color={colors.active} onPress={() => openAction("START")} />
        )}
        {canReopen && (
          <ActionBtn testID="btn-reopen" label="RIAPRI" color={colors.active} onPress={() => openAction("RESUME")} />
        )}
        {canPause && (
          <ActionBtn testID="btn-pause" label="PAUSA" color={colors.paused} textColor={colors.text} onPress={() => openAction("PAUSE")} />
        )}
        {canResume && (
          <ActionBtn testID="btn-resume" label="RIPRENDI" color={colors.active} onPress={() => openAction("RESUME")} />
        )}
        {canComplete && (
          <ActionBtn testID="btn-complete" label="COMPLETA" color={colors.text} onPress={() => openAction("COMPLETE")} />
        )}
      </View>

      {/* Modal for reason + photo */}
      <Modal visible={!!modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {modalOpen === "START" && "INIZIA LAVORO"}
                {modalOpen === "PAUSE" && "SOSPENDI LAVORO"}
                {modalOpen === "RESUME" && (canReopen ? "RIAPRI LAVORO" : "RIPRENDI LAVORO")}
                {modalOpen === "COMPLETE" && "COMPLETA LAVORO"}
              </Text>
              <TouchableOpacity testID="modal-close" onPress={() => setModalOpen(null)}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
              {modalOpen === "START" && !kmRegistrati && (
                <View style={styles.kmBox}>
                  <Text style={styles.kmLabel}>KM DEL VEICOLO</Text>
                  {!kmDefer ? (
                    <>
                      <TextInput
                        testID="km-input"
                        style={styles.kmInput}
                        value={km}
                        onChangeText={(v) => setKm(v.replace(/[^0-9]/g, ""))}
                        placeholder="es. 154000"
                        placeholderTextColor="#FCA5A5"
                        keyboardType="number-pad"
                        maxLength={7}
                        autoFocus
                      />
                      <Text style={styles.kmHint}>Leggi il contachilometri prima di mettere le mani sull&apos;auto.</Text>
                      <TouchableOpacity
                        testID="btn-km-defer"
                        style={styles.kmDeferBtn}
                        onPress={() => { setKm(""); setKmDefer(true); }}
                      >
                        <Ionicons name="time-outline" size={16} color={colors.text} />
                        <Text style={styles.kmDeferBtnText}>NON RIESCO A LEGGERLI ORA</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <Text style={styles.kmHint}>Scrivi perché: li rimettiamo alla chiusura del lavoro.</Text>
                      <TextInput
                        testID="km-defer-reason"
                        style={styles.kmDeferInput}
                        value={kmDeferReason}
                        onChangeText={setKmDeferReason}
                        placeholder="es. auto già sul ponte"
                        placeholderTextColor="#FCA5A5"
                        autoFocus
                      />
                      <TouchableOpacity
                        testID="btn-km-undefer"
                        style={styles.kmDeferBtn}
                        onPress={() => { setKmDefer(false); setKmDeferReason(""); }}
                      >
                        <Ionicons name="arrow-back" size={16} color={colors.text} />
                        <Text style={styles.kmDeferBtnText}>NO, LI SCRIVO ADESSO</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}
              {modalOpen === "COMPLETE" && kmDaChiedereAllaFine && (
                <View style={styles.kmBox}>
                  <Text style={styles.kmLabel}>⚠ KM DEL VEICOLO — OBBLIGATORIO</Text>
                  <TextInput
                    testID="km-input"
                    style={styles.kmInput}
                    value={km}
                    onChangeText={(v) => setKm(v.replace(/[^0-9]/g, ""))}
                    placeholder="es. 154000"
                    placeholderTextColor="#FCA5A5"
                    keyboardType="number-pad"
                    maxLength={7}
                    autoFocus
                  />
                  <Text style={styles.kmHint}>Leggi il contachilometri: senza km non puoi completare.</Text>
                </View>
              )}
              {modalOpen === "START" && (
                <View style={[styles.libBox, libretto ? styles.libBoxOk : null]}>
                  <Text style={[styles.libLabel, libretto ? styles.libLabelOk : null]}>
                    {libretto ? "✓ FOTO DEL LIBRETTO" : "📄 FOTO DEL LIBRETTO — OBBLIGATORIA"}
                  </Text>
                  {libretto ? (
                    <>
                      <Image source={{ uri: libretto }} style={styles.libPreview} resizeMode="cover" />
                      <TouchableOpacity
                        testID="btn-libretto-rifai"
                        style={styles.libRifaiBtn}
                        onPress={() => setLibretto(null)}
                      >
                        <Ionicons name="refresh" size={16} color={colors.text} />
                        <Text style={styles.libRifaiText}>RIFALLA</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <Text style={styles.libHint}>
                        Inquadra il libretto per intero: targa e telaio devono leggersi.
                      </Text>
                      <View style={styles.photoRow}>
                        <TouchableOpacity testID="btn-libretto-camera" onPress={scattaLibretto} style={styles.photoBtn}>
                          <Ionicons name="camera" size={22} color={colors.text} />
                          <Text style={styles.photoBtnText}>FOTOCAMERA</Text>
                        </TouchableOpacity>
                        <TouchableOpacity testID="btn-libretto-galleria" onPress={libarettoDaGalleria} style={styles.photoBtn}>
                          <Ionicons name="image" size={22} color={colors.text} />
                          <Text style={styles.photoBtnText}>GALLERIA</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              )}
              {modalOpen === "COMPLETE" && (
                <View style={styles.oreBox}>
                  <Text style={styles.oreLabel}>⏱ ORE LAVORATE — VANNO IN FATTURA</Text>
                  {oreCaricando ? (
                    <View style={styles.oreLoading}>
                      <ActivityIndicator size="small" color={colors.text} />
                      <Text style={styles.oreLoadingText}>Leggo le ore da quello che hai scritto…</Text>
                    </View>
                  ) : (
                    <>
                      <View style={styles.oreInputsRow}>
                        <TextInput
                          testID="complete-ore"
                          style={styles.oreInput}
                          value={cOre}
                          onChangeText={(v) => setCOre(v.replace(/[^0-9]/g, ""))}
                          keyboardType="number-pad"
                          maxLength={3}
                          placeholder="0"
                          placeholderTextColor={colors.textSecondary}
                        />
                        <Text style={styles.oreUnit}>h</Text>
                        <TextInput
                          testID="complete-min"
                          style={styles.oreInput}
                          value={cMin}
                          onChangeText={(v) => setCMin(v.replace(/[^0-9]/g, ""))}
                          keyboardType="number-pad"
                          maxLength={2}
                          placeholder="00"
                          placeholderTextColor={colors.textSecondary}
                        />
                        <Text style={styles.oreUnit}>m</Text>
                      </View>
                      {oreProp?.fonte === "note" ? (
                        <View style={styles.oreFonteBox}>
                          <Text style={styles.oreFonteTitolo}>Preso da quello che hai detto:</Text>
                          {oreProp.citazione ? (
                            <Text style={styles.oreCitazione}>&ldquo;{oreProp.citazione}&rdquo;</Text>
                          ) : null}
                          {oreProp.dettaglio ? (
                            <Text style={styles.oreDettaglio}>{oreProp.dettaglio}</Text>
                          ) : null}
                          <Text style={styles.oreTimbri}>
                            I timbri dicono {Math.floor(oreProp.minuti_timbri / 60)}h {oreProp.minuti_timbri % 60}m
                          </Text>
                        </View>
                      ) : oreProp?.fonte === "timbri" ? (
                        <Text style={styles.oreDettaglio}>
                          Nelle tue note non hai scritto quanto ci hai messo: qui ci sono le ore dei timbri.
                          Controllale, spesso non tornano.
                        </Text>
                      ) : (
                        <Text style={styles.oreDettaglio}>
                          Non sono riuscito a leggere le tue note adesso: qui ci sono le ore dei timbri.
                          Scrivile tu.
                        </Text>
                      )}
                      <Text style={styles.oreHint}>È giusto? Conferma. Altrimenti correggi e vai avanti.</Text>
                    </>
                  )}
                </View>
              )}
              {modalOpen === "COMPLETE" && !kmDaChiedereAllaFine && (
                <View style={styles.kmDoneBox}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.active} />
                  <Text style={styles.kmDoneText}>
                    KM già registrati: {Number(kmRegistrati).toLocaleString("it-IT")}
                  </Text>
                </View>
              )}
              <Text style={styles.label}>
                {modalOpen === "PAUSE" || modalOpen === "COMPLETE" ? "MOTIVO (obbligatorio)" : "NOTE (facoltativo)"}
              </Text>
              <TextInput
                testID="reason-input"
                style={styles.textarea}
                multiline
                value={reason}
                onChangeText={setReason}
                placeholder={
                  modalOpen === "PAUSE"
                    ? "es. Devo finire l'Audi di Rossi"
                    : modalOpen === "COMPLETE"
                    ? "es. Sostituita pompa acqua, testata."
                    : "es. Iniziato smontaggio motore"
                }
                placeholderTextColor={colors.textSecondary}
              />

              <Text style={[styles.label, { marginTop: spacing.md }]}>FOTO ({photos.length})</Text>
              <View style={styles.photoRow}>
                <TouchableOpacity testID="btn-camera" onPress={pickPhoto} style={styles.photoBtn}>
                  <Ionicons name="camera" size={22} color={colors.text} />
                  <Text style={styles.photoBtnText}>FOTOCAMERA</Text>
                </TouchableOpacity>
                <TouchableOpacity testID="btn-library" onPress={pickFromLibrary} style={styles.photoBtn}>
                  <Ionicons name="image" size={22} color={colors.text} />
                  <Text style={styles.photoBtnText}>GALLERIA</Text>
                </TouchableOpacity>
              </View>
              {photos.length > 0 && (
                <ScrollView horizontal style={{ marginTop: spacing.md }} showsHorizontalScrollIndicator={false}>
                  {photos.map((p, i) => (
                    <View key={i} style={styles.thumbWrap}>
                      <Image source={{ uri: p }} style={styles.thumb} />
                      <TouchableOpacity style={styles.thumbRemove} onPress={() => setPhotos((arr) => arr.filter((_, j) => j !== i))}>
                        <Ionicons name="close" size={14} color={colors.textInverse} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              )}
            </ScrollView>

            <View style={{ padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border }}>
              <TouchableOpacity
                testID="modal-submit"
                disabled={submitting}
                style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                onPress={submitAction}
              >
                {submitting ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.submitText}>CONFERMA</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function ActionBtn({ testID, label, color, textColor, onPress }: { testID: string; label: string; color: string; textColor?: string; onPress: () => void }) {
  return (
    <TouchableOpacity testID={testID} style={[styles.action, { backgroundColor: color }]} onPress={onPress} activeOpacity={0.85}>
      <Text style={[styles.actionText, { color: textColor || colors.textInverse }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function TimelineItem({ ev }: { ev: WorkEvent }) {
  const colorMap: Record<string, string> = {
    START: colors.active, RESUME: colors.active, PAUSE: colors.paused, COMPLETE: colors.text,
    KM: colors.primary,
  };
  const labelMap: Record<string, string> = {
    START: "INIZIO", RESUME: "RIPRESA", PAUSE: "PAUSA", COMPLETE: "COMPLETATO", KM: "KM CORRETTI",
  };
  const d = new Date(ev.timestamp);
  const time = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  const date = d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" });
  return (
    <View style={styles.tlItem}>
      <View style={styles.tlLeft}>
        <View style={[styles.tlDot, { backgroundColor: colorMap[ev.type] }]} />
        <Text style={styles.tlTime}>{time}</Text>
        <Text style={styles.tlDate}>{date}</Text>
      </View>
      <View style={styles.tlBody}>
        <Text style={[styles.tlLabel, { color: colorMap[ev.type] }]}>{labelMap[ev.type]}</Text>
        <Text style={styles.tlWorker}>{ev.worker_full_name}</Text>
        {ev.km ? <Text style={styles.tlKm}>KM {Number(ev.km).toLocaleString("it-IT")}</Text> : null}
        {ev.km_deferred_reason ? (
          <Text style={styles.tlKmDeferred}>KM rimandati alla fine — &ldquo;{ev.km_deferred_reason}&rdquo;</Text>
        ) : null}
        {ev.reason ? <Text style={styles.tlReason}>&ldquo;{ev.reason}&rdquo;</Text> : null}
        {ev.ai_interpretation ? (
          <View style={styles.aiBox}>
            <Text style={styles.aiLabel}>AI</Text>
            <Text style={styles.aiText}>{ev.ai_interpretation}</Text>
          </View>
        ) : null}
        {ev.photos_base64?.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
            {ev.photos_base64.map((p, i) => (
              <Image key={i} source={{ uri: p }} style={styles.evPhoto} />
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", padding: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.borderStrong, backgroundColor: colors.bg,
  },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  headerLabel: { fontSize: 10, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  headerTitle: { fontSize: 22, fontWeight: "900", color: colors.text, marginTop: 2 },
  pill: { paddingHorizontal: 10, paddingVertical: 6 },
  pillText: { color: colors.textInverse, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  detailsCard: { margin: spacing.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  label: { fontSize: 10, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  value: { fontSize: 16, color: colors.text, marginTop: 2, fontWeight: "600" },
  desc: { fontSize: 14, color: colors.text, marginTop: 4, lineHeight: 20 },
  sectionLabel: { marginHorizontal: spacing.lg, fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700", marginBottom: spacing.sm },
  hoursCard: { margin: spacing.lg, marginTop: 0, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgMuted },
  hoursRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3 },
  hoursLabel: { fontSize: 13, color: colors.textSecondary },
  hoursVal: { fontSize: 17, fontWeight: "900", color: colors.text },
  hoursStrike: { textDecorationLine: "line-through", color: colors.textSecondary, fontWeight: "700" },
  hoursReason: { fontSize: 12, color: colors.textSecondary, fontStyle: "italic", marginTop: 2 },
  hoursBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.sm, paddingVertical: 8 },
  hoursBtnText: { fontSize: 13, color: colors.text, fontWeight: "700" },
  hoursEditBox: { marginTop: spacing.sm, gap: 8 },
  hoursInputsRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hoursInput: { width: 60, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 10, paddingVertical: 8, fontSize: 18, fontWeight: "900", color: colors.text, textAlign: "center" },
  hoursUnit: { fontSize: 16, fontWeight: "700", color: colors.textSecondary },
  hoursReasonInput: { borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.text },
  hoursActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  hoursSaveBtn: { backgroundColor: colors.active, paddingHorizontal: 16, paddingVertical: 10 },
  hoursSaveText: { color: colors.textInverse, fontSize: 13, fontWeight: "900", letterSpacing: 1 },
  hoursMiniBtn: { paddingVertical: 8 },
  hoursMiniText: { fontSize: 12, color: colors.textSecondary, fontWeight: "700" },
  empty: { marginHorizontal: spacing.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary, fontSize: 13 },
  tlItem: { flexDirection: "row", marginHorizontal: spacing.lg, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  tlLeft: { width: 72, alignItems: "flex-start" },
  tlDot: { width: 12, height: 12, marginBottom: 6 },
  tlTime: { fontSize: 16, fontWeight: "900", color: colors.text },
  tlDate: { fontSize: 11, color: colors.textSecondary },
  tlBody: { flex: 1, borderLeftWidth: 1, borderLeftColor: colors.border, paddingLeft: spacing.md },
  tlLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 2 },
  tlWorker: { fontSize: 13, color: colors.text, marginTop: 2, fontWeight: "600" },
  tlKm: { fontSize: 12, fontWeight: "900", color: colors.primary, marginTop: 2, letterSpacing: 0.5 },
  tlKmDeferred: { fontSize: 12, color: colors.paused, fontWeight: "700", marginTop: 2 },
  tlReason: { fontSize: 13, color: colors.textSecondary, marginTop: 4, fontStyle: "italic" },
  aiBox: { marginTop: 8, padding: 8, backgroundColor: colors.bgMuted, flexDirection: "row", gap: 8 },
  aiLabel: { fontSize: 10, fontWeight: "900", letterSpacing: 2, color: colors.primary },
  aiText: { flex: 1, fontSize: 12, color: colors.text },
  evPhoto: { width: 80, height: 80, marginRight: 6, borderWidth: 1, borderColor: colors.border },
  actionBar: {
    position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row",
    borderTopWidth: 1, borderTopColor: colors.borderStrong, backgroundColor: colors.bg,
  },
  pendingBar: {
    position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: 8,
    alignItems: "center", justifyContent: "center", paddingVertical: 22,
    borderTopWidth: 1, borderTopColor: colors.borderStrong, backgroundColor: colors.bgMuted,
  },
  pendingBarText: { fontSize: 13, fontWeight: "800", color: colors.text, letterSpacing: 0.5 },
  action: { flex: 1, paddingVertical: 22, alignItems: "center", justifyContent: "center", minHeight: 64 },
  actionText: { fontSize: 14, fontWeight: "900", letterSpacing: 3 },
  kmBox: {
    borderWidth: 2, borderColor: colors.stopped, backgroundColor: "#FEF2F2",
    padding: spacing.md, marginBottom: spacing.md,
  },
  kmLabel: { fontSize: 12, letterSpacing: 1.5, fontWeight: "900", color: colors.stopped, marginBottom: 8 },
  kmInput: {
    borderWidth: 2, borderColor: colors.stopped, backgroundColor: colors.bg,
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 22, fontWeight: "900",
    color: colors.text, textAlign: "center", letterSpacing: 2, minHeight: 52,
  },
  kmHint: { fontSize: 11, color: colors.stopped, marginTop: 6, fontWeight: "600" },
  libBox: {
    borderWidth: 2, borderColor: colors.stopped, backgroundColor: "#FEF2F2",
    padding: spacing.md, marginBottom: spacing.md,
  },
  libBoxOk: { borderColor: colors.active, backgroundColor: colors.bgMuted },
  libLabel: { fontSize: 12, letterSpacing: 1.5, fontWeight: "900", color: colors.stopped, marginBottom: 8 },
  libLabelOk: { color: colors.active },
  libHint: { fontSize: 11, color: colors.stopped, marginBottom: 10, fontWeight: "600" },
  libPreview: {
    width: "100%", height: 170, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  libRifaiBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: 10, paddingVertical: 10, borderWidth: 1, borderColor: colors.borderStrong,
  },
  libRifaiText: { fontSize: 12, fontWeight: "900", letterSpacing: 1, color: colors.text },
  oreBox: {
    borderWidth: 2, borderColor: colors.text, backgroundColor: colors.bgMuted,
    padding: spacing.md, marginBottom: spacing.md,
  },
  oreLabel: { fontSize: 12, letterSpacing: 1.5, fontWeight: "900", color: colors.text, marginBottom: 10 },
  oreLoading: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 },
  oreLoadingText: { fontSize: 13, color: colors.textSecondary },
  oreInputsRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  oreInput: {
    borderWidth: 2, borderColor: colors.borderStrong, backgroundColor: colors.bg,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 24, fontWeight: "900",
    color: colors.text, textAlign: "center", minWidth: 76, minHeight: 56,
  },
  oreUnit: { fontSize: 18, fontWeight: "900", color: colors.textSecondary },
  oreFonteBox: {
    marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border,
  },
  oreFonteTitolo: { fontSize: 11, letterSpacing: 1, fontWeight: "800", color: colors.textSecondary },
  oreCitazione: { fontSize: 14, fontStyle: "italic", color: colors.text, marginTop: 4 },
  oreDettaglio: { fontSize: 12, color: colors.textSecondary, marginTop: 6 },
  oreTimbri: { fontSize: 12, color: colors.textSecondary, marginTop: 6 },
  oreHint: { fontSize: 11, color: colors.text, marginTop: 10, fontWeight: "700" },
  kmDeferBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    marginTop: spacing.md, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.bg,
  },
  kmDeferBtnText: { fontSize: 12, fontWeight: "900", letterSpacing: 1, color: colors.text },
  kmDeferInput: {
    borderWidth: 2, borderColor: colors.stopped, backgroundColor: colors.bg,
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, color: colors.text, minHeight: 48,
    marginTop: 8,
  },
  kmDoneBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgMuted,
    padding: spacing.md, marginBottom: spacing.md,
  },
  kmDoneText: { fontSize: 13, fontWeight: "700", color: colors.text },
  kmCard: { margin: spacing.lg, marginTop: 0, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgMuted },
  kmCardRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 3 },
  kmCardValue: { fontSize: 20, fontWeight: "900", color: colors.text, letterSpacing: 0.5 },
  kmCardMissing: { fontSize: 13, color: colors.textSecondary, fontStyle: "italic" },
  kmFixInput: {
    borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.bg,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 18, fontWeight: "900",
    color: colors.text, textAlign: "center", letterSpacing: 1, minHeight: 48, marginBottom: 8,
  },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "90%" },
  modalHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: 16, fontWeight: "900", letterSpacing: 2 },
  textarea: {
    borderWidth: 1, borderColor: colors.borderStrong, padding: spacing.md, minHeight: 100,
    fontSize: 15, color: colors.text, textAlignVertical: "top", marginTop: 6,
  },
  photoRow: { flexDirection: "row", gap: spacing.sm, marginTop: 6 },
  photoBtn: {
    flex: 1, borderWidth: 1, borderColor: colors.border, paddingVertical: 14, alignItems: "center",
    flexDirection: "row", justifyContent: "center", gap: 8,
  },
  photoBtnText: { fontSize: 12, fontWeight: "800", letterSpacing: 1.5, color: colors.text },
  thumbWrap: { marginRight: 6, position: "relative" },
  thumb: { width: 80, height: 80, borderWidth: 1, borderColor: colors.border },
  thumbRemove: { position: "absolute", top: 4, right: 4, backgroundColor: colors.stopped, width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  submitBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center" },
  submitText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
