import type { MetadataRoute } from "next";

// /s/[slug] pages are intentionally excluded: slugs are private share links
// (365-day TTL in Upstash Redis), so listing them in the sitemap would defeat
// their unguessable nature and pollute crawlers with ephemeral URLs.

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://doublecheckff.com",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1.0,
    },
  ];
}
