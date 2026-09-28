import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { getSecret, setSecret, updateSettings } from '../config/settings';
import { lastRuns } from '../db/runs';
import { getPhotoPermission, requestPhotoPermission, type PhotoPermission } from '../photos/scanner';
import { backgroundTaskStatus, registerBackgroundTask } from '../scheduling/background';
import { requestNotificationPermission, scheduleWeeklyReminder } from '../scheduling/notifications';
import { getSheetInfo, refreshSheetInfo } from '../sync/sheetsClient';
import { syncNow } from '../sync/syncQueue';
import type { AppSettings } from '../types';
import {
  Button,
  ButtonRow,
  Card,
  ClaudeKeyForm,
  ErrorBanner,
  Muted,
  Notice,
  NumberField,
  Row,
  ScheduleEditor,
  Screen,
  SectionHeader,
  SegmentedControl,
  ShortcutsHowTo,
  TextField,
  ToggleRow,
  type Schedule,
} from '../ui/components';
import { relativeTime, runSummary, syncSummary } from '../ui/format';
import { useAction, useAsync, useFocusRefresh, useNow, useSettings } from '../ui/hooks';
import { spacing } from '../ui/theme';
import { openSystemSettings } from '../ui/system';

const PERMISSION_TEXT: Record<PhotoPermission, string> = {
  granted_all: 'Full access',
  granted_limited: 'Limited — new photos are not visible',
  denied: 'Not allowed',
  undetermined: 'Not asked yet',
};

async function loadStatus() {
  const [info, token, usda, photos, background, runs] = await Promise.all([
    getSheetInfo(),
    getSecret('sheetToken'),
    getSecret('usdaApiKey'),
    getPhotoPermission().catch(() => null),
    backgroundTaskStatus(),
    lastRuns(5),
  ]);
  return { info, hasToken: token !== null, hasUsda: usda !== null, photos, background, runs };
}

export default function Settings() {
  const settings = useSettings();
  const status = useAsync(loadStatus);
  useFocusRefresh(status.reload);
  const update = useAction((patch: Partial<AppSettings>) => updateSettings(patch));

  if (!settings) return <Screen>{null}</Screen>;
  const footer = update.error ? <ErrorBanner title="Couldn't save that setting" message={update.error} onDismiss={() => update.setError(null)} /> : undefined;

  return (
    <Screen footer={footer} onRefresh={() => void status.reload()}>
      <ErrorBanner message={status.error} onRetry={() => void status.reload()} />
      <PersonSection settings={settings} people={status.data?.info?.people} onChange={(person) => void update.run({ person })} />
      <SheetSection settings={settings} hasToken={status.data?.hasToken ?? false} sheetName={status.data?.info?.spreadsheetName ?? null} onTested={() => void status.reload()} />

      <SectionHeader title="Claude" />
      <Card>
        <ClaudeKeyForm />
        <TextField
          label="Model"
          defaultValue={settings.model}
          onEndEditing={(e) => {
            const model = e.nativeEvent.text.trim();
            if (model && model !== settings.model) void update.run({ model });
          }}
          autoCapitalize="none"
          autoCorrect={false}
          helper="Claude model id used for reading scales and estimating meals."
        />
      </Card>

      <ScheduleSection settings={settings} backgroundStatus={status.data?.background ?? null} onToggleDaily={(processDaily) => void update.run({ processDaily })} />
      <PrivacySection
        settings={settings}
        photos={status.data?.photos ?? null}
        onMode={(classificationMode) => void update.run({ classificationMode })}
        onPermissionChanged={() => void status.reload()}
      />
      <AccuracySection settings={settings} hasUsda={status.data?.hasUsda ?? false} update={(patch) => void update.run(patch)} onUsdaChanged={() => void status.reload()} />
      <NotificationsSection />
      <ActionsSection runs={status.data?.runs ?? []} onSynced={() => void status.reload()} />
      <SetupSection />
    </Screen>
  );
}

function PersonSection({ settings, people, onChange }: { settings: AppSettings; people?: string[]; onChange: (p: string) => void }) {
  const options = (people?.length ? people : ['Her', 'Him']).map((p) => ({ value: p, label: p }));
  return (
    <>
      <SectionHeader title="This phone logs for" />
      <SegmentedControl accessibilityLabel="Person" options={options} value={settings.person} onChange={onChange} />
    </>
  );
}

function SheetSection({ settings, hasToken, sheetName, onTested }: { settings: AppSettings; hasToken: boolean; sheetName: string | null; onTested: () => void }) {
  const router = useRouter();
  const [ok, setOk] = useState<string | null>(null);
  const test = useAction(async () => {
    setOk(null);
    const info = await refreshSheetInfo();
    setOk(`Connected to ${info.spreadsheetName}.`);
    onTested();
  });
  return (
    <>
      <SectionHeader title="Google Sheet" />
      <Card>
        <Row label="Sheet" value={sheetName ?? (settings.sheetWebAppUrl ? 'Connected' : 'Not connected')} />
        <Row label="App token" value={hasToken ? 'Saved' : 'Missing'} />
        <ButtonRow>
          <Button compact label="Test" onPress={() => void test.run()} loading={test.pending} disabled={!settings.sheetWebAppUrl} accessibilityLabel="Test sheet connection" />
          <Button compact variant="secondary" label="Change…" onPress={() => router.push('/connect')} accessibilityLabel="Change sheet connection" />
        </ButtonRow>
        {ok ? <Notice tone="success" message={ok} /> : null}
        <ErrorBanner message={test.error} />
      </Card>
    </>
  );
}

function ScheduleSection({
  settings,
  backgroundStatus,
  onToggleDaily,
}: {
  settings: AppSettings;
  backgroundStatus: 'available' | 'restricted' | 'unavailable' | null;
  onToggleDaily: (v: boolean) => void;
}) {
  const save = useAction(async (s: Schedule) => {
    const next = await updateSettings({ scheduleWeekday: s.weekday, scheduleHour: s.hour, scheduleMinute: s.minute });
    await scheduleWeeklyReminder(next);
  });
  const schedule: Schedule = { weekday: settings.scheduleWeekday, hour: settings.scheduleHour, minute: settings.scheduleMinute };
  return (
    <>
      <SectionHeader title="Weekly run" />
      <Card>
        <ScheduleEditor value={schedule} onChange={(s) => void save.run(s)} disabled={save.pending} />
        <ErrorBanner message={save.error} />
        <ToggleRow
          label="Also check for new photos daily"
          description={Platform.OS === 'ios' ? 'Best effort on iPhone: runs when iOS allows or when you open the app.' : 'Runs in the background about once a day.'}
          value={settings.processDaily}
          onValueChange={onToggleDaily}
        />
        {Platform.OS === 'android' ? (
          <Muted>
            Background processing:{' '}
            {backgroundStatus === 'available' ? 'on' : backgroundStatus === 'restricted' ? 'restricted by the system (battery settings)' : 'unavailable'}
          </Muted>
        ) : null}
      </Card>
      {Platform.OS === 'ios' ? (
        <Card title="iPhone automation">
          <ShortcutsHowTo weekday={settings.scheduleWeekday} hour={settings.scheduleHour} minute={settings.scheduleMinute} />
        </Card>
      ) : null}
    </>
  );
}

function PrivacySection({
  settings,
  photos,
  onMode,
  onPermissionChanged,
}: {
  settings: AppSettings;
  photos: PhotoPermission | null;
  onMode: (m: AppSettings['classificationMode']) => void;
  onPermissionChanged: () => void;
}) {
  const ask = useAction(async () => {
    const result = await requestPhotoPermission();
    onPermissionChanged();
    if (result !== 'granted_all') openSystemSettings();
  });
  return (
    <>
      <SectionHeader title="Photos & privacy" />
      <Card>
        <SegmentedControl
          accessibilityLabel="Photo scanning"
          options={[
            { value: 'cloud_thumbnails', label: 'Automatic' },
            { value: 'manual', label: 'Manual' },
          ]}
          value={settings.classificationMode}
          onChange={onMode}
        />
        <Muted>
          {settings.classificationMode === 'cloud_thumbnails'
            ? 'Small, EXIF-stripped thumbnails of the week’s photos (not screenshots or chat images) go to Claude to find scale and food photos; only those are then sent full-size to be read.'
            : 'Nothing is scanned or sent automatically. Use Quick log to photograph or pick photos yourself.'}
        </Muted>
        <Row label="Photo access" value={photos ? PERMISSION_TEXT[photos] : '—'} />
        {photos !== 'granted_all' ? (
          <Button variant="secondary" label={photos === 'undetermined' ? 'Allow photo access' : 'Open Settings'} onPress={() => void ask.run()} loading={ask.pending} />
        ) : null}
        <ErrorBanner message={ask.error} />
      </Card>
    </>
  );
}

function AccuracySection({
  settings,
  hasUsda,
  update,
  onUsdaChanged,
}: {
  settings: AppSettings;
  hasUsda: boolean;
  update: (patch: Partial<AppSettings>) => void;
  onUsdaChanged: () => void;
}) {
  const [usda, setUsda] = useState('');
  const saveUsda = useAction(async (value: string | null) => {
    await setSecret('usdaApiKey', value);
    setUsda('');
    onUsdaChanged();
  });
  return (
    <>
      <SectionHeader title="Accuracy" />
      <Card>
        <SegmentedControl
          accessibilityLabel="Estimate mode"
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'thorough', label: 'Thorough' },
          ]}
          value={settings.accuracyMode}
          onChange={(accuracyMode) => update({ accuracyMode })}
        />
        <Muted>Thorough runs two independent estimates per meal and lowers confidence when they disagree (about twice the cost).</Muted>
        <ToggleRow
          label="Look up restaurant nutrition"
          description="When a chain restaurant or brand is recognised, search the web for its published numbers."
          value={settings.webLookupForRestaurants}
          onValueChange={(webLookupForRestaurants) => update({ webLookupForRestaurants })}
        />
        <NumberField
          label="Dinner plate diameter"
          unit="in"
          decimals={1}
          value={settings.plateDiameterIn}
          min={5}
          max={16}
          helper="Measure your usual plate — it gives Claude a sense of scale."
          onCommit={(plateDiameterIn) => update({ plateDiameterIn })}
        />
        <NumberField
          label="Photos this close belong to one meal"
          unit="min"
          value={settings.mealGroupingMinutes}
          min={1}
          max={180}
          onCommit={(v) => {
            if (v !== null) update({ mealGroupingMinutes: Math.round(v) });
          }}
        />
      </Card>

      <SectionHeader title="Scale" />
      <Card>
        <SegmentedControl
          accessibilityLabel="Scale display unit"
          options={[
            { value: 'lb', label: 'Scale shows lb' },
            { value: 'kg', label: 'Scale shows kg' },
          ]}
          value={settings.scaleUnit}
          onChange={(scaleUnit) => update({ scaleUnit })}
        />
        <NumberField
          label="Morning weigh-ins are before"
          unit="h"
          value={settings.morningCutoffHour}
          min={4}
          max={16}
          helper="The earliest reading before this hour is the day's official weight."
          onCommit={(v) => {
            if (v !== null) update({ morningCutoffHour: Math.round(v) });
          }}
        />
      </Card>

      <SectionHeader title="USDA FoodData Central (optional)" />
      <Card>
        <Muted>{hasUsda ? 'Your own key is saved.' : 'Using the shared demo key. A free key gives more lookups per hour.'}</Muted>
        <TextField label="USDA API key" value={usda} onChangeText={setUsda} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <ButtonRow>
          <Button compact label="Save key" onPress={() => void saveUsda.run(usda)} loading={saveUsda.pending} disabled={!usda.trim()} />
          {hasUsda ? <Button compact variant="destructive" label="Remove" onPress={() => void saveUsda.run(null)} accessibilityLabel="Remove USDA key" /> : null}
        </ButtonRow>
        <ErrorBanner message={saveUsda.error} />
      </Card>
    </>
  );
}

function NotificationsSection() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const ask = useAction(async () => {
    const ok = await requestNotificationPermission();
    setGranted(ok);
    if (!ok) openSystemSettings();
  });
  return (
    <>
      <SectionHeader title="Notifications" />
      <Card>
        <Muted>Used for the weekly reminder and “ready to review”.</Muted>
        <Button variant="secondary" label="Allow notifications" onPress={() => void ask.run()} loading={ask.pending} />
        {granted !== null ? <Notice tone={granted ? 'success' : 'warning'} message={granted ? 'Notifications are on.' : 'Notifications are off — turn them on in Settings.'} /> : null}
        <ErrorBanner message={ask.error} />
      </Card>
    </>
  );
}

function ActionsSection({ runs, onSynced }: { runs: Awaited<ReturnType<typeof lastRuns>>; onSynced: () => void }) {
  const router = useRouter();
  const now = useNow();
  const [synced, setSynced] = useState<string | null>(null);
  const sync = useAction(async () => {
    const r = await syncNow();
    setSynced(syncSummary(r));
    onSynced();
    if (r.errors.length) throw new Error(r.errors.join('\n'));
  });
  const register = useAction(registerBackgroundTask);
  return (
    <>
      <SectionHeader title="Run" />
      <Card>
        <ButtonRow>
          <Button compact label="Run now" onPress={() => router.push('/process-week?reason=manual')} accessibilityLabel="Process new photos now" />
          <Button compact variant="secondary" label="Sync now" onPress={() => void sync.run()} loading={sync.pending} />
        </ButtonRow>
        {synced ? <Notice tone="info" message={synced} /> : null}
        <ErrorBanner title="Sync problems" message={sync.error} />
        {Platform.OS === 'android' ? (
          <Button variant="ghost" label="Re-register background job" onPress={() => void register.run()} loading={register.pending} />
        ) : null}
        <ErrorBanner message={register.error} />
      </Card>
      <SectionHeader title="Recent runs" />
      <Card>
        {runs.length === 0 ? <Muted>No runs yet.</Muted> : null}
        {runs.map((r) => (
          <View key={r.id} style={styles.run}>
            <Row label={`${relativeTime(r.finishedAt, now)} · ${r.reason}`} detail={runSummary(r)} />
          </View>
        ))}
      </Card>
    </>
  );
}

function SetupSection() {
  const redo = useAction(() => updateSettings({ onboardingComplete: false }));
  const confirm = () =>
    Alert.alert('Run setup again?', 'Your entries and settings are kept; you’ll step through the setup screens again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Run setup', onPress: () => void redo.run() },
    ]);
  return (
    <>
      <Button variant="ghost" label="Run setup again" onPress={confirm} />
      <ErrorBanner message={redo.error} />
    </>
  );
}

const styles = StyleSheet.create({
  run: { gap: spacing.xxs },
});
