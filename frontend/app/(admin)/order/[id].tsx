import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, WorkOrder, WorkEvent } from "@/src/api/client";
import { VoiceChat } from "@/src/components/VoiceChat";
import { VehicleHistory } from "@/src/components/VehicleHistory";
import { PhotoArchive } from "@/src/components/PhotoArchive";
import { OrderMessages } from "@/src/components/OrderMessages";
import { colors, spacing } from "@/src/theme";

const statusMap: Record<string, { c: string; label: string }> = {
  pending: { c: colors.paused, label: "IN ATTESA" },
  open: { c: colors.idle, label: "APERTA" },
  in_progress: { c: colors.active, label: "IN CORSO" },
  paused: { c: colors.paused, label: "IN PAUSA" },
  completed: { c: colors.textSecondary, label: "COMPLETATA" },
};

export default function AdminOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [o, ev] = await Promise.all([
        api<WorkOrder>(`/work-orders/${id}`),
        api<WorkEvent[]>(`/work-orders/${id}/events`),
      ]);
      setOrder(o);
      setEvents(ev);
    } catch { /* ignore */ }
    finally { setLoading(false); setRefreshing(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading || !order) return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;
  const s = statusMap[order.status];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="admin-back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>COMMESSA</Text>
          <Text style={styles.headerTitle}>{order.plate}</Text>
        </View>
        <View style={[styles.pill, { backgroundColor: s.c }]}>
          <Text style={styles.pillText}>{s.label}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* Le ore per prime: sono quelle che finiscono in fattura */}
        {(() => {
          const timbri = order.minutes_calculated ?? 0;
          const fattura = order.minutes_effective ?? timbri;
          const confermate = order.minutes_effective != null;
          const scostamento = confermate && Math.abs(fattura - timbri) > 30;
          return (
            <View style={styles.oreCard}>
              <Text style={styles.oreLabel}>ORE DA FATTURARE</Text>
              <View style={styles.oreMain}>
                <Text style={styles.oreBig}>{fmtMin(fattura)}</Text>
                <View style={[styles.oreStato, confermate ? styles.oreStatoOk : styles.oreStatoNo]}>
                  <Ionicons
                    name={confermate ? "checkmark-circle" : "alert-circle"}
                    size={14}
                    color={colors.textInverse}
                  />
                  <Text style={styles.oreStatoText}>
                    {confermate ? "CONFERMATE DAL MECCANICO" : "SOLO TIMBRI — NON CONFERMATE"}
                  </Text>
                </View>
              </View>
              <View style={styles.oreRow}>
                <Text style={styles.oreRowLabel}>Dai timbri</Text>
                <Text style={[styles.oreRowVal, scostamento && styles.oreRowValDiff]}>{fmtMin(timbri)}</Text>
              </View>
              {order.minutes_effective_reason ? (
                <Text style={styles.oreMotivo}>{order.minutes_effective_reason}</Text>
              ) : null}
              {scostamento ? (
                <Text style={styles.oreAvviso}>
                  Il meccanico ha corretto di {fmtMin(Math.abs(fattura - timbri))} rispetto ai timbri.
                </Text>
              ) : null}
              {!confermate && order.status === "completed" ? (
                <Text style={styles.oreAvviso}>
                  Chiusa prima che le ore fossero obbligatorie: questo numero viene dai timbri, controllalo.
                </Text>
              ) : null}
            </View>
          );
        })()}

        <View style={styles.detailsCard}>
          <Row label="VEICOLO" value={order.vehicle} />
          <Row label="CLIENTE" value={order.customer} />
          {order.vin ? <Row label="VIN" value={order.vin} /> : null}
          <View style={{ marginTop: spacing.md }}>
            <Text style={styles.rowLabel}>LAVORAZIONE</Text>
            <Text style={styles.desc}>{order.description}</Text>
          </View>
        </View>

        <VehicleHistory orderId={order.id} />

        <VoiceChat orderId={order.id} readOnly />

        <PhotoArchive orderId={order.id} canDelete />

        <OrderMessages orderId={order.id} />

        <Text style={styles.section}>TIMELINE EVENTI</Text>
        {events.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>Nessun evento.</Text></View>
        ) : (
          events.map((e) => <TimelineItem key={e.id} ev={e} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function fmtMin(m: number) {
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ marginTop: 6 }}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
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
            {ev.photos_base64.map((p, i) => <Image key={i} source={{ uri: p }} style={styles.evPhoto} />)}
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
  oreCard: {
    margin: spacing.lg, marginBottom: 0, padding: spacing.lg,
    borderWidth: 2, borderColor: colors.text, backgroundColor: colors.bgMuted,
  },
  oreLabel: { fontSize: 11, letterSpacing: 2, fontWeight: "900", color: colors.textSecondary },
  oreMain: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 4 },
  oreBig: { fontSize: 34, fontWeight: "900", color: colors.text, letterSpacing: -1 },
  oreStato: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4 },
  oreStatoOk: { backgroundColor: colors.active },
  oreStatoNo: { backgroundColor: colors.stopped },
  oreStatoText: { color: colors.textInverse, fontSize: 9, fontWeight: "900", letterSpacing: 0.5 },
  oreRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border,
  },
  oreRowLabel: { fontSize: 13, color: colors.textSecondary },
  oreRowVal: { fontSize: 15, fontWeight: "800", color: colors.textSecondary },
  oreRowValDiff: { color: colors.stopped, textDecorationLine: "line-through" },
  oreMotivo: { fontSize: 12, color: colors.textSecondary, fontStyle: "italic", marginTop: 6 },
  oreAvviso: { fontSize: 12, color: colors.stopped, fontWeight: "700", marginTop: 6 },
  detailsCard: { margin: spacing.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  rowLabel: { fontSize: 10, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  rowValue: { fontSize: 16, color: colors.text, marginTop: 2, fontWeight: "600" },
  desc: { fontSize: 14, color: colors.text, marginTop: 4, lineHeight: 20 },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.sm, fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  empty: { marginHorizontal: spacing.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary, fontSize: 13 },
  tlItem: { flexDirection: "row", marginHorizontal: spacing.lg, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  tlLeft: { width: 72 },
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
});
