import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const maximumImageSize = 10 * 1024 * 1024;

export interface OllamaSettings {
	url: string;
	model: string;
}

export async function generateAltText(
	source: string,
	documentUri: vscode.Uri,
	settings: OllamaSettings,
	token: vscode.CancellationToken,
): Promise<string> {
	const image = await loadImage(source, documentUri, token);
	const endpoint = `${settings.url.replace(/\/+$/, '')}/api/generate`;
	const response = await fetchWithTimeout(
		endpoint,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: settings.model,
				prompt: 'Write concise, accurate, accessibility-focused alt text for this image. Describe the visible subject and relevant context in one sentence. Return only the alt text, with no quotation marks or explanation.',
				images: [image.toString('base64')],
				stream: false,
			}),
		},
		120_000,
		token,
		'Ollama request',
	);

	let result: unknown;
	try {
		result = await response.json();
	} catch {
		throw new Error('Ollama returned an invalid response. Check that the server URL is correct.');
	}

	if (!response.ok) {
		const message = isRecord(result) && typeof result.error === 'string'
			? result.error
			: `HTTP ${response.status} ${response.statusText}`.trim();
		throw new Error(`Ollama request failed: ${message}`);
	}

	if (!isRecord(result) || typeof result.response !== 'string') {
		throw new Error('Ollama response did not contain generated alt text.');
	}

	const altText = result.response.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ');
	if (!altText) {
		throw new Error('Ollama returned empty alt text. Try again or choose a different vision model.');
	}
	return altText;
}

async function loadImage(
	source: string,
	documentUri: vscode.Uri,
	token: vscode.CancellationToken,
): Promise<Buffer> {
	if (source.startsWith('//')) {
		return downloadRemoteImage(`https:${source}`, token);
	}
	if (/^https?:\/\//i.test(source)) {
		return downloadRemoteImage(source, token);
	}

	return readWorkspaceImage(source, documentUri);
}

async function downloadRemoteImage(source: string, token: vscode.CancellationToken): Promise<Buffer> {
	let url: URL;
	try {
		url = new URL(source);
	} catch {
		throw new Error(`Invalid image URL: ${source}`);
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('Image URLs must use HTTP or HTTPS and must not contain credentials.');
	}

	const response = await fetchWithTimeout(
		url.toString(),
		{ redirect: 'follow' },
		20_000,
		token,
		'Image download',
	);
	if (!response.ok) {
		throw new Error(`Could not download image (${response.status} ${response.statusText}).`);
	}
	const finalUrl = new URL(response.url || url.toString());
	if (!['http:', 'https:'].includes(finalUrl.protocol)) {
		throw new Error('Image URL redirected to an unsupported protocol.');
	}
	const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (!contentType?.startsWith('image/')) {
		throw new Error(`The URL did not return an image${contentType ? ` (received ${contentType})` : ''}.`);
	}

	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maximumImageSize) {
		throw new Error('Image is larger than the 10 MB limit.');
	}
	if (!response.body) {
		throw new Error('The image response was empty.');
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let totalSize = 0;
	try {
		while (true) {
			if (token.isCancellationRequested) {
				await reader.cancel();
				throw new Error('Image download cancelled.');
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalSize += value.byteLength;
			if (totalSize > maximumImageSize) {
				await reader.cancel();
				throw new Error('Image is larger than the 10 MB limit.');
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	if (totalSize === 0) {
		throw new Error('The image response was empty.');
	}
	return Buffer.concat(chunks);
}

async function readWorkspaceImage(source: string, documentUri: vscode.Uri): Promise<Buffer> {
	const realImagePath = await resolveWorkspaceImagePath(source, documentUri);

	let stats: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stats = await fs.stat(realImagePath);
	} catch (error) {
		throw new Error(`Could not inspect image file "${source}": ${errorMessage(error)}`);
	}
	if (!stats.isFile()) {
		throw new Error(`Image path is not a file: ${source}`);
	}
	if (stats.size > maximumImageSize) {
		throw new Error('Image is larger than the 10 MB limit.');
	}

	try {
		return await fs.readFile(realImagePath);
	} catch (error) {
		throw new Error(`Could not read image file "${source}": ${errorMessage(error)}`);
	}
}

export async function resolveWorkspaceImagePath(source: string, documentUri: vscode.Uri): Promise<string> {
	if (documentUri.scheme !== 'file') {
		throw new Error('Local image paths require a saved file in the workspace.');
	}

	const folder = vscode.workspace.getWorkspaceFolder(documentUri);
	const documentPath = documentUri.fsPath;
	const rootPath = folder?.uri.fsPath ?? path.dirname(documentPath);
	const rootRealPath = await fs.realpath(rootPath);
	let decodedSource: string;
	try {
		decodedSource = decodeURIComponent(source.split(/[?#]/, 1)[0]);
	} catch {
		throw new Error(`Image path contains invalid URL encoding: ${source}`);
	}

	const imagePaths = decodedSource.startsWith('/')
		? [
			path.resolve(rootPath, `.${decodedSource}`),
			path.resolve(rootPath, 'public', `.${decodedSource}`),
		]
		: [path.resolve(path.dirname(documentPath), decodedSource)];

	let realImagePath: string | undefined;
	for (const imagePath of imagePaths) {
		try {
			realImagePath = await fs.realpath(imagePath);
			break;
		} catch (error) {
			if (!isNodeErrorWithCode(error, 'ENOENT') && !isNodeErrorWithCode(error, 'ENOTDIR')) {
				throw new Error(`Could not access image file "${source}": ${errorMessage(error)}`);
			}
		}
	}
	if (!realImagePath) {
		throw new Error(`Image file was not found: ${source} (also checked public${decodedSource}).`);
	}
	const relativePath = path.relative(rootRealPath, realImagePath);
	if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
		throw new Error('Local image paths must stay inside the workspace.');
	}

	return realImagePath;
}

async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs: number,
	token: vscode.CancellationToken,
	requestName: string,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([timeout, controller.signal]);
	const cancellation = token.onCancellationRequested(() => controller.abort());
	try {
		return await fetch(url, { ...options, signal });
	} catch (error) {
		if (token.isCancellationRequested) {
			throw new Error(`${requestName} cancelled.`);
		}
		if (timeout.aborted) {
			throw new Error(`${requestName} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
		}
		throw new Error(`${requestName} failed: ${errorMessage(error)}`);
	} finally {
		cancellation.dispose();
	}
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
