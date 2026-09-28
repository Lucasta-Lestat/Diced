import { useRouter } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { approveMeal, rejectMeal } from '../../pipeline/review';
import { requestSync } from '../autoRun';
import type { MealEntry } from '../../types';
import { formatKcal, formatMacros, kcalPlusMinus, plural, slotText } from '../format';
import { useAction } from '../hooks';
import { unansweredQuestions } from '../reviewModel';
import { colors, spacing, type } from '../theme';
import { Badge, ConfidenceBadge, StatusBadge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { ErrorBanner } from './ErrorBanner';
import { ButtonRow } from './Layout';
import { PhotoThumb } from './PhotoThumb';

export interface MealCardProps {
  meal: MealEntry;
  photoUri: string | undefined;
  onChanged: () => void;
}

export function MealCard({ meal, photoUri, onChanged }: MealCardProps) {
  const router = useRouter();
  const approve = useAction(async () => {
    await approveMeal(meal.id);
    requestSync();
    onChanged();
  });
  const reject = useAction(async () => {
    await rejectMeal(meal.id);
    requestSync();
    onChanged();
  });

  const confirmReject = () =>
    Alert.alert('Reject this meal?', 'Use this for photos that aren’t your food. It won’t be logged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => void reject.run() },
    ]);

  const open = () => router.push({ pathname: '/review/meal/[id]', params: { id: meal.id } });
  const est = meal.estimate;
  const questions = unansweredQuestions(meal).length;
  const range = est ? kcalPlusMinus(est.kcalLow, est.kcalHigh) : null;
  const title = meal.title || est?.title || slotText(meal.slot);
  const busy = approve.pending || reject.pending;
  const extraPhotos = meal.assetIds.length - 1;

  return (
    <Card>
      <View style={styles.top}>
        <PhotoThumb
          uri={photoUri}
          size={84}
          onPress={open}
          accessibilityLabel={`Open ${title}`}
          caption={extraPhotos > 0 ? `+${extraPhotos}` : undefined}
        />
        <View style={styles.info}>
          <Text style={styles.meta}>
            {slotText(meal.slot)} · {meal.time}
          </Text>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.kcal} accessibilityLabel={`${formatKcal(meal.final.kcal)}${range ? `, plus or minus ${range.slice(1)}` : ''}`}>
            {formatKcal(meal.final.kcal)}
            {range ? <Text style={styles.range}> {range}</Text> : null}
          </Text>
          <Text style={styles.meta}>{formatMacros(meal.final)}</Text>
        </View>
      </View>

      <View style={styles.badges}>
        {est ? <ConfidenceBadge confidence={est.confidence} /> : null}
        {questions > 0 ? <Badge label={plural(questions, 'question')} tone="info" /> : null}
        {meal.status !== 'needs_review' ? <StatusBadge status={meal.status} /> : null}
      </View>

      {meal.error ? <ErrorBanner title={meal.status === 'sync_error' ? 'Sync failed' : 'Estimate problem'} message={meal.error} /> : null}
      <ErrorBanner message={approve.error ?? reject.error} />

      <ButtonRow>
        <Button
          compact
          label="Approve"
          onPress={() => void approve.run()}
          loading={approve.pending}
          disabled={busy || meal.status !== 'needs_review'}
          accessibilityLabel={`Approve ${title}`}
        />
        <Button compact variant="secondary" label="Edit" onPress={open} disabled={busy} accessibilityLabel={`Edit ${title}`} />
        <Button
          compact
          variant="destructive"
          label="Reject"
          onPress={confirmReject}
          loading={reject.pending}
          disabled={busy}
          accessibilityLabel={`Reject ${title}`}
        />
      </ButtonRow>
    </Card>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', gap: spacing.md },
  info: { flex: 1, gap: spacing.xxs },
  title: { ...type.subheading, color: colors.text },
  kcal: { ...type.heading, color: colors.text },
  range: { ...type.caption, color: colors.textMuted },
  meta: { ...type.caption, color: colors.textMuted },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
