// Run after `npx cap add android` / `npx cap add ios`. Lets the app talk to Ollama on the user's own
// network (plain HTTP to a LAN address) while still forbidding cleartext traffic to the internet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const android = 'android/app/src/main';
if (existsSync(`${android}/AndroidManifest.xml`)) {
  mkdirSync(`${android}/res/xml`, { recursive: true });
  writeFileSync(
    `${android}/res/xml/network_security_config.xml`,
    `<?xml version="1.0" encoding="utf-8"?>
<!-- Cleartext HTTP is only needed for Ollama on the local network. Android cannot whitelist IP ranges,
     so cleartext is permitted, but the app itself only ever connects to private/loopback addresses
     unless the user explicitly opts in (see hostAllowed in packages/core/src/network.ts). -->
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`,
  );
  let manifest = readFileSync(`${android}/AndroidManifest.xml`, 'utf8');
  if (!manifest.includes('networkSecurityConfig')) {
    manifest = manifest.replace('<application', '<application android:networkSecurityConfig="@xml/network_security_config"');
    writeFileSync(`${android}/AndroidManifest.xml`, manifest);
  }
  console.log('Patched Android network security config.');
}

const plist = 'ios/App/App/Info.plist';
if (existsSync(plist)) {
  let xml = readFileSync(plist, 'utf8');
  if (!xml.includes('NSAllowsLocalNetworking')) {
    xml = xml.replace(
      /<\/dict>\s*<\/plist>\s*$/,
      `	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>NSLocalNetworkUsageDescription</key>
	<string>Private Analyst connects to the Ollama AI model running on your own computer. Your files stay on this device.</string>
</dict>
</plist>
`,
    );
    writeFileSync(plist, xml);
  }
  console.log('Patched iOS Info.plist (local networking only).');
}
