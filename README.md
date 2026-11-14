# Njk public distribution

- [RemotePC PWA](https://taducanh1605.github.io/remotepc/)
- [Njk Host installers and corresponding source](https://github.com/taducanh1605/remotepc/releases): `v...` tags
- Android APKs and corresponding source: `android-v...` tags
- Complete ESP32 Wake Windows PC setup bundle: `helper-v...` tags
- Browser preferred-form source and build instructions: `pwa-v...` tags

## Android downloads

The current Android release is [Njk Stream 20.2.16](https://github.com/taducanh1605/remotepc/releases/tag/android-v20.2.16).
Choose the APK matching your installed package and device architecture as described on that release page.

`site/` contains only built browser assets, distribution checksums and licensing/source information. GitHub Pages deploys **only** that directory. There are no development tests, credentials, build tool dependencies or source maps in the deployed artifact.

Readable development source and tests are maintained in a separate private repository. Corresponding source required by applicable licenses is provided with releases; browser obfuscation is not encryption and does not remove source-distribution obligations.

Host, Android, helper and browser releases are selected by product tag, not the global **Latest** label. Published release assets remain available. Historical raw source commits are retained; removing files from the current branch does not erase Git history.
