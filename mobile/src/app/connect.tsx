import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { getSettings } from '../config/settings';
import { Button, Card, HomeFallbackHeader, Muted, Notice, Row, Screen, SheetConnectForm } from '../ui/components';
import { describeSheetUrl, firstParam, isAppsScriptUrl } from '../ui/forms';
import { useSettings } from '../ui/hooks';

/** Target of `diced://connect?url=…&token=…` (and Settings → Change sheet). */
export default function Connect() {
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string | string[]; token?: string | string[] }>();
  const url = firstParam(params.url).trim();
  const token = firstParam(params.token).trim();
  const settings = useSettings();
  const fromLink = Boolean(url && token);
  const current = settings?.sheetWebAppUrl?.trim() || null;
  // A link that would repoint this phone's entries elsewhere needs an explicit, informed yes first:
  // nothing is contacted until then.
  const replacing = fromLink && current !== null && current !== url;
  // Keyed by the link's URL: a second link opened onto this same screen asks again.
  const [confirmedUrl, setConfirmedUrl] = useState<string | null>(null);
  const needsConfirm = replacing && confirmedUrl !== url;

  const done = async () => {
    const onboarded = (await getSettings()).onboardingComplete;
    if (router.canGoBack()) router.back();
    else router.replace(onboarded ? '/' : '/onboarding');
  };
  const finish = () => {
    done().catch(() => router.replace('/'));
  };

  return (
    <Screen>
      <HomeFallbackHeader />
      {fromLink ? (
        <Notice tone="info" message="These details came from your connect link. Test them, choose who uses this phone, then save." />
      ) : (
        <Muted>
          Open the sheet on a computer and choose Diced → Show app connection info. Open the diced://connect link on this phone,
          or copy the URL and token here.
        </Muted>
      )}
      {needsConfirm && current ? (
        <Card title="Replace the sheet connection?">
          <Row label="Now sending to" detail={describeSheetUrl(current)} />
          <Row label="This link sends to" detail={describeSheetUrl(url)} />
          {!isAppsScriptUrl(url) ? (
            <Notice
              tone="danger"
              title="Not a Google Apps Script address"
              message="Links from your own sheet always point to script.google.com. Diced won’t send your token, weigh-ins or meals to this address — keep the current sheet."
            />
          ) : null}
          <Muted>
            After saving, approved weigh-ins and meals from this phone go to the new address. Only continue if you created this
            link from your own sheet (e.g. after a new deployment of the Diced script, which changes its URL).
          </Muted>
          <Button label="Use this new sheet" variant="secondary" onPress={() => setConfirmedUrl(url)} />
          <Button label="Keep the current sheet" onPress={finish} />
        </Card>
      ) : settings ? (
        <Card>
          <SheetConnectForm
            // A new link opened onto this screen starts a fresh form with its values.
            key={`${url}\n${token}`}
            initialUrl={url || settings.sheetWebAppUrl || ''}
            initialToken={token}
            choosePerson
            autoTest={fromLink}
            preselectPerson={!replacing}
            onSaved={finish}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
