import React, { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { Text } from "./components/AppText";
import * as FileSystem from "expo-file-system/legacy";
import {
  getLastQueryStats,
  subscribeQueryStats,
  QueryStats,
  getAppPeakRssBytes,
} from "../services/telemetry";
import { llamaEngine } from "../inference/LlamaEngine";
import { MODEL_CATALOG, RAM_BUDGET_BYTES, STORAGE_BUDGET_BYTES } from "../models/manifest";
import { ModelManager } from "../models/ModelManager";
import { getMemoryInfo, getDeviceTotalRamBytes } from "ram-monitor";
import { colors } from "./theme/colors";
import { typography } from "./theme/typography";
import { spacing, radii } from "./theme/spacing";

const modelManager = new ModelManager();

function formatGB(bytes: number): string {
  if (bytes <= 0) return "0.00 GB";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMB(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  if (bytes >= 1024 * 1024 * 1024) return formatGB(bytes);
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

interface StorageBreakdown {
  ggufBytes: number;
  corpusBytes: number;
  otherBytes: number;
  freeDeviceBytes: number;
  totalAppBytes: number;
}

/**
 * UsageStatsContent: Production-grade Hardware Telemetry & System Dashboard.
 * Accurately tracks real hardware metrics against bounty limits:
 * - App Process RSS (mmap'd GGUF resident memory) vs Device Total RAM vs 12GB Bounty Limit
 * - Segmented Disk Storage breakdown: Corpus Index vs GGUF Models vs Device Free Storage vs 50GB Cap
 * - Live inference speed, TTFT, token metrics, and engine configuration.
 */
export function UsageStatsContent() {
  const [stats, setStats] = useState<QueryStats | null>(getLastQueryStats());
  const [appRss, setAppRss] = useState(0);
  const [appPeakRss, setAppPeakRss] = useState(getAppPeakRssBytes());
  const [deviceTotalRam, setDeviceTotalRam] = useState(0);
  const [storage, setStorage] = useState<StorageBreakdown>({
    ggufBytes: 0,
    corpusBytes: 0,
    otherBytes: 0,
    freeDeviceBytes: 0,
    totalAppBytes: 0,
  });

  useEffect(() => subscribeQueryStats(setStats), []);

  useEffect(() => {
    let cancelled = false;

    async function pollTelemetry() {
      // Memory info
      try {
        const mem = getMemoryInfo();
        if (!cancelled && mem.rssBytes > 0) setAppRss(mem.rssBytes);
      } catch {
        // Native module not linked
      }
      if (!cancelled) setAppPeakRss(getAppPeakRssBytes());

      // Disk storage breakdown
      try {
        const statuses = await modelManager.statusAll();
        let gguf = 0;
        let corpus = 0;
        let other = 0;

        for (const s of statuses) {
          if (!s.present) continue;
          if (s.asset.kind === "llm") gguf += s.sizeOnDiskBytes;
          else if (s.asset.kind === "corpus") corpus += s.sizeOnDiskBytes;
          else other += s.sizeOnDiskBytes;
        }

        let freeBytes = 0;
        try {
          freeBytes = await FileSystem.getFreeDiskStorageAsync();
        } catch {
          freeBytes = 0;
        }

        if (!cancelled) {
          setStorage({
            ggufBytes: gguf,
            corpusBytes: corpus,
            otherBytes: other,
            freeDeviceBytes: freeBytes,
            totalAppBytes: gguf + corpus + other,
          });
        }
      } catch {
        // Storage poll failure fallback
      }
    }

    try {
      setDeviceTotalRam(getDeviceTotalRamBytes());
    } catch {
      // Not linked
    }

    pollTelemetry();
    const interval = setInterval(pollTelemetry, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const modelInfo = llamaEngine.getModelInfo();
  const modelCatalogEntry = modelInfo
    ? MODEL_CATALOG.find((m) => m.filename === modelInfo.filename)
    : undefined;

  // 12GB Bounty RAM Audit calculations
  const bountyRamBudget = RAM_BUDGET_BYTES; // 12GB
  const rssToBountyRatio = Math.min(appRss / bountyRamBudget, 1);
  const peakToBountyRatio = Math.min(appPeakRss / bountyRamBudget, 1);
  const withinRamLimit = appPeakRss <= bountyRamBudget;

  // 50GB Bounty Storage Audit calculations
  const bountyStorageBudget = STORAGE_BUDGET_BYTES; // 50GB
  const withinStorageLimit = storage.totalAppBytes <= bountyStorageBudget;

  const ggufPct = Math.min((storage.ggufBytes / bountyStorageBudget) * 100, 100);
  const corpusPct = Math.min((storage.corpusBytes / bountyStorageBudget) * 100, 100);
  const otherPct = Math.min((storage.otherBytes / bountyStorageBudget) * 100, 100);

  return (
    <View style={styles.container}>
      {/* SECTION 1: MEMORY FOOTPRINT & 12GB BOUNTY AUDIT */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>RAM & PROCESS MEMORY</Text>
          </View>
        </View>

        {/* Visual Memory Gauge against 12GB limit */}
        <View style={styles.gaugeContainer}>
          <View style={styles.gaugeHeader}>
            <Text style={styles.gaugeLabel}>APP PROCESS RSS</Text>
            <Text style={styles.gaugeValue}>{formatGB(appRss)} / 12.00 GB</Text>
          </View>
          <View style={styles.gaugeTrack}>
            {/* Peak RSS Shadow */}
            <View
              style={[
                styles.gaugePeakMarker,
                { width: `${peakToBountyRatio * 100}%` },
              ]}
            />
            {/* Current RSS Fill */}
            <View
              style={[
                styles.gaugeFill,
                { width: `${rssToBountyRatio * 100}%` },
                !withinRamLimit && styles.gaugeFillCrimson,
              ]}
            />
          </View>
          <View style={styles.gaugeScaleRow}>
            <Text style={styles.gaugeScaleText}>0 GB</Text>
            <Text style={styles.gaugeScaleText}>6 GB</Text>
            <Text style={styles.gaugeScaleText}>12 GB CAP</Text>
          </View>
        </View>

        {/* Comparative Hardware Telemetry Rows */}
        <View style={styles.statsTable}>
          <TelemetryRow
            label="Current Process RSS"
            value={formatGB(appRss)}
            highlight={colors.text.accentEmerald}
          />
          <TelemetryRow
            label="Peak Session RSS"
            value={formatGB(appPeakRss)}
            highlight={withinRamLimit ? colors.text.accentCyan : colors.crimson[400]}
          />
          <TelemetryRow
            label="Total Device RAM"
            value={deviceTotalRam > 0 ? formatGB(deviceTotalRam) : "Detecting…"}
          />
          <TelemetryRow
            label="RAM Bounty Margin"
            value={formatGB(Math.max(0, bountyRamBudget - appPeakRss))}
            highlight={colors.text.accentEmerald}
          />
        </View>
      </View>

      {/* SECTION 2: DISK STORAGE BREAKDOWN (CORPUS VS GGUF VS FREE) */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>APP STORAGE BREAKDOWN</Text>
          </View>
          <View
            style={[
              styles.statusPill,
              withinStorageLimit ? styles.statusPillEmerald : styles.statusPillCrimson,
            ]}
          >
            <Text
              style={[
                styles.statusPillText,
                withinStorageLimit ? styles.statusTextEmerald : styles.statusTextCrimson,
              ]}
            >
              {formatGB(storage.totalAppBytes)} / 50 GB
            </Text>
          </View>
        </View>

        {/* Segmented Progress Bar */}
        <View style={styles.segmentedBarContainer}>
          <View style={styles.segmentedBarTrack}>
            {/* GGUF Weights Segment */}
            <View style={[styles.segmentGguf, { width: `${Math.max(ggufPct, 2)}%` }]} />
            {/* Corpus Index Segment */}
            <View style={[styles.segmentCorpus, { width: `${Math.max(corpusPct, 1)}%` }]} />
            {/* Other / Embeddings Segment */}
            {otherPct > 0 && (
              <View style={[styles.segmentOther, { width: `${Math.max(otherPct, 1)}%` }]} />
            )}
          </View>
        </View>

        {/* Storage Legend */}
        <View style={styles.legendContainer}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.emerald[400] }]} />
            <Text style={styles.legendLabel}>GGUF Models</Text>
            <Text style={styles.legendValue}>{formatMB(storage.ggufBytes)}</Text>
          </View>

          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.cyan[400] }]} />
            <Text style={styles.legendLabel}>Corpus SQLite & FTS</Text>
            <Text style={styles.legendValue}>{formatMB(storage.corpusBytes)}</Text>
          </View>

          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.frontier.glow }]} />
            <Text style={styles.legendLabel}>Embeddings & DB</Text>
            <Text style={styles.legendValue}>{formatMB(storage.otherBytes)}</Text>
          </View>

          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.text.dim }]} />
            <Text style={styles.legendLabel}>Device Free Space</Text>
            <Text style={styles.legendValue}>
              {storage.freeDeviceBytes > 0 ? formatGB(storage.freeDeviceBytes) : "Available"}
            </Text>
          </View>
        </View>
      </View>

      {/* SECTION 3: INFERENCE TELEMETRY */}
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>LAST INFERENCE BENCHMARK</Text>
        </View>

        {stats ? (
          <View style={styles.statsTable}>
            <TelemetryRow
              label="Generation Speed"
              value={`${stats.tokPerSec.toFixed(1)} tok/s`}
              highlight={colors.text.accentCyan}
            />
            <TelemetryRow
              label="Time to First Token (TTFT)"
              value={formatMs(stats.ttftMs)}
              highlight={colors.text.accentEmerald}
            />
            <TelemetryRow label="Tokens Output" value={`${stats.tokensGenerated} tokens`} />
            <TelemetryRow label="Total Query Duration" value={formatMs(stats.durationMs)} />
            <TelemetryRow
              label="Peak Memory During Query"
              value={formatGB(stats.peakRssBytes)}
            />
          </View>
        ) : (
          <Text style={styles.emptyNotice}>
            Run an offline query to record telemetry benchmarks.
          </Text>
        )}
      </View>

      {/* SECTION 3B: LAST ADAPTIVE ROUTING DECISION — only present when
          the last message actually went through runAdaptiveChat()
          (src/services/adaptiveChat.ts, Phase 9), which is itself gated
          behind the "Adaptive Routing (Experimental)" setting. Absent
          entirely for a fixed-active-model reply or Deep Research, so
          this section not appearing at all is itself informative (routing
          wasn't used for the last message), not a bug. */}
      {stats?.adaptiveRoutingUsed && (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>LAST ADAPTIVE ROUTING DECISION</Text>
            </View>
            <View
              style={[
                styles.statusPill,
                stats.outcome === "failure" ? styles.statusPillCrimson : styles.statusPillEmerald,
              ]}
            >
              <Text
                style={[
                  styles.statusPillText,
                  stats.outcome === "failure" ? styles.statusTextCrimson : styles.statusTextEmerald,
                ]}
              >
                {(stats.outcome ?? "success").toUpperCase()}
              </Text>
            </View>
          </View>

          {stats.outcome === "failure" ? (
            <Text style={styles.emptyNotice}>
              Adaptive routing failed for the last message — it fell back to the normal active
              model automatically. See the console log for the specific reason.
            </Text>
          ) : (
            <View style={styles.statsTable}>
              <TelemetryRow
                label="Model Used"
                value={MODEL_CATALOG.find((m) => m.id === stats.modelId)?.label ?? stats.modelId ?? "—"}
                highlight={colors.text.heading}
              />
              <TelemetryRow label="Task Type" value={stats.taskType ?? "—"} />
              <TelemetryRow
                label="Retrieval Used"
                value={stats.retrievalUsed ? "Yes" : "No"}
              />
              <TelemetryRow
                label="Model Switches (this plan)"
                value={`${stats.modelSwitches ?? 0}`}
              />
              <TelemetryRow
                label="Switched Since Last Message"
                value={stats.crossMessageModelSwitch ? "Yes" : "No"}
                highlight={stats.crossMessageModelSwitch ? colors.text.accentCyan : undefined}
              />
              {stats.generationLatencyMs != null && (
                <TelemetryRow
                  label="Generation Latency"
                  value={formatMs(stats.generationLatencyMs)}
                />
              )}
              {stats.reasonCodes && stats.reasonCodes.length > 0 && (
                <TelemetryRow label="Reason Codes" value={stats.reasonCodes.join(", ")} />
              )}
            </View>
          )}
        </View>
      )}

      {/* SECTION 4: ACTIVE MODEL ARCHITECTURE */}
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>ACTIVE ENGINE CONFIGURATION</Text>
        </View>

        {modelInfo ? (
          <View style={styles.statsTable}>
            <TelemetryRow
              label="Model"
              value={modelCatalogEntry?.label ?? modelInfo.filename}
              highlight={colors.text.heading}
            />
            <TelemetryRow label="Context Window (nCtx)" value={`${modelInfo.nCtx} tokens`} />
            <TelemetryRow label="Compute Threads" value={`${modelInfo.nThreads} threads`} />
            {modelCatalogEntry && (
              <TelemetryRow label="Open Weights License" value={modelCatalogEntry.license} />
            )}
            <TelemetryRow label="Inference" value="llama.cpp / llama.rn" />
          </View>
        ) : (
          <Text style={styles.emptyNotice}>No GGUF model currently loaded.</Text>
        )}
      </View>
    </View>
  );
}

function TelemetryRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, highlight ? { color: highlight } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.md,
    padding: spacing.md,
  },
  card: {
    backgroundColor: colors.bg.cardElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    padding: spacing.md,
    gap: spacing.md,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cardTitle: {
    ...typography.mono.xs,
    color: colors.text.heading,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.xs,
    borderWidth: 1,
    gap: 5,
  },
  statusPillEmerald: {
    backgroundColor: colors.emerald.bgSubtle,
    borderColor: colors.emerald.border,
  },
  statusPillCrimson: {
    backgroundColor: colors.crimson.bgSubtle,
    borderColor: colors.crimson.border,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotEmerald: {
    backgroundColor: colors.emerald[400],
  },
  statusDotCrimson: {
    backgroundColor: colors.crimson[400],
  },
  statusPillText: {
    ...typography.mono.xs,
    fontSize: 9,
    fontWeight: "800",
  },
  statusTextEmerald: {
    color: colors.text.accentEmerald,
  },
  statusTextCrimson: {
    color: colors.crimson[400],
  },
  gaugeContainer: {
    gap: 6,
  },
  gaugeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  gaugeLabel: {
    ...typography.mono.xs,
    color: colors.text.muted,
  },
  gaugeValue: {
    ...typography.mono.sm,
    color: colors.text.primary,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  gaugeTrack: {
    height: 10,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: radii.xs,
    overflow: "hidden",
    position: "relative",
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  gaugePeakMarker: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(6, 182, 212, 0.25)",
  },
  gaugeFill: {
    height: "100%",
    backgroundColor: colors.emerald[500],
    borderRadius: radii.xs,
  },
  gaugeFillCrimson: {
    backgroundColor: colors.crimson[500],
  },
  gaugeScaleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  gaugeScaleText: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.text.dim,
  },
  statsTable: {
    backgroundColor: colors.bg.terminal,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.04)",
  },
  rowLabel: {
    ...typography.ui.subtext,
    color: colors.text.secondary,
  },
  rowValue: {
    ...typography.mono.sm,
    color: colors.text.heading,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  segmentedBarContainer: {
    gap: 6,
  },
  segmentedBarTrack: {
    flexDirection: "row",
    height: 12,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderRadius: radii.xs,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  segmentGguf: {
    backgroundColor: colors.emerald[500],
    height: "100%",
  },
  segmentCorpus: {
    backgroundColor: colors.cyan[500],
    height: "100%",
  },
  segmentOther: {
    backgroundColor: colors.frontier.glow,
    height: "100%",
  },
  legendContainer: {
    gap: 6,
    paddingTop: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendLabel: {
    ...typography.ui.caption,
    color: colors.text.muted,
    flex: 1,
  },
  legendValue: {
    ...typography.mono.xs,
    color: colors.text.heading,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  emptyNotice: {
    ...typography.ui.subtext,
    color: colors.text.dim,
    fontStyle: "italic",
    paddingVertical: spacing.xs,
  },
});
