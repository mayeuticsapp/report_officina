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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ marginTop: 6 }}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function TimelineItem({ ev }: { ev: WorkEvent }) {
  const colorMap: Record<string, string> = { START: colors.active, RESUME: colors.active, PAUSE: colors.paused, COMPLETE: colors.text };
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
  tlReason: { fontSize: 13, color: colors.textSecondary, marginTop: 4, fontStyle: "italic" },
  aiBox: { marginTop: 8, padding: 8, backgroundColor: colors.bgMuted, flexDirection: "row", gap: 8 },
  aiLabel: { fontSize: 10, fontWeight: "900", letterSpacing: 2, color: colors.primary },
  aiText: { flex: 1, fontSize: 12, color: colors.text },
  evPhoto: { width: 80, height: 80, marginRight: 6, borderWidth: 1, borderColor: colors.border },
});
