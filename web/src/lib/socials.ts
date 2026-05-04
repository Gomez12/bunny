/**
 * Frontend social-platform vocabulary. Mirrors `SOCIAL_PLATFORMS` in
 * `src/memory/contacts.ts` — the server validator lowercases unknown
 * platforms to "other", so the UI dropdown only needs the well-known set.
 */
export const SOCIAL_PLATFORMS = [
  "twitter",
  "x",
  "linkedin",
  "github",
  "mastodon",
  "instagram",
  "youtube",
  "tiktok",
  "bluesky",
  "facebook",
  "website",
  "other",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
