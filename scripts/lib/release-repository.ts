type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The GitHub repository a build's `t3` finds and downloads its releases from, baked into the
 * server and desktop bundles. Empty keeps upstream's. The desktop updater reads the same variables.
 */
export function buildReleaseRepository(env: Environment = process.env): string {
  const name = env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim()
    ? "T3CODE_DESKTOP_UPDATE_REPOSITORY"
    : "GITHUB_REPOSITORY";
  const repository = env[name]?.trim() || "";
  const segments = repository.split("/");
  // Exactly one <owner>/<repo> with no dot segments, so the value cannot change the API path.
  if (
    repository &&
    (segments.length !== 2 ||
      !segments.every(
        (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/u.test(segment),
      ))
  ) {
    throw new Error(`${name} must be <owner>/<repo>, got "${repository}".`);
  }
  return repository;
}
