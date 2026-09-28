import type { ReactNode } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../theme';

export interface ScreenProps {
  children: ReactNode;
  /** Enables pull-to-refresh when given. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Pinned below the scrolling content (e.g. Approve / Reject). */
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * Scrolling page body. The stack header already covers the top inset, so only the bottom
 * (home indicator / gesture bar) is padded here.
 */
export function Screen({ children, onRefresh, refreshing = false, footer, contentStyle }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const bottomPad = spacing.xl + (footer ? 0 : insets.bottom);
  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }, contentStyle]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
          ) : undefined
        }>
        {children}
      </ScrollView>
      {footer ? <View style={[styles.footer, { paddingBottom: spacing.md + insets.bottom }]}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
});
