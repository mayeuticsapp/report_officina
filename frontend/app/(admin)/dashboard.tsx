import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { api, LiveStatus, WorkEvent } from "@/src/api/client";
import { colors, spacing } from "@/src/theme";

export default function Dashboard() {
  const router = useRouter();
  const [live, setLive] = useState<LiveStatus[]>([]);
  const [recent, setRecent] = useState<WorkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [ls, ev] = await Promise.all([
        api<LiveStatus[]>("/workers/live-status"),
        api<WorkEvent[]>("/events/recent?limit=20"),
      ]);
      setLive(ls);
      setRecent(ev);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    const t = setInterval(() => { load(); setTick((x) => x + 1); }, 15000);
    return () => clearInterval(t);
  }, [load]);

  const working = live.filter((w) => w.current_status === "working").length;
  const paused = live.filter((w) => w.current_status === "paused").length;
  const idle = live.filter((w) => w.current_status === "idle").length;

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.header, { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }]}>
        <View>
          <Text style={styles.headerLabel}>DASHBOARD</Text>
          <Text style={styles.headerTitle}>LIVE</Text>
        </View>
        <TouchableOpacity testID="btn-ask-ai" style={dashAskStyles.btn} onPress={() => router.push("/(admin)/ask" as any)}>
          <Ionicons name="sparkles" size={18} color={colors.textInverse} />
          <Text style={dashAskStyles.btnText}>CHIEDI ALL'AI</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        contentContainerStyle={{ paddingBottom: spacing.xl }}
      >
        {/* KPI grid */}
        <View style={styles.kpiRow}>
          <Kpi testID="kpi-working" value={working} label="AL LAVORO" color={colors.active} />
          <Kpi testID="kpi-paused" value={paused} label="IN PAUSA" color={colors.paused} textDark />
          <Kpi testID="kpi-idle" value={idle} label="LIBERI" color={colors.idle} />
        </View>

        {/* Workers live */}
        <Text style={styles.sectionLabel}>OPERAI IN TEMPO REALE</Text>
        {live.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>Nessun operaio registrato. Aggiungili dal tab Operai.</Text></View>
        ) : (
          live.map((w) => <LiveRow key={w.worker_id} w={w} />)
        )}

        {/* Recent events */}
        <Text style={styles.sectionLabel}>EVENTI RECENTI</Text>
        {recent.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>Nessun evento registrato.</Text></View>
        ) : (
          recent.map((e) => <RecentRow key={e.id} e={e} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Kpi({ testID, value, label, color, textDark }: { testID: string; value: number; label: string; color: string; textDark?: boolean }) {
  return (
    <View testID={testID} style={[styles.kpi, { backgroundColor: color }]}>
      <Text style={[styles.kpiValue, { color: textDark ? colors.text : colors.textInverse }]}>{value}</Text>
      <Text style={[styles.kpiLabel, { color: textDark ? colors.text : colors.textInverse }]}>{label}</Text>
    </View>
  );
}

function LiveRow({ w }: { w: LiveStatus }) {
  const cMap = { working: colors.active, paused: colors.paused, idle: colors.idle };
  const labelMap = { working: "AL LAVORO", paused: "IN PAUSA", idle: "LIBERO" };
  const alert = (w.current_status === "paused" && (w.minutes_since || 0) > 30);
  return (
    <View testID={`live-row-${w.worker_id}`} style={[styles.liveRow, alert && styles.liveRowAlert]}>
      <View style={styles.liveLeft}>
        <View style={[styles.liveDot, { backgroundColor: cMap[w.current_status] }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.liveName}>{w.full_name}</Text>
          <Text style={styles.liveSub}>{w.current_work_order_label || labelMap[w.current_status]}</Text>
          {w.last_reason ? <Text style={styles.liveReason} numberOfLines={1}>&ldquo;{w.last_reason}&rdquo;</Text> : null}
        </View>
      </View>
      <View style={styles.liveRight}>
        <Text style={[styles.liveStatus, { color: cMap[w.current_status] }]}>{labelMap[w.current_status]}</Text>
        {w.minutes_since != null ? <Text style={styles.liveMin}>{w.minutes_since} min</Text> : null}
        {alert ? <Text style={styles.alertBadge}>⚠ FERMO</Text> : null}
      </View>
    </View>
  );
}

function RecentRow({ e }: { e: WorkEvent }) {
  const time = new Date(e.timestamp).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  const cMap: Record<string, string> = { START: colors.active, RESUME: colors.active, PAUSE: colors.paused, COMPLETE: colors.text };
  return (
    <View style={styles.recentRow}>
      <Text style={styles.recentTime}>{time}</Text>
      <View style={[styles.recentPill, { backgroundColor: cMap[e.type] }]}>
        <Text style={styles.recentPillText}>{e.type}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.recentWorker}>{e.worker_full_name}</Text>
        {e.reason ? <Text style={styles.recentReason} numberOfLines={1}>{e.reason}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  headerTitle: { fontSize: 34, fontWeight: "900", color: colors.text, letterSpacing: -1, marginTop: 2 },
  kpiRow: { flexDirection: "row", padding: spacing.md, gap: spacing.sm },
  kpi: { flex: 1, padding: spacing.md, alignItems: "flex-start", minHeight: 100, justifyContent: "space-between" },
  kpiValue: { fontSize: 40, fontWeight: "900", letterSpacing: -1 },
  kpiLabel: { fontSize: 10, fontWeight: "800", letterSpacing: 2 },
  sectionLabel: {
    marginHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.sm,
    fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700",
  },
  empty: { marginHorizontal: spacing.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  emptyText: { color: colors.textSecondary, fontSize: 13 },
  liveRow: {
    marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center",
  },
  liveRowAlert: { borderColor: colors.stopped, borderWidth: 2 },
  liveLeft: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  liveDot: { width: 10, height: 10 },
  liveName: { fontSize: 15, fontWeight: "800", color: colors.text },
  liveSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  liveReason: { fontSize: 11, color: colors.textSecondary, fontStyle: "italic", marginTop: 2 },
  liveRight: { alignItems: "flex-end" },
  liveStatus: { fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  liveMin: { fontSize: 12, color: colors.text, fontWeight: "700", marginTop: 2 },
  alertBadge: { fontSize: 10, fontWeight: "900", color: colors.stopped, marginTop: 2, letterSpacing: 1 },
  recentRow: {
    marginHorizontal: spacing.lg, marginBottom: 6, padding: 10, flexDirection: "row",
    alignItems: "center", gap: 10, borderWidth: 1, borderColor: colors.border,
  },
  recentTime: { fontSize: 12, fontWeight: "800", color: colors.text, width: 44 },
  recentPill: { paddingHorizontal: 6, paddingVertical: 3 },
  recentPillText: { fontSize: 9, fontWeight: "900", color: colors.textInverse, letterSpacing: 1 },
  recentWorker: { fontSize: 13, fontWeight: "700", color: colors.text },
  recentReason: { fontSize: 11, color: colors.textSecondary, fontStyle: "italic" },
});

const dashAskStyles = StyleSheet.create({
  btn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 12,
  },
  btnText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 1.5, fontSize: 11 },
});
