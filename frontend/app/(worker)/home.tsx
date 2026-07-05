import { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, LiveStatus, WorkOrder } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { colors, spacing } from "@/src/theme";

type MyState = {
  status: "working" | "paused" | "idle";
  order?: WorkOrder | null;
  since?: string | null;
  minutes?: number | null;
};

export default function WorkerHome() {
  const { user } = useAuth();
  const router = useRouter();
  const [myState, setMyState] = useState<MyState>({ status: "idle" });
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const list = await api<WorkOrder[]>("/work-orders");
      setOrders(list);

      // Determine my current state client-side by fetching last event from each of my orders
      // Simpler: iterate my orders in-progress/paused; check events
      let current: MyState = { status: "idle" };
      // Prefer orders in_progress or paused
      const priority = list.filter((o) => o.status === "in_progress" || o.status === "paused");
      for (const o of priority) {
        const events = await api<any[]>(`/work-orders/${o.id}/events`);
        const myEvents = events.filter((e) => e.worker_id === user.id);
        if (!myEvents.length) continue;
        const last = myEvents[myEvents.length - 1];
        if (last.type === "COMPLETE") continue;
        const status = last.type === "PAUSE" ? "paused" : "working";
        const since = last.timestamp;
        const minutes = Math.floor((Date.now() - new Date(since).getTime()) / 60000);
        current = { status, order: o, since, minutes };
        break;
      }
      setMyState(current);
    } catch (e) {
      console.warn("load home", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    const t = setInterval(() => {
      // just tick minutes display
      setMyState((s) => ({ ...s, minutes: s.since ? Math.floor((Date.now() - new Date(s.since).getTime()) / 60000) : s.minutes }));
    }, 30000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;
  }

  const statusColor = myState.status === "working" ? colors.active : myState.status === "paused" ? colors.paused : colors.idle;
  const statusLabel = myState.status === "working" ? "AL LAVORO" : myState.status === "paused" ? "IN PAUSA" : "LIBERO";

  const activeOrders = orders.filter((o) => o.status !== "completed");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.hello}>CIAO</Text>
            <Text testID="worker-fullname" style={styles.name}>{user?.full_name || ""}</Text>
          </View>
          <View testID="worker-status-badge" style={[styles.badge, { borderColor: statusColor }]}>
            <View style={[styles.dot, { backgroundColor: statusColor }]} />
            <Text style={[styles.badgeText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>

        {/* Current job */}
        {myState.order ? (
          <TouchableOpacity
            testID="current-job-card"
            style={styles.currentJob}
            onPress={() => router.push(`/(worker)/order/${myState.order!.id}` as any)}
            activeOpacity={0.85}
          >
            <Text style={styles.currentLabel}>IN CORSO</Text>
            <Text style={styles.currentTitle}>{myState.order.plate}</Text>
            <Text style={styles.currentVehicle}>{myState.order.vehicle}</Text>
            <View style={styles.currentMeta}>
              <Text style={styles.currentMetaText}>Cliente: {myState.order.customer}</Text>
              {myState.minutes != null ? (
                <Text style={styles.currentMetaText}>{myState.minutes} min</Text>
              ) : null}
            </View>
            <View style={styles.arrowRow}>
              <Text style={styles.arrowText}>APRI COMMESSA</Text>
              <Ionicons name="arrow-forward" size={16} color={colors.textInverse} />
            </View>
          </TouchableOpacity>
        ) : (
          <View style={styles.emptyCurrent}>
            <Text style={styles.emptyTitle}>Nessun lavoro attivo</Text>
            <Text style={styles.emptyText}>Seleziona una commessa qui sotto per iniziare.</Text>
          </View>
        )}

        {/* Assigned orders */}
        <Text style={styles.sectionLabel}>LE MIE COMMESSE</Text>
        {activeOrders.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>Nessuna commessa assegnata.</Text>
          </View>
        ) : (
          activeOrders.map((o) => <OrderCard key={o.id} order={o} onPress={() => router.push(`/(worker)/order/${o.id}` as any)} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function OrderCard({ order, onPress }: { order: WorkOrder; onPress: () => void }) {
  const statusMap: Record<string, { c: string; label: string }> = {
    open: { c: colors.idle, label: "APERTA" },
    in_progress: { c: colors.active, label: "IN CORSO" },
    paused: { c: colors.paused, label: "IN PAUSA" },
    completed: { c: colors.textSecondary, label: "COMPLETATA" },
  };
  const s = statusMap[order.status];
  return (
    <TouchableOpacity testID={`order-card-${order.id}`} style={styles.orderCard} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.orderRow}>
        <Text style={styles.orderPlate}>{order.plate}</Text>
        <View style={[styles.statusPill, { backgroundColor: s.c }]}>
          <Text style={styles.statusPillText}>{s.label}</Text>
        </View>
      </View>
      <Text style={styles.orderVehicle}>{order.vehicle}</Text>
      <Text style={styles.orderCustomer}>Cliente: {order.customer}</Text>
      <Text style={styles.orderDesc} numberOfLines={2}>{order.description}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start",
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  hello: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  name: { fontSize: 26, fontWeight: "900", color: colors.text, marginTop: 2 },
  badge: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingVertical: 8,
    borderWidth: 2, gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badgeText: { fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  currentJob: {
    margin: spacing.lg, padding: spacing.lg, backgroundColor: colors.text,
  },
  currentLabel: { fontSize: 11, letterSpacing: 3, color: "#A1A1AA", fontWeight: "700" },
  currentTitle: { fontSize: 34, fontWeight: "900", color: colors.textInverse, marginTop: 4, letterSpacing: -1 },
  currentVehicle: { fontSize: 16, color: "#D4D4D8", marginTop: 2, fontWeight: "500" },
  currentMeta: {
    flexDirection: "row", justifyContent: "space-between", marginTop: spacing.md,
    paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: "#3F3F46",
  },
  currentMetaText: { color: "#D4D4D8", fontSize: 13 },
  arrowRow: {
    marginTop: spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: "#3F3F46",
  },
  arrowText: { color: colors.textInverse, fontWeight: "900", fontSize: 13, letterSpacing: 2 },
  emptyCurrent: {
    margin: spacing.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border,
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  emptyText: { color: colors.textSecondary, marginTop: 4, fontSize: 14 },
  sectionLabel: {
    marginTop: spacing.md, marginHorizontal: spacing.lg,
    fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700",
    marginBottom: spacing.sm,
  },
  emptyBox: { marginHorizontal: spacing.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
  orderCard: {
    marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  orderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  orderPlate: { fontSize: 20, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4 },
  statusPillText: { color: colors.textInverse, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  orderVehicle: { fontSize: 14, color: colors.text, marginTop: 6, fontWeight: "600" },
  orderCustomer: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  orderDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 6 },
});
