import { useRouter } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { approveWeight, chooseWeightCandidate, rejectWeight } from '../../pipeline/review';
import { requestSync } from '../autoRun';
import type { WeightEntry, WeightUnit } from '../../types';
import { confidenceText, formatWeight } from '../format';
import { useAction } from '../hooks';
import { colors, spacing, type } from '../theme';
import { ConfidenceBadge, FlagBadge, StatusBadge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { ErrorBanner } from './ErrorBanner';
import { ButtonRow } from './Layout';
import { PhotoThumb } from './PhotoThumb';

export interface WeightCardProps {
  entry: WeightEntry;
  unit: WeightUnit;
  photoUris: Record<string, string>;
  /** Called after the entry changed so the list can reload. */
  onChanged: () => void;
}

export function WeightCard({ entry, unit, photoUris, onChanged }: WeightCardProps) {
  const router = useRouter();
  const approve = useAction(async () => {
    await approveWeight(entry.id);
    requestSync();
    onChanged();
  });
  const reject = useAction(async () => {
    await rejectWeight(entry.id);
    requestSync();
    onChanged();
  });
  const choose = useAction(async (assetId: string) => {
    const updated = await chooseWeightCandidate(entry.id, assetId);
    if (updated.status === 'approved') requestSync();
    onChanged();
  });

  const confirmReject = () =>
    Alert.alert('Reject this weigh-in?', "It won't be written to the sheet.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => void reject.run() },
    ]);

  const edit = () => router.push({ pathname: '/review/weight/[id]', params: { id: entry.id } });
  const busy = approve.pending || reject.pending || choose.pending;
  const candidates = [...entry.candidates].sort((a, b) => a.takenAt - b.takenAt);

  return (
    <Card>
      <View style={styles.top}>
        <View style={styles.valueBlock}>
          <Text style={styles.kind}>Weigh-in</Text>
          <Text style={styles.value} accessibilityLabel={`Weight ${formatWeight(entry.valueLb, unit)}`}>
            {formatWeight(entry.valueLb, unit)}
          </Text>
          <Text style={styles.meta}>
            {entry.time ? `at ${entry.time}` : 'no time'} · {entry.source === 'manual' ? 'typed in' : 'from photo'}
          </Text>
        </View>
        <View style={styles.badges}>
          <ConfidenceBadge confidence={entry.confidence} short />
          {entry.status !== 'needs_review' ? <StatusBadge status={entry.status} /> : null}
        </View>
      </View>

      {entry.flags.length ? (
        <View style={styles.flags}>
          {entry.flags.map((f) => (
            <FlagBadge key={f} flag={f} />
          ))}
        </View>
      ) : null}

      {candidates.length > 1 ? (
        <View style={styles.candidates}>
          <Text style={styles.meta}>Readings that day — tap one to use it</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
            {candidates.map((c) => {
              const selected = c.assetId === entry.chosenAssetId;
              return (
                <PhotoThumb
                  key={c.assetId}
                  uri={photoUris[c.assetId]}
                  size={64}
                  selected={selected}
                  caption={formatWeight(c.valueLb, unit)}
                  accessibilityLabel={`${selected ? 'Chosen reading' : 'Use reading'} ${formatWeight(c.valueLb, unit)}, ${confidenceText(c.readConfidence)}`}
                  onPress={selected || busy ? undefined : () => void choose.run(c.assetId)}
                />
              );
            })}
          </ScrollView>
        </View>
      ) : candidates.length === 1 ? (
        <PhotoThumb uri={photoUris[candidates[0].assetId]} size={64} accessibilityLabel="Scale photo" onPress={edit} />
      ) : null}

      {entry.syncError ? <ErrorBanner title="Sync failed" message={entry.syncError} /> : null}
      <ErrorBanner message={approve.error ?? reject.error ?? choose.error} />

      <ButtonRow>
        <Button
          compact
          label="Approve"
          onPress={() => void approve.run()}
          loading={approve.pending}
          disabled={busy || entry.valueLb === null || entry.status !== 'needs_review'}
          accessibilityLabel={`Approve weigh-in ${formatWeight(entry.valueLb, unit)}`}
        />
        <Button compact variant="secondary" label="Edit" onPress={edit} disabled={busy} accessibilityLabel="Edit weigh-in" />
        <Button
          compact
          variant="destructive"
          label="Reject"
          onPress={confirmReject}
          loading={reject.pending}
          disabled={busy}
          accessibilityLabel="Reject weigh-in"
        />
      </ButtonRow>
    </Card>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  valueBlock: { flex: 1, gap: spacing.xxs },
  kind: { ...type.small, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { ...type.display, color: colors.text },
  meta: { ...type.caption, color: colors.textMuted },
  badges: { alignItems: 'flex-end', gap: spacing.xs },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  candidates: { gap: spacing.xs },
  thumbRow: { gap: spacing.sm },
});
