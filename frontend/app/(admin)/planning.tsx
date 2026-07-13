import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api } from "@/src/api/client";
import { colors, spacing } from "@/src/theme";

type Appuntamento = {
  giorno: string;
  ora?: string;
  ora_fine?: string;
  ponte?: string;
  targa?: string;
  cliente?: string;
  nota?: string;
};

type Planning = {
  aggiornato?: string | null;
  giorni_coperti?: number | null;
  appuntamenti: Appuntamento[];
  received_at: string;
};

const GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];

export default function PlanningAdmin() {
  const router = useRouter();
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notReady, setNotReady] = useState(false);

  const load = useCallback(async () => {
    try {
      setPlanning(await api<Planning>("/planning"));
      setNotReady(false);
    } catch (e: any) {
      if (String(e?.message || "").includes("non ancora")) setNotReady(true);
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const fmtGiorno = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    const label = `${GIORNI[d.getDay()]} ${d.getDate()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
    const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - oggi.getTime()) / 86400000);
    if (diff === 0) return `OGGI — ${label}`;
    if (diff === 1) return `DOMANI — ${label}`;
    return label.toUpperCase();
  };

  const fmtReceived = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
  };

  // raggruppa per giorno, ordina per giorno e ora
  const byDay: Record<string, Appuntamento[]> = {};
  for (const a of planning?.appuntamenti || []) {
    (byDay[a.giorno] = byDay[a.giorno] || []).push(a);
  }
  const days = Object.keys(byDay).sort();
  for (const d of days) byDay[d].sort((x, y) => (x.ora || "").localeCompare(y.ora || ""));

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>DA STAR · SOLA LETTURA</Text>
          <Text style={styles.title}>PLANNING OFFICINA</Text>
        </View>
      </View>

      {planning && (
        <Text style={styles.updated}>
          Aggiornato da Omnius: {fmtReceived(planning.received_at)}
          {planning.giorni_coperti ? ` · prossimi ${planning.giorni_coperti} giorni` : ""}
        </Text>
      )}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : notReady ? (
        <View style={styles.emptyBox}>
          <Ionicons name="hourglass-outline" size={28} color={colors.textSecondary} />
          <Text style={styles.emptyText}>
            Planning non ancora arrivato da Omnius.{"\n"}Il fattorino passa ogni 5 minuti: riprova tra poco.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {days.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>Nessun appuntamento nei prossimi giorni.</Text>
            </View>
          ) : days.map((day) => (
            <View key={day} style={{ marginBottom: spacing.md }}>
              <Text style={styles.dayLabel}>{fmtGiorno(day)}</Text>
              {byDay[day].map((a, i) => (
                <View key={i} testID={`planning-item-${day}-${i}`} style={styles.card}>
                  <View style={styles.cardLeft}>
                    <Text style={styles.ora}>{a.ora || "—"}</Text>
                    {a.ora_fine ? <Text style={styles.oraFine}>{a.ora_fine}</Text> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.cardTop}>
                      <Text style={styles.targa}>{a.targa || "—"}</Text>
                      {a.ponte ? (
                        <View style={styles.pontePill}>
                          <Text style={styles.ponteText}>{a.ponte}</Text>
                        </View>
                      ) : null}
                    </View>
                    {a.cliente ? <Text style={styles.cliente}>{a.cliente}</Text> : null}
                    {a.nota ? <Text style={styles.nota}>{a.nota}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", alignItems: "center",
  },
  backBtn: { padding: 4 },
  headerLabel: { fontSize: 10, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  updated: {
    fontSize: 11, color: colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyBox: { margin: spacing.lg, padding: spacing.xl, borderWidth: 1, borderColor: colors.border, alignItems: "center", gap: 10 },
  emptyText: { color: colors.textSecondary, textAlign: "center", lineHeight: 20 },
  dayLabel: {
    fontSize: 12, letterSpacing: 2, fontWeight: "900", color: colors.text,
    borderBottomWidth: 2, borderBottomColor: colors.text, paddingBottom: 4, marginBottom: spacing.sm,
  },
  card: {
    flexDirection: "row", gap: 12, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: 6,
  },
  cardLeft: { width: 52, alignItems: "center" },
  ora: { fontSize: 15, fontWeight: "900", color: colors.text },
  oraFine: { fontSize: 11, color: colors.textSecondary },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  targa: { fontSize: 16, fontWeight: "900", color: colors.text },
  pontePill: { backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 2 },
  ponteText: { color: colors.textInverse, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  cliente: { fontSize: 13, color: colors.text, marginTop: 2, fontWeight: "600" },
  nota: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
});
