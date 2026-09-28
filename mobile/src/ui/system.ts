/** Small wrappers around platform actions that must never surface as unhandled rejections. */
import { Linking } from 'react-native';
import { logger } from '../lib/log';

const log = logger('system');

/** Opens this app's page in the system Settings (permissions). */
export function openSystemSettings(): void {
  Linking.openSettings().catch((e: unknown) => log.warn('could not open system settings', e));
}
