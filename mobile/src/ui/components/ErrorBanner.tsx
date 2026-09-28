import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, MIN_TOUCH, radius, spacing, toneColors, type Tone, type } from '../theme';

export interface ErrorBannerProps {
  message: string | null | undefined;
  title?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

/** Inline error with the actual message; renders nothing without one. */
export function ErrorBanner({ message, title, onRetry, onDismiss }: ErrorBannerProps) {
  if (!message) return null;
  return (
    <View style={[styles.banner, styles.error]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={styles.text}>
        {title ? <Text style={[styles.title, { color: colors.danger }]}>{title}</Text> : null}
        <Text style={[styles.message, { color: colors.danger }]} selectable>
          {message}
        </Text>
      </View>
      {onRetry ? <BannerAction label="Retry" color={colors.danger} onPress={onRetry} /> : null}
      {onDismiss ? <BannerAction label="✕" accessibilityLabel="Dismiss error" color={colors.danger} onPress={onDismiss} /> : null}
    </View>
  );
}

export interface NoticeProps {
  message: string;
  title?: string;
  tone?: Tone;
  actionLabel?: string;
  onAction?: () => void;
}

/** Non-error callout (warnings, tips, explanations). */
export function Notice({ message, title, tone = 'info', actionLabel, onAction }: NoticeProps) {
  const c = toneColors(tone);
  return (
    <View style={[styles.banner, { backgroundColor: c.bg }]}>
      <View style={styles.text}>
        {title ? <Text style={[styles.title, { color: c.fg }]}>{title}</Text> : null}
        <Text style={[styles.message, { color: colors.text }]}>{message}</Text>
      </View>
      {actionLabel && onAction ? <BannerAction label={actionLabel} color={c.fg} onPress={onAction} /> : null}
    </View>
  );
}

function BannerAction({
  label,
  color,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  color: string;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={8}
      style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
  },
  error: { backgroundColor: colors.dangerSoft },
  text: { flex: 1, gap: spacing.xxs, paddingVertical: spacing.xs },
  title: { ...type.subheading },
  message: { ...type.caption },
  action: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  actionLabel: { ...type.subheading },
});
