import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { getSettings, updateSettings } from '../config/settings';
import { errorMessage } from '../lib/log';
import { getPhotoPermission, requestPhotoPermission } from '../photos/scanner';
import { processPhotos } from '../pipeline/process';
import type { ProcessProgress, ProcessResult, RunReason } from '../types';
import { Button, Card, ErrorBanner, HomeFallbackHeader, Muted, Notice, ProgressView, Row, Screen, useAutoRunState, VStack } from '../ui/components';
import { formatInt, plural, runSummary, stageText } from '../ui/format';
import { firstParam } from '../ui/forms';
import { useMounted } from '../ui/hooks';
import { spacing } from '../ui/theme';
import { openSystemSettings } from '../ui/system';

type RunState =
  | { phase: 'checking' }
  | { phase: 'running'; progress: ProcessProgress | null; cancelling: boolean }
  | { phase: 'done'; result: ProcessResult; cancelled: boolean }
  | { phase: 'error'; message: string; needsPhotoAccess: boolean };

const MAX_ERRORS_SHOWN = 5;

/** In cloud mode the run needs the photo library; asks once if the user never answered. */
async function ensurePhotoAccess(): Promise<{ ok: boolean; limited: boolean }> {
  const settings = await getSettings();
  if (settings.classificationMode !== 'cloud_thumbnails') return { ok: true, limited: false };
  let permission = await getPhotoPermission();
  if (permission === 'undetermined') permission = await requestPhotoPermission();
  return { ok: permission === 'granted_all' || permission === 'granted_limited', limited: permission === 'granted_limited' };
}

export default function ProcessWeek() {
  const router = useRouter();
  const params = useLocalSearchParams<{ reason?: string | string[] }>();
  // Home's button passes reason=manual; the Shortcuts automation / notification open the bare link.
  const reason: RunReason = firstParam(params.reason) === 'manual' ? 'manual' : 'deeplink';
  const [state, setState] = useState<RunState>({ phase: 'checking' });
  const [limited, setLimited] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mountedRef = useMounted();

  // Bumped by "Try again" / "Run again"; each value starts one run.
  const [runId, setRunId] = useState(0);

  // Leaving the screen doesn't cancel: the run is resumable and finishes in the background of the UI.
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const set = (next: RunState) => {
      if (mountedRef.current) setState(next);
    };
    const run = async () => {
      try {
        const access = await ensurePhotoAccess();
        if (mountedRef.current) setLimited(access.limited);
        if (!access.ok) {
          set({ phase: 'error', message: 'Diced needs access to your photos to find scale and food pictures.', needsPhotoAccess: true });
          return;
        }
        set({ phase: 'running', progress: null, cancelling: false });
        const result = await processPhotos({
          reason,
          signal: abort.signal,
          onProgress: (progress) => set({ phase: 'running', progress, cancelling: abort.signal.aborted }),
        });
        // The Shortcuts automation is iOS's weekly run: count it so the app doesn't run again on open.
        if (reason === 'deeplink' && !result.partial && !abort.signal.aborted) {
          await updateSettings({ lastAutoRunAt: Date.now() });
        }
        set({ phase: 'done', result, cancelled: abort.signal.aborted });
      } catch (e) {
        set({ phase: 'error', message: errorMessage(e), needsPhotoAccess: false });
      }
    };
    void run();
  }, [mountedRef, reason, runId]);

  const restart = () => {
    setState({ phase: 'checking' });
    setRunId((n) => n + 1);
  };

  const cancel = () => {
    controller.current?.abort();
    setState((s) => (s.phase === 'running' ? { ...s, cancelling: true } : s));
  };

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // When a foreground catch-up run started first, this screen shares its promise; show its progress.
  const auto = useAutoRunState();
  const progress = state.phase === 'running' ? (state.progress ?? (auto.phase === 'processing' ? auto.progress : null)) : null;

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
          <Button variant={state.needsPhotoAccess ? 'secondary' : 'primary'} label="Try again" onPress={restart} />
          <Button variant="ghost" label="Done" onPress={leave} />
        </VStack>
      ) : null}

      {state.phase === 'done' ? <DoneCard result={state.result} cancelled={state.cancelled} onAgain={restart} onDone={leave} /> : null}
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
        {result.partial || cancelled ? <Muted>The rest is picked up on the next run.</Muted> : null}
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
