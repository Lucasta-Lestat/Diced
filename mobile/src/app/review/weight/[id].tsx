import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getSettings } from '../../../config/settings';
import { getWeightEntry } from '../../../db/weights';
import { toLocalDate, toLocalTime } from '../../../lib/dates';
import { approveWeight, chooseWeightCandidate, rejectWeight } from '../../../pipeline/review';
import type { AppSettings, WeightEntry, WeightUnit } from '../../../types';
import {
  Button,
  ButtonRow,
  Card,
  ConfidenceBadge,
  ErrorBanner,
  FlagBadge,
  Muted,
  PhotoThumb,
  Screen,
  SegmentedControl,
  StatusBadge,
  TextField,
} from '../../../ui/components';
import { requestSync } from '../../../ui/autoRun';
import { confidenceText, dayLabel, formatWeight, kgToLb, lbToKg } from '../../../ui/format';
import { firstParam, numberToInput, parseDecimal, parseWeightInput } from '../../../ui/forms';
import { loadPhotoUris, useAction, useAsync, useNow } from '../../../ui/hooks';
import { colors, spacing, type } from '../../../ui/theme';

interface WeightData {
  entry: WeightEntry;
  uris: Record<string, string>;
  settings: AppSettings;
}

async function loadWeight(id: string): Promise<WeightData> {
  const entry = await getWeightEntry(id);
  if (!entry) throw new Error('This weigh-in no longer exists.');
  const [uris, settings] = await Promise.all([loadPhotoUris(entry.candidates.map((c) => c.assetId)), getSettings()]);
  return { entry, uris, settings };
}

function valueText(lb: number | null, unit: WeightUnit): string {
  if (lb === null) return '';
  return numberToInput(unit === 'kg' ? lbToKg(lb) : lb, 1);
}

export default function WeightDetail() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = firstParam(params.id);
  const detail = useAsync(() => loadWeight(id), id);
  const current = detail.data;

  if (!current) {
    return (
      <Screen>
        <ErrorBanner message={detail.error} onRetry={() => void detail.reload()} />
        {!detail.error ? <Muted>Loading…</Muted> : null}
      </Screen>
    );
  }
  return <WeightEditor data={current} onEntry={(entry) => detail.setData((prev) => ({ ...(prev ?? current), entry }))} />;
}

function WeightEditor({ data, onEntry }: { data: WeightData; onEntry: (entry: WeightEntry) => void }) {
  const router = useRouter();
  const today = toLocalDate(useNow());
  const { entry, uris } = data;
  const [unit, setUnit] = useState<WeightUnit>(data.settings.scaleUnit);
  const [text, setText] = useState(() => valueText(entry.valueLb, data.settings.scaleUnit));
  const [notes, setNotes] = useState(entry.notes);
  const [valueError, setValueError] = useState<string | null>(null);

  const changeUnit = (next: WeightUnit) => {
    const typed = parseDecimal(text);
    if (typed !== null) {
      const lb = unit === 'kg' ? kgToLb(typed) : typed;
      setText(valueText(lb, next));
    }
    setUnit(next);
  };

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/review'));

  const choose = useAction(async (assetId: string) => {
    const updated = await chooseWeightCandidate(entry.id, assetId);
    onEntry(updated);
    if (updated.status === 'approved') requestSync();
    setText(valueText(updated.valueLb, unit));
  });
  const approve = useAction(async () => {
    const parsed = parseWeightInput(text, unit);
    if (!parsed.ok) {
      setValueError(parsed.error);
      return;
    }
    setValueError(null);
    await approveWeight(entry.id, parsed.value, notes);
    requestSync();
    leave();
  });
  const reject = useAction(async () => {
    await rejectWeight(entry.id);
    requestSync();
    leave();
  });

  const confirmReject = () =>
    Alert.alert('Reject this weigh-in?', "It won't be written to the sheet.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => void reject.run() },
    ]);

  const busy = choose.pending || approve.pending || reject.pending;
  const candidates = [...entry.candidates].sort((a, b) => a.takenAt - b.takenAt);
  const approveLabel = entry.status === 'needs_review' || entry.status === 'rejected' ? 'Approve' : 'Save changes';

  const footer = (
    <>
      <ErrorBanner message={approve.error ?? reject.error ?? choose.error} />
      <ButtonRow>
        <Button compact label={approveLabel} onPress={() => void approve.run()} loading={approve.pending} disabled={busy} />
        <Button compact variant="destructive" label="Reject" onPress={confirmReject} loading={reject.pending} disabled={busy || entry.status === 'rejected'} />
      </ButtonRow>
    </>
  );

  return (
    <Screen footer={footer}>
      <View style={styles.head}>
        <Text style={styles.date}>{dayLabel(entry.localDate, today)}</Text>
        <Text style={styles.value}>{formatWeight(entry.valueLb, unit)}</Text>
        <Muted>{entry.time ? `Weighed at ${entry.time}` : 'No time recorded'}</Muted>
        <View style={styles.badges}>
          <StatusBadge status={entry.status} />
          <ConfidenceBadge confidence={entry.confidence} />
        </View>
      </View>

      {entry.flags.length ? (
        <Card title="Worth a look">
          <View style={styles.badges}>
            {entry.flags.map((f) => (
              <FlagBadge key={f} flag={f} />
            ))}
          </View>
        </Card>
      ) : null}
      {entry.syncError ? <ErrorBanner title="Sync failed" message={entry.syncError} /> : null}

      {candidates.length ? (
        <Card title={candidates.length > 1 ? 'Readings' : 'Photo'} subtitle={candidates.length > 1 ? 'Tap the reading to use for this day.' : undefined}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
            {candidates.map((c) => {
              const selected = c.assetId === entry.chosenAssetId;
              return (
                <View key={c.assetId} style={styles.candidate}>
                  <PhotoThumb
                    uri={uris[c.assetId]}
                    size={150}
                    aspectRatio={0.8}
                    selected={selected}
                    accessibilityLabel={`${selected ? 'Chosen reading' : 'Use reading'} ${formatWeight(c.valueLb, unit)} at ${toLocalTime(c.takenAt)}, ${confidenceText(c.readConfidence)}`}
                    onPress={candidates.length > 1 && !selected && !busy ? () => void choose.run(c.assetId) : undefined}
                  />
                  <Text style={[styles.reading, selected && styles.readingSelected]}>{formatWeight(c.valueLb, unit)}</Text>
                  <Muted>
                    {toLocalTime(c.takenAt)}
                    {c.rawUnit !== 'lb' ? ` · read ${c.rawValue} ${c.rawUnit}` : ''}
                  </Muted>
                </View>
              );
            })}
          </ScrollView>
        </Card>
      ) : null}

      <Card title="Correct it">
        <SegmentedControl
          accessibilityLabel="Unit"
          options={[
            { value: 'lb', label: 'lb' },
            { value: 'kg', label: 'kg' },
          ]}
          value={unit}
          onChange={changeUnit}
        />
        <TextField
          label={`Weight (${unit})`}
          value={text}
          onChangeText={(t) => {
            setText(t);
            setValueError(null);
          }}
          keyboardType="decimal-pad"
          suffix={unit}
          error={valueError}
          placeholder={unit === 'kg' ? '82.5' : '182.4'}
        />
        <TextField label="Notes" value={notes} onChangeText={setNotes} multiline placeholder="e.g. weighed after breakfast" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: spacing.xs },
  date: { ...type.subheading, color: colors.textMuted },
  value: { ...type.display, color: colors.text },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  thumbs: { gap: spacing.md },
  candidate: { gap: spacing.xxs, alignItems: 'center' },
  reading: { ...type.subheading, color: colors.text },
  readingSelected: { color: colors.accent },
});
