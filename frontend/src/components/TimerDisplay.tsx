import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { colors, spacing } from "@/src/theme";
import type { WorkEvent } from "@/src/api/client";

type Props = {
  events: WorkEvent[];
  status: string;
};

export function TimerDisplay({ events, status }: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const calcElapsed = () => {
      // Ordina gli eventi per timestamp
      const sorted = [...events].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      let total = 0;
      let inProgress = false;
      let lastStart: Date | null = null;

      for (const e of sorted) {
        const ts = new Date(e.timestamp);
        if (e.type === "START" || e.type === "RESUME") {
          lastStart = ts;
          inProgress = true;
        } else if (e.type === "PAUSE") {
          if (inProgress && lastStart) {
            total += Math.floor((ts.getTime() - lastStart.getTime()) / 1000 / 60);
            inProgress = false;
            lastStart = null;
          }
        } else if (e.type === "COMPLETE") {
          if (inProgress && lastStart) {
            total += Math.floor((ts.getTime() - lastStart.getTime()) / 1000 / 60);
            inProgress = false;
            lastStart = null;
          }
        }
      }

      // Se ancora in progress, aggiungi il tempo dalla last start a ora
      if (inProgress && lastStart && status === "in_progress") {
        const now = new Date();
        total += Math.floor((now.getTime() - lastStart.getTime()) / 1000 / 60);
      }

      setElapsed(total);
    };

    calcElapsed();

    // Aggiorna ogni secondo se in progress o paused
    if (status === "in_progress" || status === "paused") {
      const iv = setInterval(calcElapsed, 1000);
      return () => clearInterval(iv);
    }
  }, [events, status]);

  const h = Math.floor(elapsed / 60);
  const m = elapsed % 60;
  const display = h > 0 ? `${h}h ${m}m` : `${m}m`;

  const bgColor = status === "in_progress" ? colors.active : colors.paused;
  const label =
    status === "in_progress"
      ? "IN CORSO"
      : status === "paused"
        ? "PAUSO"
        : "COMPLETATO";

  return (
    <View style={styles.container}>
      <View style={[styles.card, { borderLeftColor: bgColor }]}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.time}>{display}</Text>
        <Text style={styles.sublabel}>PASSATI</Text>
      </View>
    </View>
  );
}

const styles = {
  container: {
    marginBottom: spacing.lg,
  },
  card: {
    borderLeftWidth: 6,
    paddingLeft: spacing.md,
    paddingVertical: spacing.lg,
    backgroundColor: colors.bg,
    borderRadius: 4,
  },
  label: {
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: 900 as any,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  time: {
    fontSize: 42,
    fontWeight: 900 as any,
    color: colors.text,
    letterSpacing: -1,
  },
  sublabel: {
    fontSize: 10,
    letterSpacing: 1.5,
    color: colors.textSecondary,
    marginTop: 4,
    fontWeight: 700 as any,
  },
};
