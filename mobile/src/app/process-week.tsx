import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { getSettings, updateSettings } from '../config/settings';
import { errorMessage } from '../lib/log';
import { getPhotoPermission, requestPhotoPermission } from '../photos/scanner';
import type { ProcessResult, RunReason } from '../types';
import { cancelSharedRun, getUiRunSnapshot, holdScreenRun, startSharedRun, subscribeUiRun } from '../ui/autoRun';
import { isProcessWeekLink } from '../ui/autoRunPolicy';
import { Button, Card, ErrorBanner, HomeFallbackHeader, Muted, Notice, ProgressView, Row, Screen, useUiRun, VStack } from '../ui/components';
import { formatInt, plural, runSummary, stageText } from '../ui/format';
import { firstParam } from '../ui/forms';
import { useMounted } from '../ui/hooks';
import { spacing } from '../ui/theme';
import { openSystemSettings } from '../ui/system';

type RunState =
  | { phase: 'checking' }
  | { phase: 'running'; cancelling: boolean }
  | { phase: 'done'; result: ProcessResult; cancelled: boolean }
  | { phase: 'error'; message: string; needsPhotoAccess: boolean };

/** One run of this screen: start (or join) a run for `reason`, or follow `join`, a run already going. */
interface Trigger {
  id: number;
  reason: RunReason;
  join: Promise<ProcessResult> | null;
}

const MAX_ERRORS_SHOWN = 5;

/** In cloud mode the run needs the photo library; asks once if the user never answered. */
async function ensurePhotoAccess(): Promise<{ ok: boolean; limited: boolean }> {
  const settings = await getSettings();
  if (settings.classificationMode !== 'cloud_thumbnails') return { ok: true, limited: false };
  let permission = await getPhotoPermission();
  if (permission === 'undetermined') permission = await requestPhotoPermission();
  return { ok: permission === 'granted_all' || permission === 'granted_limited', limited: permission === 'granted_limited' };
}

const isIdle = (phase: RunState['phase']) => phase === 'done' || phase === 'error';

export default function ProcessWeek() {
  const router = useRouter();
  const params = useLocalSearchParams<{ reason?: string | string[] }>();
  // Home's button passes reason=manual; the Shortcuts automation / notification open the bare link.
  const initialReason: RunReason = firstParam(params.reason) === 'manual' ? 'manual' : 'deeplink';
  const [state, setState] = useState<RunState>({ phase: 'checking' });
  const [limited, setLimited] = useState(false);
  const mountedRef = useMounted();
  const phaseRef = useRef<RunState['phase']>('checking');
  const cancelRequested = useRef(false);

  // Each new trigger starts one run: "Try again" / "Run again", a diced://process-week link arriving
  // while this screen shows a result, or a run started elsewhere (the foreground catch-up).
  const [trigger, setTrigger] = useState<Trigger>(() => ({ id: 0, reason: initialReason, join: null }));

  // Leaving the screen doesn't cancel: the run is resumable and finishes in the background of the UI.
  useEffect(() => {
    const set = (next: RunState) => {
      phaseRef.current = next.phase;
      if (mountedRef.current) setState(next);
    };
    // Held from this first (synchronous) moment, so the root layout's catch-up — whose effect runs
    // after this child's on a cold deep-link launch — doesn't start a run of its own.
    const release = holdScreenRun();
    cancelRequested.current = false;
    const run = async () => {
      try {
        let promise = trigger.join;
        if (!promise) {
          const access = await ensurePhotoAccess();
          if (mountedRef.current) setLimited(access.limited);
          if (!access.ok) {
            set({ phase: 'error', message: 'Diced needs access to your photos to find scale and food pictures.', needsPhotoAccess: true });
            return;
          }
          // Joins the catch-up's run when one is already going, so Cancel and progress follow it.
          promise = startSharedRun(trigger.reason);
        }
        set({ phase: 'running', cancelling: cancelRequested.current });
        const result = await promise;
        // The Shortcuts automation is iOS's weekly run: count it so the app doesn't run again on open.
        if (trigger.reason === 'deeplink' && !trigger.join && !result.partial) {
          await updateSettings({ lastAutoRunAt: Date.now() });
        }
        set({ phase: 'done', result, cancelled: cancelRequested.current && result.partial });
      } catch (e) {
        set({ phase: 'error', message: errorMessage(e), needsPhotoAccess: false });
      } finally {
        release();
      }
    };
    void run();
  }, [mountedRef, trigger]);

  const restart = (reason: RunReason, join: Promise<ProcessResult> | null = null) => {
    phaseRef.current = 'checking';
    setState({ phase: 'checking' });
    setTrigger((t) => ({ id: t.id + 1, reason, join }));
  };
  const restartRef = useRef(restart);
  useEffect(() => {
    restartRef.current = restart;
  });

  // A run started elsewhere while this screen shows an old result (e.g. the catch-up after the app
  // resumed here): follow it instead of showing last week's summary.
  useEffect(
    () =>
      subscribeUiRun(() => {
        const { promise } = getUiRunSnapshot();
        if (promise && isIdle(phaseRef.current)) restartRef.current(trigger.reason, promise);
      }),
    // Only the reason is read; re-subscribing per trigger is harmless.
    [trigger.reason],
  );

  // A Shortcuts / notification link that arrives while this screen is already open is routed to this
  // same screen (no remount), so start the run here. While a run is going, the link just joins it.
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (isProcessWeekLink(url) && isIdle(phaseRef.current)) restartRef.current('deeplink');
    });
    return () => sub.remove();
  }, []);

  const cancel = () => {
    cancelRequested.current = true;
    cancelSharedRun();
    setState((s) => (s.phase === 'running' ? { ...s, cancelling: true } : s));
  };

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // Progress of whichever run is going — this screen's or one it joined.
  const uiRun = useUiRun();
  const progress = state.phase === 'running' ? uiRun.progress : null;

  return (
    <Screen>
      <HomeFallbackHeader />
      {limited ? (
        <Notice
          tone="warning"
          title="Limited photo access"
          message="Only the photos you shared with Diced can be checked. Allow full access to find new ones automatically."
          actionLabel="Settings"
          onAction={openSystemSettings}
        />
      ) : null}

      {state.phase === 'checking' || state.phase === 'running' ? (
        <Card>
          <ProgressView
            label={progress ? stageText(progress.stage) : 'Getting ready…'}
            message={progress?.message}
            done={progress?.done ?? 0}
            total={progress?.total ?? 0}
          />
          <Muted>You can leave this screen — processing continues and results appear in Review.</Muted>
          <Button
            variant="secondary"
            label={state.phase === 'running' && state.cancelling ? 'Stopping…' : 'Cancel'}
            onPress={cancel}
            disabled={state.phase !== 'running' || state.cancelling}
            accessibilityHint="Stops after the current photo; the rest is picked up next time"
          />
        </Card>
      ) : null}

      {state.phase === 'error' ? (
        <VStack>
          <ErrorBanner title="Processing stopped" message={state.message} />
          {state.needsPhotoAccess ? <Button label="Open Settings" onPress={openSystemSettings} /> : null}
          <Button variant={state.needsPhotoAccess ? 'secondary' : 'primary'} label="Try again" onPress={() => restart(trigger.reason)} />
          <Button variant="ghost" label="Done" onPress={leave} />
        </VStack>
      ) : null}

      {state.phase === 'done' ? <DoneCard result={state.result} cancelled={state.cancelled} onAgain={() => restart(trigger.reason)} onDone={leave} /> : null}
    </Screen>
  );
}

function DoneCard({ result, cancelled, onAgain, onDone }: { result: ProcessResult; cancelled: boolean; onAgain: () => void; onDone: () => void }) {
  const router = useRouter();
  const found = result.weightEntriesCreated + result.mealsCreated;
  return (
    <VStack>
      <Card title={cancelled ? 'Stopped' : 'Done'} subtitle={runSummary(result)}>
        <View style={styles.rows}>
          <Row label="Photos checked" value={formatInt(result.photosScanned)} />
          <Row label="Skipped (screenshots, chats…)" value={formatInt(result.photosExcluded)} />
          <Row label="Scale photos" value={formatInt(result.scalePhotos)} />
          <Row label="Food photos" value={formatInt(result.foodPhotos)} />
          <Row label="New weigh-ins" value={formatInt(result.weightEntriesCreated)} />
          <Row label="New meals" value={formatInt(result.mealsCreated)} />
        </View>
        {result.partial ? <Muted>The rest is picked up on the next run.</Muted> : null}
      </Card>
      {result.errors.length ? (
        <ErrorBanner
          title={plural(result.errors.length, 'problem')}
          message={
            result.errors.slice(0, MAX_ERRORS_SHOWN).join('\n') +
            (result.errors.length > MAX_ERRORS_SHOWN ? `\n…and ${result.errors.length - MAX_ERRORS_SHOWN} more` : '')
          }
        />
      ) : null}
      <Button label={found ? `Review ${plural(found, 'new entry', 'new entries')}` : 'Open Review'} onPress={() => router.replace('/review')} />
      <Button variant="secondary" label="Run again" onPress={onAgain} />
      <Button variant="ghost" label="Done" onPress={onDone} />
    </VStack>
  );
}

const styles = StyleSheet.create({
  rows: { gap: spacing.xxs },
});
