This is the KKChat Android / iOS app (Expo + React Native, TypeScript). It talks to the KKChat backend in the repository root; it never imports Prisma, Next.js server modules or server secrets.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. Before writing code that touches an Expo or React Native API:

1. Read the major version of the `expo` package in `package.json` (currently SDK 58).
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/` (append `.md` for markdown).
3. For anything else, start from https://docs.expo.dev/llms.txt.

## Commands

```bash
npx expo install <package>   # always use instead of npm install for Expo/RN packages
npm run typecheck            # tsc --noEmit
npm test                     # node --test: fold layout, link parsing, signing plugin
npm run prebuild             # regenerate android/ and ios/ (Continuous Native Generation)
KKCHAT_VERSION_CODE=<n> npm run build:android:release   # signed APK + AAB in release/
```

## Project decisions

- **Native folders are generated.** `android/` and `ios/` are produced by `npx expo prebuild` and are git-ignored. Native behavior lives in `app.config.ts`, `plugins/` and the local module `modules/kkchat-native`. Do not hand-edit generated folders.
- **One root navigator, not Expo Router.** `src/nav.tsx` keeps every screen in one tree so Surface Duo span/unspan, rotation and window resizes never remount the chat: the open conversation, scroll position, unsent draft and upload progress survive. `src/App.tsx` keeps both panes mounted in single-pane mode and only hides one.
- **Layout follows real window features.** `modules/kkchat-native` reports Jetpack WindowManager `FoldingFeature` data (bounds, orientation, `isSeparating`, occlusion, state). `src/layout-core.ts` is the pure layout rule with unit tests; never branch on device model strings.
- **Auth.** System browser / `ASWebAuthenticationSession` + PKCE S256 against Account Center through the KKChat one-time exchange (`/api/native/v1/auth/*`). Only KKChat device tokens are stored, in SecureStore, per account. Refresh is single-flight and reuses a persisted `requestId` so retries never look like replay.
- **Per-account isolation.** Drafts, outbox, sync cursor and caches live under `Paths.document/kkchat/<sub>/`. Switching accounts bumps a generation counter, aborts in-flight requests and closes the realtime stream.
- **Release signing.** `plugins/with-release-signing.js` signs release builds only from `KKCHAT_UPLOAD_*` env vars and fails the build if any is missing. Never commit keystores, passwords or built APKs.
- **Shared code.** `../../shared` (types, API client, merge rules, zh/en strings) is shared with the web app through `metro.config.js`.
