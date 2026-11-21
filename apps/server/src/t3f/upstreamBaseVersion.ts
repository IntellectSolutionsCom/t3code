export function upstreamBaseVersion(version: string): string {
  const match = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return version;

  const [, majorMinor, patch] = match;
  const patchNumber = Number(patch);
  if (patchNumber < 10_000) return version;

  // Fork release patches encode 10000 + 100 × upstream patch + release number.
  return `${majorMinor}.${Math.floor((patchNumber - 10_000) / 100)}`;
}
