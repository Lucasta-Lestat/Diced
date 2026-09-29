// Diced only uses local notifications (the weekly reminder and "ready to review"), never remote
// push. expo-notifications' config plugin always adds the iOS `aps-environment` (Push
// Notifications) entitlement, which a free Apple ID (Personal Team) can't sign, so a local
// Xcode build (`npx expo run:ios --device`) would fail. This removes the entitlement.
//
// Keep it FIRST in app.json "plugins": entitlement mods run in reverse order of registration, so
// listed later it would run before expo-notifications' mod and the key would be added back.
// Check with: npx expo config --type introspect  (ios.entitlements should be {}).
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment'];
    return c;
  });
};
