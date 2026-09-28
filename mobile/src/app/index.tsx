import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getSettings } from '../config/settings';
import { listMeals } from '../db/meals';
import { lastRuns, type RunRecord } from '../db/runs';
import { listWeightEntries } from '../db/weights';
import { mondayOf, toLocalDate, addDays } from '../lib/dates';
import { errorMessage } from '../lib/log';
import { getPhotoPermission, type PhotoPermission } from '../photos/scanner';
import type { SheetSummaryWeek } from '../sync/contract';
import { getSheetInfo } from '../sync/sheetsClient';
import { getCachedSummary, getLastSync, refreshSummary, type LastSync } from '../sync/syncQueue';
import type { AppSettings, MealEntry, WeightEntry } from '../types';
import {
  Button,
  Card,
  ErrorBanner,
  HeaderButton,
  Muted,
  Notice,
  ProgressView,
  Screen,
  Stat,
  useAutoRunState,
  VStack,
} from '../ui/components';
import { formatKcal, formatWeight, formatWeightDelta, plural, relativeTime, runSummary, syncSummary, weekdayShort } from '../ui/format';
import { useAsync, useFocusRefresh, useNow } from '../ui/hooks';
import { averageLb, dayKcal, isCounted, weekWeighIns, type WeekDay } from '../ui/reviewModel';
import { colors, radius, spacing, type } from '../ui/theme';
import { openSystemSettings } from '../ui/system';

/** Re-fetch the sheet summary on open when the cached one is older than this. */
const SUMMARY_STALE_MS = 60 * 60_000;

interface HomeData {
  settings: AppSettings;
  today: string;
  sheetName: string | null;
  week: WeekDay[];
  localAvg: number | null;
  sheetWeek: SheetSummaryWeek | null;
  planWeek: number | null;
  todayKcal: number;
  todayMeals: number;
  kcalTarget: number | null;
  toReview: number;
  waiting: number;
  syncErrors: number;
  lastRun: RunRecord | null;
  lastSync: LastSync | null;
  summaryFetchedAt: number | null;
  photoPermission: PhotoPermission | null;
}

async function loadHome(): Promise<HomeData> {
  const settings = await getSettings();
  const person = settings.person ?? undefined;
  const today = toLocalDate(Date.now());
  const monday = mondayOf(today);
  const [weights, meals, pendingWeights, pendingMeals, info, summary, runs, lastSync, photoPermission] = await Promise.all([
    listWeightEntries({ person, from: monday, to: addDays(monday, 6) }),
    listMeals({ person, from: today, to: today }),
    listWeightEntries({ person, statuses: ['needs_review', 'approved', 'sync_error'] }),
    listMeals({ person, statuses: ['needs_review', 'approved', 'sync_error'] }),
    getSheetInfo(),
    getCachedSummary(),
    lastRuns(1),
    getLastSync(),
    settings.classificationMode === 'cloud_thumbnails' ? getPhotoPermission().catch(() => null) : Promise.resolve(null),
  ]);
  const pending: (WeightEntry | MealEntry)[] = [...pendingWeights, ...pendingMeals];
  const count = (status: string) => pending.filter((e) => e.status === status).length;
  const week = weekWeighIns(weights, today);
  const sheetWeek = summary?.weeks.find((w) => w.week === summary.currentWeek) ?? null;
  // Targets change weekly; the latest day in the cached summary is the best stand-in for today.
  const targetDay = summary?.days.find((d) => d.date === today) ?? summary?.days.at(-1) ?? null;
  return {
    settings,
    today,
    sheetName: info?.spreadsheetName ?? null,
    week,
    localAvg: averageLb(week),
    sheetWeek,
    planWeek: summary?.currentWeek ?? null,
    todayKcal: dayKcal(meals, today),
    todayMeals: meals.filter((m) => isCounted(m.status)).length,
    kcalTarget: targetDay?.kcalTarget ?? null,
    toReview: count('needs_review'),
    waiting: count('approved'),
    syncErrors: count('sync_error'),
    lastRun: runs[0] ?? null,
    lastSync,
    summaryFetchedAt: summary?.fetchedAt ?? null,
    photoPermission,
  };
}

/** Refreshes the cached sheet summary; resolves to the error message, or null when it worked. */
async function summaryRefreshError(): Promise<string | null> {
  try {
    await refreshSummary();
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

export default function Home() {
  const router = useRouter();
  const home = useAsync(loadHome);
  const [refreshing, setRefreshing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const reloadHome = home.reload;
  useFocusRefresh(reloadHome);
  const autoPhase = useAutoRunState().phase;
  useEffect(() => {
    if (autoPhase === 'done') void reloadHome();
  }, [autoPhase, reloadHome]);

  const fetchSummary = async () => setSummaryError(await summaryRefreshError());

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchSummary();
    await reloadHome();
    setRefreshing(false);
  };

  const autoFetched = useRef(false);
  const data = home.data;
  useEffect(() => {
    if (!data || autoFetched.current) return;
    autoFetched.current = true;
    const stale = data.summaryFetchedAt === null || Date.now() - data.summaryFetchedAt > SUMMARY_STALE_MS;
    if (stale && data.settings.person && data.settings.sheetWebAppUrl) {
      void summaryRefreshError().then((message) => {
        setSummaryError(message);
        return reloadHome();
      });
    }
  }, [data, reloadHome]);

  return (
    <Screen onRefresh={() => void onRefresh()} refreshing={refreshing}>
      <Stack.Screen
        options={{
          headerRight: () => <HeaderButton label="Settings" accessibilityLabel="Open settings" onPress={() => router.push('/settings')} />,
        }}
      />
      <ErrorBanner message={home.error} onRetry={() => void home.reload()} />
      {data ? <HomeBody data={data} summaryError={summaryError} /> : null}
    </Screen>
  );
}

function HomeBody({ data, summaryError }: { data: HomeData; summaryError: string | null }) {
  const router = useRouter();
  const now = useNow();
  const unit = data.settings.scaleUnit;
  const connected = Boolean(data.settings.sheetWebAppUrl && data.settings.person);

  return (
    <>
      <View style={styles.hello}>
        <Text style={styles.person}>{data.settings.person ? `Logging for ${data.settings.person}` : 'No person chosen'}</Text>
        <Muted>
          {data.sheetName ?? (connected ? 'Google Sheet connected' : 'Sheet not connected')}
          {data.planWeek ? ` · week ${data.planWeek} of the plan` : ''}
        </Muted>
      </View>

      {!connected ? (
        <Notice tone="warning" message="Connect the Google Sheet so approved entries can be saved." actionLabel="Connect" onAction={() => router.push('/connect')} />
      ) : null}
      {data.photoPermission && data.photoPermission !== 'granted_all' ? (
        <Notice
          tone="warning"
          title={data.photoPermission === 'granted_limited' ? 'Limited photo access' : 'No photo access'}
          message="Diced can only find new scale and food photos with access to all photos."
          actionLabel="Settings"
          onAction={openSystemSettings}
        />
      ) : null}
      {data.syncErrors > 0 ? (
        <Notice tone="danger" message={`${plural(data.syncErrors, 'entry', 'entries')} couldn't be written to the sheet.`} actionLabel="Review" onAction={() => router.push('/review')} />
      ) : null}

      <VStack gap={spacing.sm}>
        <Button
          label={data.toReview > 0 ? `Review ${plural(data.toReview, 'item')}` : 'Review'}
          variant={data.toReview > 0 ? 'primary' : 'secondary'}
          onPress={() => router.push('/review')}
        />
        <Button label="Process new photos" variant={data.toReview > 0 ? 'secondary' : 'primary'} onPress={() => router.push('/process-week?reason=manual')} />
        <Button label="Quick log" variant="secondary" onPress={() => router.push('/capture')} accessibilityHint="Photograph the scale or a meal, or type an entry" />
      </VStack>

      <WeekCard data={data} unit={unit} />

      <Card title="Today">
        <View style={styles.stats}>
          <Stat label="Calories" value={formatKcal(data.todayKcal)} caption={plural(data.todayMeals, 'meal')} />
          <Stat label="Target" value={formatKcal(data.kcalTarget)} caption={data.kcalTarget ? 'from the sheet' : 'sync to see it'} />
        </View>
        {data.kcalTarget ? (
          <ProgressView
            label={data.todayKcal <= data.kcalTarget ? `${formatKcal(data.kcalTarget - data.todayKcal)} left` : `${formatKcal(data.todayKcal - data.kcalTarget)} over`}
            done={Math.min(Math.round(data.todayKcal), Math.round(data.kcalTarget))}
            total={Math.round(data.kcalTarget)}
          />
        ) : null}
      </Card>

      <Card title="Activity">
        <Muted>
          {data.lastRun
            ? `Last run ${relativeTime(data.lastRun.finishedAt, now)}: ${runSummary(data.lastRun)}`
            : 'No photos processed yet.'}
        </Muted>
        <Muted>
          {data.lastSync ? `Last sync ${relativeTime(data.lastSync.at, now)}: ${syncSummary(data.lastSync)}` : 'Not synced yet.'}
        </Muted>
        {data.waiting > 0 ? <Muted>{plural(data.waiting, 'approved entry', 'approved entries')} waiting to sync.</Muted> : null}
        {summaryError ? <Muted style={styles.warn}>Sheet summary: {summaryError}</Muted> : null}
      </Card>
    </>
  );
}

function WeekCard({ data, unit }: { data: HomeData; unit: AppSettings['scaleUnit'] }) {
  const avg = data.localAvg;
  const target = data.sheetWeek?.targetWeightLb ?? null;
  return (
    <Card title="This week" subtitle="The sheet's Weekly Check-in uses the average of these daily weigh-ins.">
      <View style={styles.days}>
        {data.week.map((d, i) => {
          const isToday = d.date === data.today;
          const label = weekdayShort(i + 1);
          const value = d.entry?.valueLb ?? null;
          return (
            <View
              key={d.date}
              style={[styles.day, isToday && styles.today]}
              accessible
              accessibilityLabel={`${label}: ${value === null ? 'no weigh-in' : formatWeight(value, unit)}`}>
              <Text style={styles.dayLabel}>{label}</Text>
              <Text style={styles.dayValue}>{value === null ? '·' : formatWeight(value, unit).split(' ')[0]}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.stats}>
        <Stat label="7-day avg" value={formatWeight(avg, unit)} caption={data.sheetWeek?.avgWeightLb != null ? `sheet: ${formatWeight(data.sheetWeek.avgWeightLb, unit)}` : undefined} />
        <Stat
          label="Target"
          value={formatWeight(target, unit)}
          caption={avg !== null && target !== null ? `${formatWeightDelta(avg - target, unit)} vs target` : undefined}
          tone={avg !== null && target !== null && avg <= target ? 'success' : undefined}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  hello: { gap: spacing.xxs },
  person: { ...type.title, color: colors.text },
  stats: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  days: { flexDirection: 'row', gap: spacing.xs },
  day: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    gap: spacing.xxs,
  },
  today: { borderWidth: 1, borderColor: colors.accent, backgroundColor: colors.accentSoft },
  dayLabel: { ...type.small, color: colors.textMuted },
  dayValue: { ...type.small, color: colors.text, fontVariant: ['tabular-nums'] },
  warn: { color: colors.warning },
});
