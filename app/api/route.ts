import type { VercelRequest, VercelResponse } from "@vercel/node";

// ======================
// Azure Container Registry Setup
// ======================
const azureHost = "linuxgeneva-microsoft.azurecr.io";
const tokenPath = "/oauth2/token";

export const revalidate = 3600; // 1 hour

// Define the image names and their tag regexes.
// (Note: for names that aren't valid JS identifiers, we adjust them.)
const azureImagePatterns: { [image: string]: RegExp } = {
	genevamdsd: /^(\d+\.\d+\.\d+)-(\d{8})-(\d+)$/, // 1.35.1-20250429-1
	genevamdm: /^(\d+\.\d{12}\.\d+)-(\d{8})-(\d+)$/, // 2.202505011038.0-20250502-1
	genevafluentd: /^(\d+\.\d+\.\d+)-(\d{8})-(\d+)$/, // 1.18.0-20250606-1
	genevasecpackinstall: /^master_(\d{8})\.(\d{1,2})$/i,
	// genevafluentd_td-agent: /^mariner_(\d{8})\.(\d{1,2})$/i,
};

// ======================
// Helper utilities (Azure ACR)
// ======================

// Acquire a read‑only metadata token for one repository
async function getAuthToken(image: string): Promise<string> {
	const url = `https://${azureHost}${tokenPath}?service=${azureHost}&scope=repository:${image}:metadata_read`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to get auth token for ${image}`);
	const { access_token } = await response.json();
	return access_token;
}

// Recursively list *all* tags (ACR returns 1000 / page)
async function listImageTags(image: string, last = ""): Promise<string[]> {
	const url = `https://${azureHost}/v2/${image}/tags/list?n=1000&last=${last}`;
	const token = await getAuthToken(image);
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) throw new Error(`Error fetching tags for ${image}`);
	const data = await res.json();
	const tags: string[] = data.tags ?? [];
	if (tags.length === 0) return [];
	const more = await listImageTags(image, tags[tags.length - 1]);
	return tags.concat(more);
}

// Compare semantic-ish version arrays
function isVersionGreater(a: number[], b: number[]): boolean {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av !== bv) return av > bv;
	}
	return false;
}

// Determine latest tag (highest numeric capture groups)
async function getLatestAzureImageTag(image: string, pattern: RegExp): Promise<string> {
	const tags = await listImageTags(image);
	let latest: { tag: string; parts: number[] } | null = null;
	for (const tag of tags) {
		const m = tag.match(pattern);
		if (!m) continue;
		const parts = m.slice(1).map(n => Number.parseInt(n, 10));
		if (!latest || isVersionGreater(parts, latest.parts)) {
			latest = { tag, parts };
		}
	}
	if (!latest) throw new Error(`No tag matched pattern for ${image}`);
	return latest.tag;
}

// Query every Azure image
async function processAzureImages() {
	const result: Record<string, string> = {};
	for (const [img, re] of Object.entries(azureImagePatterns)) {
		try {
			result[img] = await getLatestAzureImageTag(img, re);
		} catch (err: any) {
			result[img] = `Error: ${err.message}`;
		}
	}
	return result;
}

// ======================
// MCR Setup
// ======================

const mcrImagePatterns: { [url: string]: RegExp } = {
	"mcr.microsoft.com/azure-watson/agent/agent_mariner": /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/, // 1.22.14.0
	"mcr.microsoft.com/oss/v2/kubernetes-csi/livenessprobe": /^v(\d+)\.(\d+)\.(\d+)$/,
	"mcr.microsoft.com/oss/v2/kubernetes-csi/csi-node-driver-registrar": /^v(\d+)\.(\d+)\.(\d+)$/,
	"mcr.microsoft.com/oss/v2/azure/secrets-store/provider-azure": /^v(\d+)\.(\d+)\.(\d+)$/,
	"mcr.microsoft.com/oss/v2/kubernetes-csi/secrets-store/driver": /^v(\d+)\.(\d+)\.(\d+)$/,
};

// repo path (no registry) for which a *single‑arch* manifest is expected
const singleArchRepos = new Set<string>(["azure-watson/agent/agent_mariner"]);

function getRepoInfo(url: string): { registry: string; repository: string } {
	if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
	const u = new URL(url);
	let repo = u.pathname;
	if (repo.startsWith("/v2/")) repo = repo.slice(4);
	if (repo.endsWith("/tags/list")) repo = repo.slice(0, -10);
	repo = repo.replace(/^\/+|\/+$/g, "");
	return { registry: u.hostname, repository: repo };
}

async function getTags(reg: string, repo: string): Promise<string[]> {
	const url = `https://${reg}/v2/${repo}/tags/list`;
	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error("tag list fetch failed");
		const data = await res.json();
		return data.tags ?? [];
	} catch (e) {
		console.error(`Failed to list tags for ${repo} on ${reg}:`, e);
		return [];
	}
}

// -------- helpers to read manifests / config timestamps --------

async function legacyGetTagCreatedDate(base: string, repo: string, tag: string): Promise<Date | null> {
	const manRes = await fetch(`${base}/manifests/${tag}`, {
		headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json" },
	});
	if (!manRes.ok) return null;
	const man = await manRes.json();
	const digest = man?.config?.digest;
	if (!digest) return null;
	const cfg = await fetch(`${base}/blobs/${digest}`).then(r => (r.ok ? r.json() : null));
	return cfg?.created ? new Date(cfg.created) : null;
}

async function multiArchGetTagCreatedDate(
	base: string,
	repo: string,
	tag: string,
	platform = { os: "linux", architecture: "amd64" }
): Promise<Date | null> {
	const index = await fetch(`${base}/manifests/${tag}`, {
		headers: {
			Accept: "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json",
		},
	}).then(r => (r.ok ? r.json() : null));
	if (!index) return null;

	// single‑arch shortcut
	if (index.config?.digest) return legacyGetTagCreatedDate(base, repo, tag);

	const entry = (index.manifests ?? []).find(
		(m: any) => m.platform?.os === platform.os && m.platform?.architecture === platform.architecture
	);
	if (!entry) return null;

	const man = await fetch(`${base}/manifests/${entry.digest}`, {
		headers: {
			Accept: "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json",
		},
	}).then(r => (r.ok ? r.json() : null));
	const digest = man?.config?.digest;
	if (!digest) return null;
	const cfg = await fetch(`${base}/blobs/${digest}`).then(r => (r.ok ? r.json() : null));
	return cfg?.created ? new Date(cfg.created) : null;
}

// Smart wrapper
async function getTagCreatedDate(
	registry: string,
	repository: string,
	tag: string,
	platform: { os: string; architecture: string } = { os: "linux", architecture: "amd64" }
): Promise<Date | null> {
	const base = `https://${registry}/v2/${repository}`;
	return singleArchRepos.has(repository)
		? legacyGetTagCreatedDate(base, repository, tag)
		: multiArchGetTagCreatedDate(base, repository, tag, platform);
}

// ----------------- process a single MCR repo -----------------
async function processMcrImage(url: string, pattern: RegExp) {
	const { registry, repository } = getRepoInfo(url);
	const tags = await getTags(registry, repository);
	if (tags.length === 0) return { image: url, releases: [] };

	const typed: { tag: string; parts: number[] }[] = tags
		.map(tag => {
			const m = tag.match(pattern);
			if (!m) return null;
			return { tag, parts: m.slice(1).map(n => Number.parseInt(n, 10)) };
		})
		.filter(Boolean) as { tag: string; parts: number[] }[];

	if (typed.length === 0) return { image: url, releases: [] };

	// newest by version
	typed.sort((a, b) => (isVersionGreater(b.parts, a.parts) ? 1 : -1));
	const latest = typed.slice(0, 5).map(t => t.tag);

	const dated = await Promise.all(
		latest.map(async tag => ({ tag, created: await getTagCreatedDate(registry, repository, tag) }))
	);

	return {
		image: url,
		releases: dated
			.filter(r => r.created)
			.sort((a, b) => (b.created!.getTime() - a.created!.getTime()))
			.map(r => ({ tag: r.tag, created: r.created!.toISOString() })),
	};
}

// Process all MCR images concurrently
async function processMcrImages() {
	return Promise.all(Object.entries(mcrImagePatterns).map(([url, re]) => processMcrImage(url, re)));
}

// ======================
// Main handler (Vercel Edge / Next.js RSC compatible)
// ======================

export async function GET(request: Request) {
	try {
		const [azureImages, mcrImages] = await Promise.all([processAzureImages(), processMcrImages()]);
		return Response.json({ azureImages, mcrImages });
	} catch (err) {
		console.error(err);
		return Response.json([]);
	}
}
