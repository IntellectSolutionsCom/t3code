/** The visible name of this edition's own Settings section and pointers. Identifiers stay neutral. */
export const EDITION_NAME = "Crew";

// The edition's own identity as an app. Upstream's files read these by import, so a merge
// meets one changed reference instead of our literals. Dev builds derive their values here.
export const EDITION_APP_ID = "com.intellect-solutions.crew";
// Who publishes the app: the Windows company field, the deb maintainer, the AppStream developer.
export const EDITION_PUBLISHER_NAME = "Intellect Solutions";
export const EDITION_PUBLISHER_EMAIL = "info@intellect-solutions.com";
export const EDITION_APP_BASE_NAME = "T3 Crew";
export const EDITION_PACKAGE_NAME = "t3-crew";
// Desktop ids and window classes follow D-Bus naming, which has no hyphen.
export const EDITION_LINUX_DESKTOP_ID = "com.intellect_solutions.Crew";
export const EDITION_ARTIFACT_NAME_STEM = "T3-Crew";
