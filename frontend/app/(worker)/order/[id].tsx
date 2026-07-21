import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Modal,
  TextInput, KeyboardAvoidingView, Platform, Image, Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api, WorkEvent, WorkOrder, EventType } from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { VoiceChat } from "@/src/components/VoiceChat";
import { VehicleHistory } from "@/src/components/VehicleHistory";
import { PhotoArchive } from "@/src/components/PhotoArchive";
import { OrderMessages } from "@/src/components/OrderMessages";
import { colors, spacing } from "@/src/theme";

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState<null | EventType>(null);
  const [reason, setReason] = useState("");
  const [km, setKm] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);

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

  const lastEvent = events[events.length - 1];
  const isPending = order?.status === "pending";
  const canStart = !isPending && !lastEvent;
  const canReopen = !isPending && !!lastEvent && lastEvent.type === "COMPLETE";
  const canPause = lastEvent && (lastEvent.type === "START" || lastEvent.type === "RESUME");
  const canResume = lastEvent && lastEvent.type === "PAUSE";
  const canComplete = lastEvent && lastEvent.type !== "COMPLETE";

  const openAction = (t: EventType) => {
    setReason("");
    setKm("");
    setPhotos([]);
    setModalOpen(t);
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
    if (modalOpen === "START" && !km.replace(/[^0-9]/g, "")) {
      showAlert("KM OBBLIGATORI", "Inserisci i chilometri del veicolo: senza km non puoi iniziare il lavoro.");
      return;
    }
    if ((modalOpen === "PAUSE" || modalOpen === "COMPLETE") && !reason.trim()) {
      showAlert("Motivo richiesto", `Inserisci un motivo per ${modalOpen === "PAUSE" ? "la sospensione" : "il completamento"}.`);
      return;
    }
    setSubmitting(true);
    try {
      await api<WorkEvent>(`/work-orders/${order.id}/events`, {
        method: "POST",
        body: { type: modalOpen, reason: reason.trim() || null, photos_base64: photos, km: modalOpen === "START" ? km : null },
      });
      setModalOpen(null);
      await load();
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile salvare");
    } finally { setSubmitting(false); }
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

        {/* AI Voice Chat + Scheda Tecnica */}
        <VehicleHistory orderId={order.id} />

        <VoiceChat orderId={order.id} />

        <PhotoArchive orderId={order.id} canUpload />

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
      {isPending ? (
        <View style={styles.pendingBar}>
          <Ionicons name="time-outline" size={18} color={colors.text} />
          <Text style={styles.pendingBarText}>In attesa di approvazione dal titolare</Text>
        </View>
      ) : (
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
      )}

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
              {modalOpen === "START" && (
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
                  <Text style={styles.kmHint}>Leggi il contachilometri: senza km non puoi iniziare.</Text>
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
  };
  const labelMap: Record<string, string> = { START: "INIZIO", RESUME: "RIPRESA", PAUSE: "PAUSA", COMPLETE: "COMPLETATO" };
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
