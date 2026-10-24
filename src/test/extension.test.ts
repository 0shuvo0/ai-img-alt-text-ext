import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findImageTags, getUnfilledImageTags } from '../imageTags.js';
import { resolveWorkspaceImagePath } from '../ollama.js';

suite('Image tag parsing', () => {
	test('reads multiline and inline tags with other attributes', () => {
		const document = [
			'<img src="/imgs/cookie.png" alt="" />',
			'<img class="test" src="https://example.com/photo.png" alt="A photo">',
			'<img',
			'  src="../images/cake.png"',
			'  loading="lazy"',
			'  alt=\'\' />',
		].join('\n');

		const tags = findImageTags(document);
		assert.strictEqual(tags.length, 3);
		assert.deepStrictEqual(tags.map((tag) => tag.source), [
			'/imgs/cookie.png',
			'https://example.com/photo.png',
			'../images/cake.png',
		]);
		assert.deepStrictEqual(tags.map((tag) => tag.alt), ['', 'A photo', '']);
		assert.strictEqual(document.slice(tags[2].altStart!, tags[2].altEnd!), '');
	});

	suite('Workspace image paths', () => {
		test('falls back to public for a missing root-relative image', async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-img-alt-text-'));
			try {
				const publicImagePath = path.join(root, 'public', 'imgs', 'dog.png');
				await fs.mkdir(path.dirname(publicImagePath), { recursive: true });
				await fs.writeFile(publicImagePath, 'image');

				const resolvedPath = await resolveWorkspaceImagePath(
					'/imgs/dog.png',
					vscode.Uri.file(path.join(root, 'index.html')),
				);

				assert.strictEqual(resolvedPath, await fs.realpath(publicImagePath));
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});

		test('prefers the direct workspace path when both files exist', async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-img-alt-text-'));
			try {
				const directImagePath = path.join(root, 'imgs', 'dog.png');
				const publicImagePath = path.join(root, 'public', 'imgs', 'dog.png');
				await fs.mkdir(path.dirname(directImagePath), { recursive: true });
				await fs.mkdir(path.dirname(publicImagePath), { recursive: true });
				await fs.writeFile(directImagePath, 'direct');
				await fs.writeFile(publicImagePath, 'public');

				const resolvedPath = await resolveWorkspaceImagePath(
					'/imgs/dog.png',
					vscode.Uri.file(path.join(root, 'index.html')),
				);

				assert.strictEqual(resolvedPath, await fs.realpath(directImagePath));
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	});

	test('selects only tags with missing or empty alt text', () => {
		const tags = getUnfilledImageTags([
			'<img src="one.png">',
			'<img src="two.png" alt="">',
			'<img src="three.png" alt="A useful description">',
			'<img src={dynamicSource} alt="">',
		].join('\n'));

		assert.strictEqual(tags.length, 3);
		assert.deepStrictEqual(tags.map((tag) => tag.source), ['one.png', 'two.png', null]);
	});

	test('does not match image-like text in attributes or unrelated tags', () => {
		const tags = findImageTags('<div title="<img src=\'fake.png\'>"></div><picture></picture>');
		assert.strictEqual(tags.length, 0);
		const imageWithQuotedAssignment = findImageTags('<img title="src=\'fake.png\'" alt="">');
		assert.strictEqual(imageWithQuotedAssignment[0].source, null);
	});
});
