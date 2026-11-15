# Share installable previews

Use the `preview` profile for teammates trying Cart on their own phones. It bundles JavaScript into the app, so no Metro server, Expo Go, or developer tools are needed by testers. The `development` profile includes the development client and normally connects to Metro; `production` creates store builds, including iOS builds for TestFlight.

## One-time Expo setup

1. Create an [Expo account](https://expo.dev/signup), optionally create an organization, and choose which account owns Cart.
2. Create a personal access token under [Expo account settings → Access tokens](https://expo.dev/settings/access-tokens). Provide it to the build environment as `EXPO_TOKEN`, never in source control or chat. In Capy, use the project's Environment variables page so future build machines receive it; use the composer's environment variables dialog if an already-running thread also needs the token immediately.
3. Run `npx eas-cli@latest init --account <expo-owner> --non-interactive` authenticated as that account, replacing `<expo-owner>` with the chosen user or organization name. Alternatively, run `npx eas-cli@latest init` interactively to select an existing project. Commit `expo.owner` and the resulting `expo.extra.eas.projectId` in `app.json`; these identifiers are public, not credentials. Do not invent a project ID.

Cart uses `com.mobilecart.app` for both platform identifiers. If that iOS identifier belongs to a different Apple team, choose one owned by the signing team before the first build.

Before the first preview build or update, create the public backend variables in the Expo project (these are not credentials):

```sh
npx eas-cli@latest env:set --name EXPO_PUBLIC_CONVEX_URL --value https://hearty-skunk-641.convex.cloud --environment preview --visibility plaintext --non-interactive
npx eas-cli@latest env:set --name EXPO_PUBLIC_CONVEX_SITE_URL --value https://hearty-skunk-641.convex.site --environment preview --visibility plaintext --non-interactive
```

Repeat for `development` and `production` before using those profiles. Each profile explicitly selects its matching Expo environment. `EXPO_TOKEN` on Capy's machine authenticates the CLI; it does not copy other Capy variables into Expo's build environment.

## Android: send an APK link

```sh
npx eas-cli@latest build --platform android --profile preview
```

On the first run, let Expo generate and store the Android signing keystore. When the build finishes, share its build page or APK download link; the build page provides installation instructions and a QR code. Testers open it on Android, allow installation from that browser/download source when prompted, and install Cart. No Play Console account or store review is required. Do not share the keystore.

Internal build links allow anyone with the URL to access the build by default. Disable unauthenticated access in the Expo project's settings if that is not appropriate; testers will then need authorized Expo accounts.

## iPhone: registered devices or TestFlight

Internal distribution requires an active paid Apple Developer Program membership and ad hoc signing credentials. Before the preview build, register every test phone:

```sh
npx eas-cli@latest device:create
npx eas-cli@latest build --platform ios --profile preview
```

Send the device registration URL/QR code first. Testers open it on their iPhones and follow the registration instructions. Have the Apple team owner configure signing through EAS's secure interactive credential flow; never put Apple passwords, certificates, or API keys in this repository. Only UDIDs included in the provisioning profile can install the resulting build. Registering a later phone requires a new build or `eas build:resign`. Ad hoc distribution is limited to 100 iPhones per membership year. Newly registered devices on new or recently renewed memberships can take Apple 24–72 hours to process.

For a larger group without device registration, use a **store** build and TestFlight instead:

```sh
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios --latest
```

This also requires an Apple Developer membership, an App Store Connect app record, and submission credentials. Testers install Apple's TestFlight app. Internal TestFlight testers must belong to the App Store Connect team and receive email invitations. A public shareable TestFlight link is for an external testing group and requires Beta App Review. Uploading a build does not automatically create that public link. Configure the group in App Store Connect after processing/review. TestFlight builds expire after 90 days.

## Backend configuration and updates

The tracked root `.env` contains only `EXPO_PUBLIC_CONVEX_URL` and `EXPO_PUBLIC_CONVEX_SITE_URL`. It is not ignored, and Expo Build's bundling documentation supports uploaded `.env` files. Still configure the Expo environment explicitly as above so builds and updates share one source. All profiles currently target the same live backend. These URLs are public; server credentials such as `CONVEX_DEPLOY_KEY` must never use the `EXPO_PUBLIC_` prefix or go in `eas.json`.

For **SDK 55 and later**, `eas update` requires `--environment` and ignores local `.env` files. Missing remote values would produce Cart's mock/offline fallback. Use plain-text visibility for these public variables; secret visibility is unavailable to local update bundling. If builds later need different backends, change the corresponding Expo environment's values.

`expo-updates` is installed and the release profiles name separate `preview` and `production` channels, but over-the-air updates are not enabled yet. After project initialization, run:

```sh
npx eas-cli@latest update:configure
```

Commit the real `updates.url` and `extra.eas.projectId` generated in `app.json`, set `runtimeVersion` to `{ "policy": "fingerprint" }`, and retain the chosen owner. No placeholder ID or update URL is committed. Configure this **before** the first binary if testers should receive updates without another install.

After installing that binary, publish compatible JavaScript and asset updates with:

```sh
npx eas-cli@latest update --channel preview --environment preview --message 'Cart teammate preview' --non-interactive
```

Share the real dashboard/build links returned by Expo, not guessed URLs. A preview release build receives its channel's updates; arbitrary PR update QRs require a compatible development client. Adding or changing native modules requires a new binary with a matching fingerprint. No GitHub preview workflow is configured.

## Zero-install web preview

The existing `web.output: "server"` already works with Expo Hosting; no additional `eas.json` hosting profile is required. After Expo authentication/project linking, export and deploy:

```sh
npx eas-cli@latest env:exec preview 'EXPO_NO_DOTENV=1 npx expo export --platform web' --non-interactive && npx eas-cli@latest deploy --environment preview
```

The export runs inside the selected Expo environment and disables local dotenv overrides. `deploy --environment preview` alone only supplies server-side values; it cannot replace public URLs already inlined into the browser bundle. Create both preview variables before exporting.

The first deployment asks for a preview subdomain; choose it rather than guessing a URL. Send the actual HTTPS link returned by the CLI. Teammates need only a phone browser and a Cart account. This is not a native-app test: the Amazon WebView integration is unavailable on web. Deploy the whole server export through Expo Hosting, not just `dist/client` to a static file host. Export again before each deployment. No hosting deployment has been created by this configuration change.

## References

- [Internal distribution](https://docs.expo.dev/build/internal-distribution/)
- [Build APKs](https://docs.expo.dev/build-reference/apk/)
- [Build profiles](https://docs.expo.dev/build/eas-json/)
- [Programmatic access](https://docs.expo.dev/accounts/programmatic-access/)
- [Environment variables](https://docs.expo.dev/guides/environment-variables/)
- [Using Expo environments](https://docs.expo.dev/eas/environment-variables/usage/)
- [Creating Expo environment variables](https://docs.expo.dev/eas/environment-variables/manage/)
- [Update configuration](https://docs.expo.dev/eas-update/getting-started/)
- [TestFlight](https://docs.expo.dev/submit/testflight/)
- [iOS submission](https://docs.expo.dev/submit/ios/)
- [Web publishing](https://docs.expo.dev/deploy/web/)
- [Expo Hosting setup](https://docs.expo.dev/eas/hosting/get-started/)
