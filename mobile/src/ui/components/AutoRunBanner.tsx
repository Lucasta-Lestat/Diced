import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  dismissAutoRun,
  getAutoRunState,
  getUiRunSnapshot,
  subscribeAutoRun,
  subscribeSyncDone,
  subscribeUiRun,
  type AutoRunState,
  type UiRunSnapshot,
} from '../autoRun';
import { autoRunBannerShown, progressLine } from '../autoRunPolicy';
import { getFooterInset, subscribeFooterInset } from '../bannerInset';
import { useLatest } from '../hooks';
import { colors, MIN_TOUCH, radius, spacing, type } from '../theme';

/** Room the banner takes above its bottom offset (one or two caption lines, or the 44-pt minimum). */
export const BANNER_CLEARANCE = MIN_TOUCH + spacing.md;

/** Live state of the foreground catch-up run. */
export function useAutoRunState(): AutoRunState {
  const [state, setState] = useState<AutoRunState>(getAutoRunState);
  useEffect(() => subscribeAutoRun(setState), []);
  return state;
}

/** The UI's shared pipeline run (whoever started it): its promise and latest progress. */
export function useUiRun(): UiRunSnapshot {
  return useSyncExternalStore(subscribeUiRun, getUiRunSnapshot);
}

/** True while the floating banner covers the bottom of the current screen. */
export function useAutoRunBannerShown(): boolean {
  const state = useAutoRunState();
  const pathname = usePathname();
  return autoRunBannerShown(state, pathname);
}

/** Calls `onSynced` after each background sync (review decisions, catch-up), so lists stay current. */
export function useOnSyncDone(onSynced: () => unknown): void {
  const ref = useLatest(onSynced);
  useEffect(
    () =>
      subscribeSyncDone(() => {
        void ref.current();
      }),
    [ref],
  );
}

/** Small floating status for the foreground catch-up run. */
export function AutoRunBanner() {
  const state = useAutoRunState();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const footer = useSyncExternalStore(subscribeFooterInset, getFooterInset);

  if (!autoRunBannerShown(state, pathname)) return null;

  const text =
    state.phase === 'processing'
      ? `Processing new photos · ${progressLine(state.progress)}`
      : state.phase === 'idle'
        ? ''
        : state.message;
  const canOpenReview = state.phase === 'done' && state.hasNew;
  // Above a pinned footer (Approve / Reject) rather than on top of its buttons.
  const bottom = footer > 0 ? footer + spacing.sm : insets.bottom + spacing.md;

  return (
    <View style={[styles.wrap, { bottom }]}>
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
        <Pressable
          onPress={dismissAutoRun}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          accessibilityHint={state.phase === 'processing' ? 'Hides this message; processing continues' : undefined}
          hitSlop={8}
          style={styles.close}>
          <Text style={styles.text}>✕</Text>
        </Pressable>
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
