import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dismissAutoRun, getAutoRunState, subscribeAutoRun, type AutoRunState } from '../autoRun';
import { progressLine, screenRunsPipeline } from '../autoRunPolicy';
import { colors, MIN_TOUCH, radius, spacing, type } from '../theme';

/** Live state of the foreground catch-up run. */
export function useAutoRunState(): AutoRunState {
  const [state, setState] = useState<AutoRunState>(getAutoRunState);
  useEffect(() => subscribeAutoRun(setState), []);
  return state;
}

/** Small floating status for the foreground catch-up run. */
export function AutoRunBanner() {
  const state = useAutoRunState();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();

  if (state.phase === 'idle' || screenRunsPipeline(pathname)) return null;

  const text =
    state.phase === 'processing'
      ? `Processing new photos · ${progressLine(state.progress)}`
      : state.message;
  const canOpenReview = state.phase === 'done' && state.hasNew;

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + spacing.md }]}>
      <View style={[styles.banner, state.phase === 'error' && styles.error]} accessibilityLiveRegion="polite">
        {state.phase === 'processing' ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
        <Pressable
          style={styles.textButton}
          disabled={!canOpenReview}
          onPress={() => {
            dismissAutoRun();
            router.push('/review');
          }}
          accessibilityRole={canOpenReview ? 'button' : 'text'}
          accessibilityHint={canOpenReview ? 'Opens the review queue' : undefined}>
          <Text style={styles.text} numberOfLines={2}>
            {text}
            {canOpenReview ? ' — Review' : ''}
          </Text>
        </Pressable>
        {state.phase !== 'processing' ? (
          <Pressable onPress={dismissAutoRun} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={8} style={styles.close}>
            <Text style={styles.text}>✕</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.lg, right: spacing.lg, pointerEvents: 'box-none' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.overlay,
    borderRadius: radius.lg,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    minHeight: MIN_TOUCH,
  },
  error: { backgroundColor: colors.danger },
  textButton: { flex: 1, minHeight: MIN_TOUCH, justifyContent: 'center', paddingVertical: spacing.xs },
  text: { ...type.caption, color: '#FFFFFF', fontWeight: '600' },
  close: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
});
