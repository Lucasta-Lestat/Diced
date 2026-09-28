import { StyleSheet, Text, View } from 'react-native';
import type { Confidence, EntryStatus } from '../../types';
import { confidenceText, flagText, statusText } from '../format';
import { confidenceTone, radius, spacing, toneColors, type Tone, type } from '../theme';

export interface BadgeProps {
  label: string;
  tone?: Tone;
  accessibilityLabel?: string;
}

export function Badge({ label, tone = 'neutral', accessibilityLabel }: BadgeProps) {
  const c = toneColors(tone);
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]} accessible accessibilityLabel={accessibilityLabel ?? label}>
      <Text style={[styles.text, { color: c.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function ConfidenceBadge({ confidence, short = false }: { confidence: Confidence; short?: boolean }) {
  const full = confidenceText(confidence);
  const label = short ? confidence.charAt(0).toUpperCase() + confidence.slice(1) : full;
  return <Badge label={label} tone={confidenceTone(confidence)} accessibilityLabel={full} />;
}

export function FlagBadge({ flag }: { flag: string }) {
  return <Badge label={flagText(flag)} tone="warning" />;
}

const STATUS_TONE: Record<EntryStatus, Tone> = {
  needs_review: 'info',
  approved: 'accent',
  rejected: 'neutral',
  synced: 'success',
  sync_error: 'danger',
};

export function StatusBadge({ status }: { status: EntryStatus }) {
  return <Badge label={statusText(status)} tone={STATUS_TONE[status]} />;
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs + 1,
  },
  text: { ...type.small },
});
