declare module 'cloudflare:workers' {
	export const cache: {
		purge(options: {
			tags?: string[];
			pathPrefixes?: string[];
			purgeEverything?: boolean;
		}): Promise<{ success: boolean } | void>;
	};
}
