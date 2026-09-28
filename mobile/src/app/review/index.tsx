import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getSettings } from '../../config/settings';
import { listMeals } from '../../db/meals';
import { listWeightEntries } from '../../db/weights';
import { toLocalDate } from '../../lib/dates';
import { approveAllConfident } from '../../pipeline/review';
import { syncNow } from '../../sync/syncQueue';
import type { AppSettings, MealEntry, WeightEntry } from '../../types';
import {
  Button,
  ButtonRow,
  EmptyState,
  ErrorBanner,
  HomeFallbackHeader,
  MealCard,
  Muted,
  Notice,
  Screen,
  SectionHeader,
  useAutoRunState,
  WeightCard,
} from '../../ui/components';
import { requestSync } from '../../ui/autoRun';
import { dayLabel, formatKcal, plural, syncSummary } from '../../ui/format';
import { loadPhotoUris, useAction, useAsync, useFocusRefresh, useNow } from '../../ui/hooks';
import { countConfident, dayKcal, groupByDay, type ReviewDay } from '../../ui/reviewModel';
import { colors, spacing, type } from '../../ui/theme';

interface QueueData {
  settings: AppSettings;
  weights: WeightEntry[];
  meals: MealEntry[];
  days: ReviewDay[];
  waiting: number;
  uris: Record<string, string>;
}

async function loadQueue(): Promise<QueueData> {
  const settings = await getSettings();
  const person = settings.person ?? undefined;
  const [weights, meals, approvedWeights, approvedMeals] = await Promise.all([
    listWeightEntries({ person, statuses: ['needs_review', 'sync_error'] }),
    listMeals({ person, statuses: ['needs_review', 'sync_error'] }),
    listWeightEntries({ person, statuses: ['approved'] }),
    listMeals({ person, statuses: ['approved'] }),
  ]);
  const assetIds = [...weights.flatMap((w) => w.candidates.map((c) => c.assetId)), ...meals.flatMap((m) => m.assetIds.slice(0, 1))];
  return {
    settings,
    weights,
    meals,
    days: groupByDay(weights, meals),
    waiting: approvedWeights.length + approvedMeals.length,
    uris: await loadPhotoUris(assetIds),
  };
}

export default function ReviewQueue() {
  const router = useRouter();
  const queue = useAsync(loadQueue);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useFocusRefresh(queue.reload);

  const reload = queue.reload;
  const autoPhase = useAutoRunState().phase;
  useEffect(() => {
    if (autoPhase === 'done') void reload();
  }, [autoPhase, reload]);
  const approveAll = useAction(async () => {
    const r = await approveAllConfident();
    const total = r.weights + r.meals;
    if (total) requestSync();
    setMessage(total ? `Approved ${plural(r.weights, 'weigh-in')} and ${plural(r.meals, 'meal')}.` : 'Nothing was confident enough to approve automatically.');
    await reload();
  });
  const sync = useAction(async () => {
    const r = await syncNow();
    setMessage(syncSummary(r));
    await reload();
    if (r.errors.length) throw new Error(r.errors.join('\n'));
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  const data = queue.data;
  const confident = data ? countConfident(data.weights, data.meals) : 0;
  const today = toLocalDate(useNow());

  return (
    <Screen onRefresh={() => void onRefresh()} refreshing={refreshing}>
      <HomeFallbackHeader />
      <ErrorBanner message={queue.error} onRetry={() => void reload()} />

      <ButtonRow>
        <Button
          compact
          label={confident ? `Approve all confident (${confident})` : 'Approve all confident'}
          onPress={() => void approveAll.run()}
          loading={approveAll.pending}
          disabled={!confident || sync.pending}
          accessibilityHint="Approves high-confidence entries with no flags or open questions"
        />
        <Button compact variant="secondary" label="Sync now" onPress={() => void sync.run()} loading={sync.pending} disabled={approveAll.pending} />
      </ButtonRow>
      {message ? <Notice tone="info" message={message} /> : null}
      <ErrorBanner title="Sync problems" message={sync.error ?? approveAll.error} onDismiss={() => sync.setError(null)} />
      {data && data.waiting > 0 ? <Muted>{plural(data.waiting, 'approved entry', 'approved entries')} waiting to sync.</Muted> : null}

      {data && data.days.length === 0 ? (
        <EmptyState title="All caught up" message="Nothing waiting for review. New weigh-ins and meals appear here after photos are processed.">
          <Button label="Process new photos" onPress={() => router.push('/process-week?reason=manual')} />
          <Button label="Quick log" variant="secondary" onPress={() => router.push('/capture')} />
        </EmptyState>
      ) : null}

      {data?.days.map((day) => (
        <View key={day.date} style={styles.day}>
          <SectionHeader
            title={dayLabel(day.date, today)}
            right={
              day.meals.length ? (
                <Text style={styles.dayTotal} accessibilityLabel={`Meals to review add up to ${formatKcal(dayKcal(day.meals, day.date))}`}>
                  {plural(day.meals.length, 'meal')} · {formatKcal(dayKcal(day.meals, day.date))}
                </Text>
              ) : undefined
            }
          />
          {day.weights.map((w) => (
            <WeightCard key={w.id} entry={w} unit={data.settings.scaleUnit} photoUris={data.uris} onChanged={() => void reload()} />
          ))}
          {day.meals.map((m) => (
            <MealCard key={m.id} meal={m} photoUri={m.assetIds[0] ? data.uris[m.assetIds[0]] : undefined} onChanged={() => void reload()} />
          ))}
        </View>
      ))}

      {data && data.days.length > 0 ? <Button variant="ghost" label="Add photos or a manual entry" onPress={() => router.push('/capture')} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  day: { gap: spacing.md },
  dayTotal: { ...type.caption, fontWeight: '600', color: colors.textMuted },
});
