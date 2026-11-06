/**
 * The Android application's manifest and resources.
 *
 * Backup is off and device-to-device transfer excludes everything: the
 * database holds conversations and the encrypted provider keys, and a key
 * restored onto another device could not be decrypted there anyway - its
 * Keystore key does not travel.
 */

import type { AndroidSettings } from '#core/backends/kotlin.ts';

const STRINGS = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Draken</string>
</resources>`;

const THEMES = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Compose draws everything; the window theme only sets what shows before it does. -->
    <style name="Theme.Draken" parent="android:Theme.Material.Light.NoActionBar">
        <item name="android:windowBackground">@color/draken_window</item>
    </style>
</resources>`;

const COLORS = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="draken_window">#FFF7F7FA</color>
    <color name="ic_launcher_background">#FF1F2433</color>
</resources>`;

const NIGHT_COLORS = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="draken_window">#FF121318</color>
</resources>`;

const DATA_EXTRACTION = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" />
        <exclude domain="file" />
        <exclude domain="database" />
        <exclude domain="sharedpref" />
        <exclude domain="external" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" />
        <exclude domain="file" />
        <exclude domain="database" />
        <exclude domain="sharedpref" />
        <exclude domain="external" />
    </device-transfer>
</data-extraction-rules>`;

// Cleartext only to a server on the phone itself (llama.cpp or Ollama under
// Termux, say). Everything else, including a self-hosted server elsewhere on
// the network, must use TLS.
const NETWORK_SECURITY = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>`;

const LAUNCHER = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>`;

// A stylised "D" inside the 66dp safe zone of the 108dp adaptive canvas.
const FOREGROUND = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFE8EAF2"
        android:pathData="M38,32h16c14.4,0 24,8.8 24,22s-9.6,22 -24,22H38V32zM47,40.5v27h6.6c9,0 15,-5.2 15,-13.5s-6,-13.5 -15,-13.5H47z" />
    <path
        android:fillColor="#FF7C8CFF"
        android:pathData="M30,50h10v8H30z" />
</vector>`;

export function androidSettings(): AndroidSettings {
  return {
    namespace: 'com.draken.app',
    applicationId: 'com.draken',
    minSdk: 29,
    targetSdk: 36,
    compileSdk: 37,
    versionCode: 1,
    versionName: '0.1.0',
    permissions: ['android.permission.INTERNET'],
    application: {
      attributes: {
        name: '.DrakenApplication',
        label: '@string/app_name',
        icon: '@mipmap/ic_launcher',
        roundIcon: '@mipmap/ic_launcher',
        theme: '@style/Theme.Draken',
        allowBackup: 'false',
        dataExtractionRules: '@xml/data_extraction_rules',
        networkSecurityConfig: '@xml/network_security_config',
        supportsRtl: 'true',
      },
      children: [
        {
          tag: 'activity',
          attributes: { name: '.MainActivity', exported: 'true', windowSoftInputMode: 'adjustResize' },
          children: [
            {
              tag: 'intent-filter',
              children: [
                { tag: 'action', attributes: { name: 'android.intent.action.MAIN' } },
                { tag: 'category', attributes: { name: 'android.intent.category.LAUNCHER' } },
              ],
            },
          ],
        },
      ],
    },
    resources: {
      'values/strings.xml': STRINGS,
      'values/themes.xml': THEMES,
      'values/colors.xml': COLORS,
      'values-night/colors.xml': NIGHT_COLORS,
      'xml/data_extraction_rules.xml': DATA_EXTRACTION,
      'xml/network_security_config.xml': NETWORK_SECURITY,
      'mipmap-anydpi-v26/ic_launcher.xml': LAUNCHER,
      'drawable/ic_launcher_foreground.xml': FOREGROUND,
    },
  };
}
