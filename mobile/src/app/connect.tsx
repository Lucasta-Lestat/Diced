import { useLocalSearchParams, useRouter } from 'expo-router';
import { getSettings } from '../config/settings';
import { Card, HomeFallbackHeader, Muted, Notice, Screen, SheetConnectForm } from '../ui/components';
import { firstParam } from '../ui/forms';
import { useSettings } from '../ui/hooks';

/** Target of `diced://connect?url=…&token=…` (and Settings → Change sheet). */
export default function Connect() {
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string | string[]; token?: string | string[] }>();
  const url = firstParam(params.url).trim();
  const token = firstParam(params.token).trim();
  const settings = useSettings();
  const fromLink = Boolean(url && token);

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
      {settings?.sheetWebAppUrl && fromLink && settings.sheetWebAppUrl.trim() !== url ? (
        <Notice tone="warning" message="This phone is already connected to a different sheet URL. Saving replaces it." />
      ) : null}
      {settings ? (
        <Card>
          <SheetConnectForm
            initialUrl={url || settings.sheetWebAppUrl || ''}
            initialToken={token}
            choosePerson
            autoTest={fromLink}
            onSaved={finish}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
