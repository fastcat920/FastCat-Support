import test from 'node:test';
import assert from 'node:assert/strict';
import { localizedError } from '../public/error-message.js';
test('visitor errors use current language and hide raw transport details', () => {
 assert.match(localizedError('Failed to fetch', 'en-US'), /Connection failed/);
 assert.match(localizedError('Failed to fetch', 'zh-CN'), /网络/);
 assert.equal(localizedError('服务器内部错误', 'en'), 'Operation failed. Please try again.');
 assert.match(localizedError('413', 'en'), /8 MB/);
});
