import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { getSecret, updateSettings } from '../config/settings';
import { requestPhotoPermission, type PhotoPermission } from '../photos/scanner';
import { registerBackgroundTask } from '../scheduling/background';
import { requestNotificationPermission } from '../scheduling/notifications';
import { getSheetInfo } from '../sync/sheetsClient';
import type { AppSettings, ClassificationMode } from '../types';
import {
  Body,
  Bullets,
  Button,
  Card,
  ClaudeKeyForm,
  ErrorBanner,
  Heading,
  Muted,
  Notice,
  ScheduleEditor,
  Screen,
  SegmentedControl,
  SheetConnectForm,
  ShortcutsHowTo,
  ToggleRow,
  VStack,
  type Schedule,
} from '../ui/components';
import { formatClock, weekdayName } from '../ui/format';
import { useAction, useAsync, useSettings } from '../ui/hooks';
import { armWeeklyReminder } from '../ui/reminder';
import { colors, spacing, type } from '../ui/theme';
import { openSystemSettings } from '../ui/system';

const STEPS = ['welcome', 'sheet', 'person', 'claude', 'photos', 'notifications', 'privacy', 'schedule', 'done'] as const;
type Step = (typeof STEPS)[number];

/** Resume where setup left off (e.g. after a diced://connect link saved the sheet and person). */
async function resumeStep(settings: AppSettings): Promise<Step> {
  const token = await getSecret('sheetToken');
  if (!settings.sheetWebAppUrl || !token) return 'welcome';
  if (!settings.person) return 'person';
  return 'claude';
}

export default function Onboarding() {
  const settings = useSettings();
  const [step, setStep] = useState<Step | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings || step !== null) return;
    resumeStep(settings).then(setStep, (e: unknown) => {
      setResumeError(e instanceof Error ? e.message : String(e));
      setStep('welcome');
    });
  }, [settings, step]);

  // A connect link opened mid-setup fills in the sheet and person; skip ahead — but only on
  // that change, so going back to "sheet" on purpose still works.
  const connected = Boolean(settings?.sheetWebAppUrl && settings.person);
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current && (step === 'welcome' || step === 'sheet')) setStep('claude');
    wasConnected.current = connected;
  }, [connected, step]);

  if (!settings || step === null) {
    return (
      <Screen>
        <Muted>Loading…</Muted>
      </Screen>
    );
  }

  const index = STEPS.indexOf(step);
  const go = (to: Step) => setStep(to);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]);
  const back = index > 0 ? () => setStep(STEPS[index - 1]) : undefined;

  return (
    <Screen>
      <Text style={styles.progress} accessibilityLabel={`Step ${index + 1} of ${STEPS.length}`}>
        Step {index + 1} of {STEPS.length}
      </Text>
      <ErrorBanner message={resumeError} />
      {step === 'welcome' ? <Welcome onNext={next} /> : null}
      {step === 'sheet' ? <SheetStep settings={settings} onNext={next} /> : null}
      {step === 'person' ? <PersonStep settings={settings} onNext={next} onChangeSheet={() => go('sheet')} /> : null}
      {step === 'claude' ? <ClaudeStep onNext={next} /> : null}
      {step === 'photos' ? <PhotosStep onNext={next} /> : null}
      {step === 'notifications' ? <NotificationsStep onNext={next} /> : null}
      {step === 'privacy' ? <PrivacyStep settings={settings} onNext={next} /> : null}
      {step === 'schedule' ? <ScheduleStep settings={settings} onNext={next} /> : null}
      {step === 'done' ? <DoneStep settings={settings} /> : null}
      {back && step !== 'done' ? <Button variant="ghost" label="Back" onPress={back} accessibilityLabel="Previous step" /> : null}
    </Screen>
  );
}

function StepFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <VStack gap={spacing.lg}>
      <Heading>{title}</Heading>
      {children}
    </VStack>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <StepFrame title="Welcome to Diced">
      <Body>Diced turns the photos already on your phone into rows in your training-plan Google Sheet.</Body>
      <Bullets
        items={[
          'Scale photos become one weigh-in per day; the sheet shows each week’s 7-day average.',
          'Food photos become meals with calories and macros, which you review before anything is saved.',
          'It runs once a week on its own, and you can log anything by hand.',
        ]}
      />
      <Muted>Setup takes about three minutes. Have the sheet’s connect link (Diced menu → Show app connection info) ready.</Muted>
      <Button label="Get started" onPress={onNext} />
    </StepFrame>
  );
}

function SheetStep({ settings, onNext }: { settings: AppSettings; onNext: () => void }) {
  return (
    <StepFrame title="Connect the sheet">
      <Body>
        Easiest: in the sheet choose Diced → Show app connection info, then scan its QR code with this phone’s camera or tap the
        diced://connect link (for example in an email to yourself). It fills everything in. Or paste the URL and token here.
      </Body>
      <Card>
        <SheetConnectForm initialUrl={settings.sheetWebAppUrl ?? ''} choosePerson={false} saveLabel="Save and continue" onSaved={onNext} />
      </Card>
    </StepFrame>
  );
}

function PersonStep({ settings, onNext, onChangeSheet }: { settings: AppSettings; onNext: () => void; onChangeSheet: () => void }) {
  const info = useAsync(getSheetInfo);
  const [person, setPerson] = useState<string | null>(settings.person);
  const save = useAction(async () => {
    if (!person) return;
    await updateSettings({ person });
    onNext();
  });
  const people = info.data?.people.length ? info.data.people : ['Her', 'Him'];
  return (
    <StepFrame title="Who uses this phone?">
      <Body>Each phone logs for one person. Your partner sets up their own phone the same way.</Body>
      {info.data ? <Muted>Connected to {info.data.spreadsheetName}.</Muted> : null}
      <SegmentedControl accessibilityLabel="Person" options={people.map((p) => ({ value: p, label: p }))} value={person} onChange={setPerson} />
      <ErrorBanner message={save.error ?? info.error} />
      <Button label="Continue" onPress={() => void save.run()} loading={save.pending} disabled={!person} />
      <Button variant="ghost" label="Use a different sheet" onPress={onChangeSheet} />
    </StepFrame>
  );
}

function ClaudeStep({ onNext }: { onNext: () => void }) {
  const [skipped, setSkipped] = useState(false);
  return (
    <StepFrame title="Claude API key">
      <Body>
        Claude reads the scale and estimates meals. Create a key at platform.claude.com → API keys. It stays in this phone’s
        secure storage and is only sent to Anthropic.
      </Body>
      <Card>
        <ClaudeKeyForm onSaved={onNext} />
      </Card>
      {skipped ? <Notice tone="warning" message="Without a key nothing can be read or estimated. Add it later in Settings." /> : null}
      <Button
        variant="ghost"
        label={skipped ? 'Continue without a key' : 'Skip for now'}
        onPress={() => (skipped ? onNext() : setSkipped(true))}
      />
    </StepFrame>
  );
}

function PhotosStep({ onNext }: { onNext: () => void }) {
  const [result, setResult] = useState<PhotoPermission | null>(null);
  const ask = useAction(async () => setResult(await requestPhotoPermission()));
  const full = Platform.OS === 'ios' ? 'Allow Full Access' : 'Allow all';
  const partial = Platform.OS === 'ios' ? 'Limited Access' : 'Select photos';
  return (
    <StepFrame title="Photo access">
      <Body>Diced looks through the photos you take each week to find the scale and your meals.</Body>
      <Bullets
        items={[
          <Text key="full">
            Choose <Text style={styles.strong}>{full}</Text>. New photos are then found automatically.
          </Text>,
          <Text key="limited">
            With <Text style={styles.strong}>{partial}</Text>, Diced only sees the photos you pick in that moment — tomorrow’s
            weigh-in wouldn’t be visible.
          </Text>,
          'Diced never changes or deletes your photos, and doesn’t read their location.',
        ]}
      />
      {result === 'granted_all' ? <Notice tone="success" message="Full access granted." /> : null}
      {result === 'granted_limited' ? (
        <Notice tone="warning" title="Limited access" message={`Switch to “${full}” in Settings so new photos are found.`} actionLabel="Settings" onAction={openSystemSettings} />
      ) : null}
      {result === 'denied' ? (
        <Notice
          tone="warning"
          title="No photo access"
          message="You can still use manual mode and Quick log, or allow access in Settings."
          actionLabel="Settings"
          onAction={openSystemSettings}
        />
      ) : null}
      <ErrorBanner message={ask.error} />
      {result === null ? (
        <Button label="Allow photo access" onPress={() => void ask.run()} loading={ask.pending} />
      ) : (
        <Button label="Continue" onPress={onNext} />
      )}
      {result === null ? <Button variant="ghost" label="Not now" onPress={onNext} /> : null}
    </StepFrame>
  );
}

function NotificationsStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const ask = useAction(async () => setGranted(await requestNotificationPermission()));
  return (
    <StepFrame title="Notifications">
      <Body>
        Diced sends a weekly reminder to process your week (in automatic mode) and a note when new weigh-ins and meals are ready
        to review. Nothing else.
      </Body>
      {granted === true ? <Notice tone="success" message="Notifications are on." /> : null}
      {granted === false ? <Notice tone="warning" message="Notifications are off. You can turn them on later in Settings." /> : null}
      <ErrorBanner message={ask.error} />
      {granted === null ? (
        <>
          <Button label="Allow notifications" onPress={() => void ask.run()} loading={ask.pending} />
          <Button variant="ghost" label="Not now" onPress={onNext} />
        </>
      ) : (
        <Button label="Continue" onPress={onNext} />
      )}
    </StepFrame>
  );
}

function PrivacyStep({ settings, onNext }: { settings: AppSettings; onNext: () => void }) {
  const [mode, setMode] = useState<ClassificationMode>(settings.classificationMode);
  const save = useAction(async () => {
    await updateSettings({ classificationMode: mode });
    onNext();
  });
  return (
    <StepFrame title="What gets sent to Claude">
      <SegmentedControl
        accessibilityLabel="Photo scanning"
        options={[
          { value: 'cloud_thumbnails', label: 'Automatic' },
          { value: 'manual', label: 'Manual' },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === 'cloud_thumbnails' ? (
        <Card title="Automatic (recommended)">
          <Bullets
            items={[
              'Each run, Diced looks at the photos taken since the last run. Screenshots are skipped on the phone and never sent.',
              'Images saved from WhatsApp, Signal, Telegram, Messenger and similar apps are skipped when their file name or album shows it. Photos saved from iMessage (or apps that don’t save into an album of their own) look like camera photos and may be sent as small thumbnails.',
              'The rest are shrunk to small thumbnails and re-encoded, which strips EXIF metadata such as location, and sent to Claude to find scale and food photos.',
              'Only the scale and food photos are then sent at full size (also EXIF-stripped) to read the scale or estimate the meal.',
              'Nothing else is sent — no other photos, contacts or location.',
            ]}
          />
        </Card>
      ) : (
        <Card title="Manual">
          <Bullets
            items={[
              'Nothing is scanned or sent automatically.',
              'You photograph the scale or a meal, or pick photos, in Quick log. Only those photos are sent (EXIF-stripped) to be read.',
            ]}
          />
        </Card>
      )}
      <Muted>Photos go to Anthropic’s API with your own key. Numbers you approve go to your Google Sheet.</Muted>
      <ErrorBanner message={save.error} />
      <Button label={mode === 'cloud_thumbnails' ? 'I agree — use automatic' : 'Use manual mode'} onPress={() => void save.run()} loading={save.pending} />
    </StepFrame>
  );
}

function ScheduleStep({ settings, onNext }: { settings: AppSettings; onNext: () => void }) {
  const [schedule, setSchedule] = useState<Schedule>({ weekday: settings.scheduleWeekday, hour: settings.scheduleHour, minute: settings.scheduleMinute });
  const [daily, setDaily] = useState(settings.processDaily);
  const [reminderWarning, setReminderWarning] = useState<string | null>(null);
  // Manual mode reads no photos on a schedule: no weekly reminder, no Shortcuts automation.
  const manual = settings.classificationMode === 'manual';
  const save = useAction(async () => {
    setReminderWarning(null);
    const next = await updateSettings({
      scheduleWeekday: schedule.weekday,
      scheduleHour: schedule.hour,
      scheduleMinute: schedule.minute,
      processDaily: daily,
    });
    await registerBackgroundTask();
    try {
      await armWeeklyReminder(next);
    } catch (e) {
      // Usually notifications are off; the Shortcut / background job still work. Stay on this step
      // so the warning is actually seen (the next step would unmount it).
      setReminderWarning(e instanceof Error ? e.message : String(e));
      return;
    }
    onNext();
  });
  return (
    <StepFrame title="Weekly run">
      {manual ? (
        <Body>
          Manual mode: nothing is processed on a schedule and there’s no weekly reminder. Log photos or type entries in Quick log
          whenever you like. If you switch to automatic in Settings, you can pick the weekly run there.
        </Body>
      ) : (
        <>
          <Body>
            Pick when to process the week — for example Monday morning, after your weigh-in. The sheet’s weeks run Monday to
            Sunday.
          </Body>
          <Card>
            <ScheduleEditor value={schedule} onChange={setSchedule} />
            <ToggleRow label="Also check for new photos daily" value={daily} onValueChange={setDaily} />
          </Card>
          {Platform.OS === 'ios' ? (
            <Card title="Set up the iPhone automation">
              <ShortcutsHowTo weekday={schedule.weekday} hour={schedule.hour} minute={schedule.minute} />
            </Card>
          ) : (
            <Notice
              tone="info"
              message={`Android runs this in the background — usually within about 12 hours after ${weekdayName(schedule.weekday)} ${formatClock(schedule.hour, schedule.minute)}, or as soon as you open the app — with a notification when there's something to review.`}
            />
          )}
        </>
      )}
      {reminderWarning ? (
        <Notice
          tone="warning"
          title="Weekly reminder not scheduled"
          message={`${reminderWarning}\nTurn on notifications (Settings → Notifications) to get the reminder. You can continue without it.`}
        />
      ) : null}
      <ErrorBanner message={save.error} />
      {reminderWarning ? (
        <>
          <Button label="Continue anyway" onPress={onNext} />
          <Button variant="secondary" label="Try again" onPress={() => void save.run()} loading={save.pending} />
        </>
      ) : (
        <Button label="Continue" onPress={() => void save.run()} loading={save.pending} />
      )}
    </StepFrame>
  );
}

function DoneStep({ settings }: { settings: AppSettings }) {
  const finish = useAction(() => updateSettings({ onboardingComplete: true }));
  return (
    <StepFrame title="You’re set">
      <Bullets
        items={[
          `Logging for ${settings.person ?? '—'}.`,
          ...(settings.classificationMode === 'cloud_thumbnails'
            ? [
                Platform.OS === 'android'
                  ? `Weekly run after ${weekdayName(settings.scheduleWeekday)} ${formatClock(settings.scheduleHour, settings.scheduleMinute)} — usually within about 12 hours, or when you open the app.`
                  : `Weekly run every ${weekdayName(settings.scheduleWeekday)} at ${formatClock(settings.scheduleHour, settings.scheduleMinute)}.`,
                'New photos are checked automatically; the first run looks back 8 days and starts right away.',
              ]
            : ['Manual mode: use Quick log to add photos or type entries.']),
          'Review and approve entries; Sync writes them to the sheet.',
        ]}
      />
      <ErrorBanner message={finish.error} />
      <Button label="Start using Diced" onPress={() => void finish.run()} loading={finish.pending} />
      <View style={styles.spacer} />
    </StepFrame>
  );
}

const styles = StyleSheet.create({
  progress: { ...type.small, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  strong: { fontWeight: '700' },
  spacer: { height: spacing.lg },
});
