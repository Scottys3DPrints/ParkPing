/**
 * Injects a release signing config into the generated Android project.
 *
 * `expo prebuild` regenerates android/ from scratch every build, and its
 * template signs release builds with the *debug* key. On a CI runner that key
 * is generated fresh each time, so two builds are signed by different
 * identities and Android refuses to install one over the other — the update
 * path silently dies at the second release.
 *
 * This plugin adds a real `release` signing config whose values Gradle reads
 * from the environment at build time, so the keystore password never lands in
 * a generated file. With no keystore configured it changes nothing, and the
 * Expo default (debug signing) still produces an installable APK.
 */
const { withAppBuildGradle } = require('@expo/config-plugins');

const SIGNING_CONFIG = `
        release {
            // Populated from the environment by .github/workflows/build-apk.yml.
            // Absent locally, where the debug key below is the right default.
            if (System.getenv("PARKPING_KEYSTORE")) {
                storeFile file(System.getenv("PARKPING_KEYSTORE"))
                storePassword System.getenv("PARKPING_KEYSTORE_PASSWORD")
                keyAlias System.getenv("PARKPING_KEY_ALIAS")
                keyPassword System.getenv("PARKPING_KEY_PASSWORD")
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    let contents = gradleConfig.modResults.contents;

    if (contents.includes('PARKPING_KEYSTORE')) return gradleConfig;

    // Add the signingConfigs.release block alongside the template's debug one.
    contents = contents.replace(
      /(signingConfigs\s*\{)/,
      `$1${SIGNING_CONFIG}`,
    );

    /*
     * Point the release build type at it, but only when a keystore is actually
     * present. Selecting an empty signing config would fail the build on a
     * machine that has no keystore, which is every developer's laptop.
     */
    contents = contents.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig System.getenv("PARKPING_KEYSTORE") ? signingConfigs.release : signingConfigs.debug',
    );

    gradleConfig.modResults.contents = contents;
    return gradleConfig;
  });
};
