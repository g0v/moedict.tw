import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from '@cloudflare/vite-plugin'
import { STROKE_JSON_BASE_URL } from './src/utils/media-cdn'

interface LocalStaticMount {
	prefix: string
	root: string
}

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

const localStaticMounts: LocalStaticMount[] = [
	{ prefix: '/assets-legacy/', root: path.resolve(projectRoot, 'data/assets') },
	{ prefix: '/dictionary/', root: path.resolve(projectRoot, 'data/dictionary') },
	{ prefix: '/search-index/', root: path.resolve(projectRoot, 'data/dictionary/search-index') },
]

function contentTypeFor(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case '.css':
			return 'text/css; charset=utf-8'
		case '.js':
			return 'application/javascript; charset=utf-8'
		case '.json':
			return 'application/json; charset=utf-8'
		case '.txt':
			return 'text/plain; charset=utf-8'
		case '.xml':
			return 'application/xml; charset=utf-8'
		case '.svg':
			return 'image/svg+xml'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.gif':
			return 'image/gif'
		case '.ico':
			return 'image/x-icon'
		case '.woff':
			return 'font/woff'
		case '.woff2':
			return 'font/woff2'
		case '.ttf':
			return 'font/ttf'
		case '.otf':
			return 'font/otf'
		case '.eot':
			return 'application/vnd.ms-fontobject'
		case '.wasm':
			return 'application/wasm'
		default:
			return 'application/octet-stream'
	}
}

async function proxyStrokeJson(cp: string, res: import('http').ServerResponse): Promise<void> {
	if (!/^[0-9a-f]{4,6}\.json$/i.test(cp)) {
		res.statusCode = 400;
		res.end('Bad Request');
		return;
	}
	try {
		const upstream = await fetch(`${STROKE_JSON_BASE_URL}/${cp}`);
		if (!upstream.ok) {
			res.statusCode = upstream.status;
			res.end('Not Found');
			return;
		}
		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		res.setHeader('Cache-Control', 'public, max-age=86400')
		res.setHeader('Access-Control-Allow-Origin', '*')
		const text = await upstream.text()
		res.end(text)
	} catch {
		res.statusCode = 502
		res.end('Proxy Error')
	}
}

function localDataAssetsPlugin(): Plugin {
	return {
		name: 'moedict-local-data-assets',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const requestUrl = req.url;
				if (!requestUrl) {
					next();
					return;
				}

				const pathname = new URL(requestUrl, 'http://localhost').pathname;

				// Proxy /api/stroke-json/{cp}.json and /stroke-json/{cp}.json to Rackspace CDN,
				// mirroring the production Worker; otherwise Vite's SPA fallback returns HTML
				// and jQuery fails to parse it as stroke JSON.
				const strokeMatch = pathname.match(/^\/(?:api\/)?stroke-json\/([^/]+)$/)
				if (strokeMatch) {
					void proxyStrokeJson(strokeMatch[1], res);
					return;
				}

				const mount = localStaticMounts.find(({ prefix }) => pathname.startsWith(prefix));
				if (!mount) {
					next();
					return;
				}

				const rawRelativePath = decodeURIComponent(pathname.slice(mount.prefix.length)).replace(/^\/+/, '');
				const normalizedRelativePath = path.posix.normalize(rawRelativePath);
				if (
					normalizedRelativePath.length === 0 ||
					normalizedRelativePath === '.' ||
					normalizedRelativePath.startsWith('..') ||
					normalizedRelativePath.includes('\0')
				) {
					res.statusCode = 403;
					res.end('Forbidden');
					return;
				}

				const resolvedPath = path.resolve(mount.root, normalizedRelativePath);
				const relativeToRoot = path.relative(mount.root, resolvedPath);
				if (
					relativeToRoot.startsWith('..') ||
					path.isAbsolute(relativeToRoot) ||
					!fs.existsSync(resolvedPath) ||
					!fs.statSync(resolvedPath).isFile()
				) {
					res.statusCode = 404;
					res.end('Not Found');
					return;
				}

				res.setHeader('Content-Type', contentTypeFor(resolvedPath));
				res.setHeader('Cache-Control', 'no-store');
				fs.createReadStream(resolvedPath).pipe(res);
			});
		},
	}
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
	const remoteDev = process.env.VITE_CLOUDFLARE_REMOTE_DEV === '1'
	// Emit source maps only when explicitly building for coverage — the
	// coverage merge script (scripts/merge-coverage.mjs) reads them to map
	// bundled Chromium V8 coverage back to src/**/*.ts. Regular `npm run
	// build` deploys ship without maps (smaller payload).
	const needsSourcemaps = process.env.E2E_COVERAGE === '1'

	return {
		build: {
			sourcemap: needsSourcemaps,
		},
		server: {
			proxy: {
				'/lookup/trs': {
					target: 'https://www.moedict.tw',
					changeOrigin: true,
				},
			},
		},
		plugins: [
			react(),
			command === 'serve'
				? remoteDev
					? cloudflare()
					: localDataAssetsPlugin()
				: cloudflare(),
		],
	}
})
