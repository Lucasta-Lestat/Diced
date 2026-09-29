import { router, Stack, type ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { getSettings } from '../config/settings';
import { getDb } from '../db/database';
import { errorMessage, logger } from '../lib/log';
import { registerBackgroundTask } from '../scheduling/background';
import { configureNotifications, listenForNotificationLinks } from '../scheduling/notifications';
import { runDueWorkInForeground } from '../ui/autoRun';
import { AutoRunBanner, Button, ErrorBanner } from '../ui/components';
import { pathFromDeepLink } from '../ui/forms';
import { useSettingsState } from '../ui/hooks';
import { armWeeklyReminder } from '../ui/reminder';
import { colors, spacing, type } from '../ui/theme';

const log = logger('layout');

// The background task is defined by the app entry (index.ts → src/scheduling/defineTasks.ts):
// a headless background launch never renders this layout.

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>Something went wrong</Text>
      <ErrorBanner message={error.message} />
      <Button label="Try again" onPress={() => void retry()} />
    </View>
  );
}

export default function RootLayout() {
  const { settings, error, reload } = useSettingsState();

  const ready = settings !== null;
  const onboarded = settings?.onboardingComplete ?? false;

  useEffect(() => {
    getDb().catch((e: unknown) => log.error(`database failed to open: ${errorMessage(e)}`));
    configureNotifications().catch((e: unknown) => log.warn(`notifications setup failed: ${errorMessage(e)}`));
  }, []);

  // The background task only starts once setup (including the privacy choice) is finished; the
  // task itself also does nothing before onboardingComplete. Registering again is harmless.
  useEffect(() => {
    if (!onboarded) return;
    registerBackgroundTask().catch((e: unknown) => log.warn(`background task not registered: ${errorMessage(e)}`));
  }, [onboarded]);

  // Subscribed only once the Stack is rendered, so a launching tap can navigate.
  useEffect(() => {
    if (!ready) return;
    return listenForNotificationLinks((url) => {
      const path = pathFromDeepLink(url);
      if (path) router.push(path);
    });
  }, [ready]);

  // The catch-up stays out of the way only while a screen is actually running the pipeline
  // (process-week holds that from its first effect), not merely because that screen is focused.
  useEffect(() => {
    if (!ready || !onboarded) return;
    const catchUp = () => void runDueWorkInForeground();
    catchUp();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') catchUp();
    });
    return () => sub.remove();
  }, [ready, onboarded]);

  // Re-arming once per launch keeps the reminder after an OS update/restore dropped it;
  // schedule / mode changes re-arm it from Settings. Manual mode has no weekly reminder.
  useEffect(() => {
    if (!onboarded) return;
    getSettings()
      .then(armWeeklyReminder)
      .catch((e: unknown) => log.warn(`weekly reminder not scheduled: ${errorMessage(e)}`));
  }, [onboarded]);

  if (!settings) {
    return (
      <View style={styles.center}>
        {error ? (
          <>
            <Text style={styles.title}>Diced couldn’t start</Text>
            <ErrorBanner message={error} />
            <Button label="Try again" onPress={reload} />
          </>
        ) : (
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Loading" />
        )}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.accent,
          headerTitleStyle: { color: colors.text, fontWeight: '600' },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.background },
        }}>
        <Stack.Protected guard={onboarded}>
          <Stack.Screen name="index" options={{ title: 'Diced' }} />
          <Stack.Screen name="review/index" options={{ title: 'Review' }} />
          <Stack.Screen name="review/meal/[id]" options={{ title: 'Meal' }} />
          <Stack.Screen name="review/weight/[id]" options={{ title: 'Weigh-in' }} />
          <Stack.Screen name="capture" options={{ title: 'Quick log' }} />
          <Stack.Screen name="process-week" options={{ title: 'Process photos' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack.Protected>
        <Stack.Protected guard={!onboarded}>
          <Stack.Screen name="onboarding" options={{ title: 'Set up Diced', headerBackVisible: false, gestureEnabled: false }} />
        </Stack.Protected>
        <Stack.Screen name="connect" options={{ title: 'Connect sheet' }} />
      </Stack>
      <AutoRunBanner />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'stretch',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
  },
  title: { ...type.title, color: colors.text, textAlign: 'center' },
});
