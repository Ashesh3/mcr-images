import type { VercelRequest, VercelResponse } from "@vercel/node";

// ======================
// Azure Container Registry Setup
// ======================
const azureHost = "linuxgeneva-microsoft.azurecr.io";
const tokenPath = "/oauth2/token";

export const revalidate = 3600; // 1 hour

// Define the image names and their tag regexes.
// (Note: for names that aren’t valid JS identifiers, we adjust them.)
const azureImagePatterns: { [image: string]: RegExp } = {
  genevamdsd: /^mariner_(\d{8})\.(\d{1,2})$/i, // e.g. mariner_20230101.1
  genevamdm: /^(\d{1,2})\.(\d{4})\.(\d{1,4})\.(\d{1,4})-.*$/i, // e.g. 2.2023.210.1249-c1f0d4-20230210t1402
  "genevafluentd_td-agent": /^mariner_(\d{8})\.(\d{1,2})$/i,
  genevafluentd: /^mariner_(\d{8})\.(\d{1,2})$/i,
  genevasecpackinstall: /^master_(\d{8})\.(\d{1,2})$/i,
};

// Get an authentication token for a given image.
async function getAuthToken(image: string): Promise<string> {
  const url = `https://${azureHost}${tokenPath}?service=${azureHost}&scope=repository:${image}:metadata_read`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to get auth token for ${image}`);
  }
  const data = await response.json();
  return data.access_token;
}

// Recursively list all tags for an image.
// (The API returns 1000 tags at a time; we keep paging until no more tags.)
async function listImageTags(
  image: string,
  last: string = ""
): Promise<string[]> {
  const url = `https://${azureHost}/v2/${image}/tags/list?n=1000&last=${last}`;
  const token = await getAuthToken(image);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Error fetching tags for ${image}`);
  }
  const data = await response.json();
  const tags: string[] = data.tags || [];
  if (tags.length > 0) {
    // Recursively fetch next batch using the last tag as marker.
    const moreTags = await listImageTags(image, tags[tags.length - 1]);
    return tags.concat(moreTags);
  }
  return tags;
}

// Compare two version arrays (each is an array of numbers).
function isVersionGreater(v1: number[], v2: number[]): boolean {
  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const num1 = v1[i] || 0;
    const num2 = v2[i] || 0;
    if (num1 > num2) return true;
    if (num1 < num2) return false;
  }
  return false;
}

// For one image, go through its tags, match with the regex,
// and return the tag with the highest “version.”
async function getLatestAzureImageTag(
  image: string,
  pattern: RegExp
): Promise<string> {
  const tags = await listImageTags(image);
  let latestTag: string | null = null;
  let latestVersion: number[] = [];
  for (const tag of tags) {
    const match = tag.match(pattern);
    if (match) {
      // Convert captured groups into numbers.
      const versionParts = match.slice(1).map((num) => parseInt(num, 10));
      if (!latestTag || isVersionGreater(versionParts, latestVersion)) {
        latestTag = tag;
        latestVersion = versionParts;
      }
    }
  }
  if (!latestTag) {
    throw new Error(`Unable to find matched tag for ${image}`);
  }
  return latestTag;
}

// Process all Azure images and return an object mapping image names to their latest tag.
async function processAzureImages() {
  const results: { [image: string]: string } = {};
  for (const [image, pattern] of Object.entries(azureImagePatterns)) {
    try {
      const latestTag = await getLatestAzureImageTag(image, pattern);
      results[image] = latestTag;
    } catch (error: any) {
      results[image] = `Error: ${error.message}`;
    }
  }
  return results;
}

// ======================
// MCR Images Setup
// ======================

const IMAGE_URLS = [
  "mcr.microsoft.com/azure-watson/agent/agent_mariner",
  "mcr.microsoft.com/oss/kubernetes-csi/livenessprobe",
  "mcr.microsoft.com/oss/kubernetes-csi/csi-node-driver-registrar",
  "mcr.microsoft.com/oss/azure/secrets-store/provider-azure",
  "mcr.microsoft.com/oss/kubernetes-csi/secrets-store/driver",
];

// Parse a repository URL into a registry and repository name.
function getRepoInfo(url: string): { registry: string; repository: string } {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  const parsed = new URL(url);
  const registry = parsed.hostname;
  let repository = parsed.pathname;
  if (repository.startsWith("/v2/")) {
    repository = repository.slice(4);
  }
  if (repository.endsWith("/tags/list")) {
    repository = repository.slice(0, -10);
  }
  repository = repository.replace(/^\/+|\/+$/g, "");
  return { registry, repository };
}

// Fetch the list of tags from the registry.
async function getTags(
  registry: string,
  repository: string
): Promise<string[]> {
  const tagsUrl = `https://${registry}/v2/${repository}/tags/list`;
  try {
    const response = await fetch(tagsUrl);
    if (!response.ok) throw new Error("Failed to fetch tags");
    const data = await response.json();
    const tags: string[] = data.tags || [];
    const versionRegex = /\b(?:v)?(\d+(?:\.\d+)+)(?=-|\b)/g;

    function getVersion(tag: string): string | null {
      const match = tag.match(versionRegex);
      return match ? match[0] : null;
    }

    function compareVersions(a: string, b: string): number {
      const aParts = a.split(".").map(Number);
      const bParts = b.split(".").map(Number);

      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0;
        const bVal = bParts[i] || 0;
        if (aVal > bVal) return 1;
        if (aVal < bVal) return -1;
      }
      return 0;
    }

    const sortedTags = tags
      .map((tag) => ({ tag, version: getVersion(tag) }))
      .filter((item) => item.version !== null)
      .sort((a, b) => compareVersions(a.version!, b.version!))
      .map((item) => item.tag);

    // Return the last 5 tags
    return sortedTags.slice(-5);
  } catch (e) {
    console.error(`Error fetching tags for ${repository} on ${registry}:`, e);
    return [];
  }
}

// For a given tag, fetch its manifest and config blob to get the creation date.
async function getTagCreatedDate(
  registry: string,
  repository: string,
  tag: string
): Promise<Date | null> {
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${tag}`;
  try {
    const manifestRes = await fetch(manifestUrl, {
      headers: {
        Accept: "application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (!manifestRes.ok) throw new Error("Failed to fetch manifest");
    const manifest = await manifestRes.json();
    const digest = manifest.config?.digest;
    if (!digest) {
      console.error(
        `Manifest for ${repository}:${tag} does not contain a config digest.`
      );
      return null;
    }
    const configUrl = `https://${registry}/v2/${repository}/blobs/${digest}`;
    const configRes = await fetch(configUrl);
    if (!configRes.ok) throw new Error("Failed to fetch config blob");
    const config = await configRes.json();
    let createdStr = config.created;
    if (!createdStr) {
      console.error(
        `Config for ${repository}:${tag} does not have a 'created' field.`
      );
      return null;
    }
    // Adjust for ISO formatting if needed.
    if (createdStr.endsWith("Z")) {
      createdStr = createdStr.replace("Z", "+00:00");
    }
    return new Date(createdStr);
  } catch (e) {
    console.error(`Error fetching creation date for ${repository}:${tag}:`, e);
    return null;
  }
}

// Process one MCR image by retrieving its tags and then getting each tag's creation date.
async function processMcrImage(url: string) {
  const { registry, repository } = getRepoInfo(url);
  const tags = await getTags(registry, repository);
  if (tags.length === 0) {
    return { image: url, releases: [] };
  }
  const tagDates = await Promise.all(
    tags.map(async (tag) => {
      const created = await getTagCreatedDate(registry, repository, tag);
      return { tag, created };
    })
  );
  // Filter out tags that couldn’t provide a creation date.
  const validDates = tagDates.filter((item) => item.created !== null) as {
    tag: string;
    created: Date;
  }[];
  // Sort by date (newest first)
  validDates.sort((a, b) => b.created.getTime() - a.created.getTime());
  const latestReleases = validDates.slice(0, 5).map((item) => ({
    tag: item.tag,
    created: item.created.toISOString(),
  }));
  return { image: url, releases: latestReleases };
}

async function processMcrImages() {
  const results = await Promise.all(
    IMAGE_URLS.map((url) => processMcrImage(url))
  );
  return results;
}

// ======================
// Main Handler
// ======================

export async function GET(request: Request) {
  try {
    // Run both the Azure and MCR image queries concurrently.
    const [azureResults, mcrResults] = await Promise.all([
      processAzureImages(),
      processMcrImages(),
    ]);
    return Response.json({ azureImages: azureResults, mcrImages: mcrResults });
  } catch (error: any) {
    return Response.json([]);
  }
}
