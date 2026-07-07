import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api, WorkOrder, proposeWorkOrder } from "@/src/api/client";
import { showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

const statusMap: Record<string, { c: string; label: string }> = {
  pending: { c: colors.paused, label: "IN ATTESA" },
  open: { c: colors.idle, label: "APERTA" },
  in_progress: { c: colors.active, label: "IN CORSO" },
  paused: { c: colors.paused, label: "IN PAUSA" },
  completed: { c: colors.textSecondary, label: "COMPLETATA" },
};

const EMPTY_FORM = { plate: "", vin: "", customer: "", vehicle: "", description: "" };

export default function WorkerOrders() {
  const router = useRouter();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "completed">("active");
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api<WorkOrder[]>("/work-orders");
      setOrders(list);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = orders.filter((o) => {
    if (filter === "all") return true;
    if (filter === "completed") return o.status === "completed";
    return o.status !== "completed";
  });

  const openNew = () => { setForm(EMPTY_FORM); setModalOpen(true); };

  const submitPropose = async () => {
    if (!form.plate.trim() || !form.customer.trim() || !form.vehicle.trim()) {
      showAlert("Campi obbligatori", "Targa, cliente e veicolo sono richiesti");
      return;
    }
    setSubmitting(true);
    try {
      await proposeWorkOrder({
        plate: form.plate.trim().toUpperCase(),
        vin: form.vin.trim() || undefined,
        customer: form.customer.trim(),
        vehicle: form.vehicle.trim(),
        description: form.description.trim(),
      });
      setModalOpen(false);
      await load();
      showAlert("Inviata", "La commessa è stata inviata al titolare per l'approvazione.");
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile inviare la commessa");
    } finally { setSubmitting(false); }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>COMMESSE</Text>
        <TouchableOpacity testID="btn-propose-order" style={styles.addBtn} onPress={openNew}>
          <Ionicons name="add" size={20} color={colors.textInverse} />
          <Text style={styles.addBtnText}>NUOVA</Text>
        </TouchableOpacity>
      </View>

      {/* Filter chips - horizontal row */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        style={styles.chipScroller}
      >
        {(["active", "all", "completed"] as const).map((f) => (
          <TouchableOpacity
            key={f}
            testID={`filter-chip-${f}`}
            style={[styles.chip, filter === f && styles.chipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
              {f === "active" ? "ATTIVE" : f === "all" ? "TUTTE" : "COMPLETATE"}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {filtered.length === 0 ? (
            <View style={styles.empty}><Text style={styles.emptyText}>Nessuna commessa</Text></View>
          ) : (
            filtered.map((o) => {
              const s = statusMap[o.status];
              return (
                <TouchableOpacity
                  key={o.id}
                  testID={`orders-list-item-${o.id}`}
                  style={styles.card}
                  onPress={() => router.push(`/(worker)/order/${o.id}` as any)}
                  activeOpacity={0.85}
                >
                  <View style={styles.cardRow}>
                    <Text style={styles.plate}>{o.plate}</Text>
                    <View style={[styles.pill, { backgroundColor: s.c }]}>
                      <Text style={styles.pillText}>{s.label}</Text>
                    </View>
                  </View>
                  <Text style={styles.vehicle}>{o.vehicle}</Text>
                  <Text style={styles.customer}>Cliente: {o.customer}</Text>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Nuova commessa (in attesa di approvazione) */}
      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>NUOVA COMMESSA</Text>
              <TouchableOpacity onPress={() => setModalOpen(false)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
            </View>
            <Text style={styles.mHint}>Verrà inviata al titolare, che dovrà approvarla prima che tu possa iniziare a lavorarci.</Text>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>TARGA</Text>
              <TextInput testID="input-propose-plate" style={styles.input} value={form.plate} onChangeText={(v) => setForm({ ...form, plate: v })} autoCapitalize="characters" />

              <Text style={[styles.label, { marginTop: spacing.md }]}>VIN (facoltativo)</Text>
              <TextInput testID="input-propose-vin" style={styles.input} value={form.vin} onChangeText={(v) => setForm({ ...form, vin: v })} autoCapitalize="characters" />

              <Text style={[styles.label, { marginTop: spacing.md }]}>CLIENTE</Text>
              <TextInput testID="input-propose-customer" style={styles.input} value={form.customer} onChangeText={(v) => setForm({ ...form, customer: v })} />

              <Text style={[styles.label, { marginTop: spacing.md }]}>VEICOLO</Text>
              <TextInput testID="input-propose-vehicle" style={styles.input} value={form.vehicle} onChangeText={(v) => setForm({ ...form, vehicle: v })} placeholder="es. BMW 320d 2018" placeholderTextColor={colors.textSecondary} />

              <Text style={[styles.label, { marginTop: spacing.md }]}>LAVORAZIONE</Text>
              <TextInput
                testID="input-propose-description" style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} multiline
                placeholder="Cosa devi fare su questa macchina"
                placeholderTextColor={colors.textSecondary}
              />
            </ScrollView>
            <View style={{ padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border }}>
              <TouchableOpacity testID="btn-submit-propose" style={[styles.saveBtn, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={submitPropose}>
                {submitting ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.saveText}>INVIA AL TITOLARE</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  title: { fontSize: 28, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.text, paddingHorizontal: 14, paddingVertical: 12 },
  addBtnText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 2, fontSize: 12 },
  chipScroller: { maxHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border },
  chipRow: { paddingHorizontal: spacing.lg, gap: 8, alignItems: "center", paddingVertical: 10 },
  chip: {
    flexShrink: 0, height: 36, paddingHorizontal: 14, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  chipActive: { borderColor: colors.text, backgroundColor: colors.text },
  chipText: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, color: colors.textSecondary },
  chipTextActive: { color: colors.textInverse },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary },
  card: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  plate: { fontSize: 20, fontWeight: "900", color: colors.text },
  pill: { paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { color: colors.textInverse, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  vehicle: { fontSize: 14, color: colors.text, marginTop: 6, fontWeight: "600" },
  customer: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "92%" },
  mHeader: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mTitle: { fontSize: 16, fontWeight: "900", letterSpacing: 2 },
  mHint: { fontSize: 12, color: colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  label: { fontSize: 11, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  input: { borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, marginTop: 6, minHeight: 48 },
  saveBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center" },
  saveText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
