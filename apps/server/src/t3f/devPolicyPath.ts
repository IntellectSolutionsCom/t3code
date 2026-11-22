declare const __T3CODE_BUILD_RELEASE_REPOSITORY__: string | undefined;

const buildReleaseRepository =
  typeof __T3CODE_BUILD_RELEASE_REPOSITORY__ === "string"
    ? __T3CODE_BUILD_RELEASE_REPOSITORY__
    : "";

/**
 * Whether this is a source build, which may read `T3CODE_DEV_MANAGED_POLICY_PATH`. A fork's
 * release builds keep the `dev` channel, so naming a release repository is what marks them.
 */
export const isSourceBuild = (releaseRepository: string = buildReleaseRepository): boolean =>
  releaseRepository === "";
